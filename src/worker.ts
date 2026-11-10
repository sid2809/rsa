import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Db } from './db.ts';
import { log } from './log.ts';
import { googleSheet, parseSettings, parseInput, type SheetPort, type Settings } from './sheet.ts';
import { anthropicBatchClient, submitCopyBatch, collectCopyBatches, type BatchClient } from './copy.ts';
import { googleAdsPort, type AdsPort } from './ads.ts';
import { ensureLabel, preflight, existingCampaigns, uploadCampaign, topUpCampaign, enableWave, sync, QuotaReached } from './upload.ts';
import { writeReports } from './report.ts';
import { WAVES, TICK_SECONDS, SYNC_EVERY_HOURS, SHEET_WRITE_MIN_SECONDS, UPLOAD_MAX_ATTEMPTS, DEFAULT_DAILY_QUOTA_CAP, type Wave } from './config.ts';

const REQUIRED_ENV = [
  'SHEET_ID',
  'GOOGLE_SERVICE_ACCOUNT_JSON',
  'ANTHROPIC_API_KEY',
  'GOOGLE_ADS_DEVELOPER_TOKEN',
  'GOOGLE_ADS_LOGIN_CUSTOMER_ID',
  'GOOGLE_ADS_CLIENT_ID',
  'GOOGLE_ADS_CLIENT_SECRET',
  'GOOGLE_ADS_REFRESH_TOKEN',
];

export interface Deps {
  db: Db;
  sheet: SheetPort;
  batches: BatchClient;
  adsFor(customerId: string): AdsPort;
}

// One pass of the worker. Exported for tests.
export async function tick(deps: Deps): Promise<void> {
  const { db, sheet, batches } = deps;
  const settings = parseSettings(await sheet.read('Settings'));
  if (settings.pause) {
    log('paused (Settings > Pause is TRUE)');
    return;
  }
  const cap = settings.quotaCap || DEFAULT_DAILY_QUOTA_CAP;

  // 1. Import the Input tab once.
  if (db.articleCount() === 0) {
    const { rows, problems } = parseInput(await sheet.read('Input'));
    if (problems.length > 0) {
      db.set('status', `Input not imported: ${problems.join('; ')}`);
      log(`input: ${problems.length} problems, nothing imported: ${problems.slice(0, 5).join('; ')}`);
      return;
    }
    db.importArticles(rows);
    db.set('status', `Input imported: ${rows.length} articles`);
    log(`input: imported ${rows.length} articles`);
  }

  const wavesOn = WAVES.filter((w) => settings.upload[w]);

  // 2. Ad copy (Haiku 5.5, Batch API) for every wave whose Upload box is ticked.
  await collectCopyBatches(db, batches);
  for (const wave of wavesOn) await submitCopyBatch(db, batches, wave);

  // 3. Google Ads: needs the account ID.
  if (!settings.account) {
    if (wavesOn.length > 0) db.set('status', 'Waiting for Settings > Account (Google Ads account ID)');
    return;
  }
  const savedAccount = db.get('account');
  if (savedAccount && savedAccount !== settings.account) {
    db.set('status', `Account changed from ${savedAccount} to ${settings.account}. Not uploading: changing account after uploads started is not supported.`);
    log('account changed in Settings; stopping uploads');
    return;
  }
  const ads = deps.adsFor(settings.account);

  try {
    if (wavesOn.length > 0) await uploadWaves(db, ads, settings, cap, wavesOn);
    await enableWaves(db, ads, settings, cap);
    const lastSync = db.get('last_sync');
    const uploadedAny = db.campaigns().some((c) => c.status === 'uploaded');
    const syncDue = !lastSync || Date.now() - Date.parse(lastSync) > SYNC_EVERY_HOURS * 3600 * 1000 || db.get('sync_requested') === '1';
    if (uploadedAny && syncDue) {
      await sync(db, ads, cap);
      db.set('sync_requested', '0');
    }
  } catch (error) {
    if (error instanceof QuotaReached) {
      db.set('status', `Waiting: ${error.message}`);
      log(error.message);
      return;
    }
    throw error;
  }
}

async function uploadWaves(db: Db, ads: AdsPort, settings: Settings, cap: number, wavesOn: Wave[]): Promise<void> {
  // Preflight once, before the first upload. A failure stops uploads until the worker restarts.
  if (db.get('preflight') !== 'passed') {
    if (db.get('preflight') === 'failed') return;
    const pilotReady = db.campaignsToUpload('pilot', UPLOAD_MAX_ATTEMPTS).length > 0;
    if (!pilotReady) return; // preflight checks a real pilot campaign, so wait for its copy
    try {
      const notes = await preflight(db, ads, settings.account, cap);
      db.set('preflight', 'passed');
      db.set('preflight_notes', notes.join(' · '));
      db.set('account', settings.account);
      log(`preflight passed: ${notes.join(' · ')}`);
    } catch (error) {
      if (error instanceof QuotaReached) throw error;
      db.set('preflight', 'failed');
      db.set('preflight_notes', (error as Error).message);
      db.set('status', `Preflight FAILED: ${(error as Error).message}. Fix it, then restart the worker in Railway.`);
      log(`preflight failed: ${(error as Error).message}`);
      return;
    }
  }

  const label = await ensureLabel(db, ads, cap);
  let existing: Map<string, string> | undefined;
  for (const wave of wavesOn) {
    // The rest waits until every pilot campaign is done (uploaded or failed).
    if (wave === 'rest' && db.campaigns('pilot').some((c) => c.status === 'pending')) continue;
    const todo = db.campaignsToUpload(wave, UPLOAD_MAX_ATTEMPTS);
    if (todo.length === 0) continue;
    existing ??= await existingCampaigns(db, ads, cap);
    for (const campaign of todo) {
      await uploadCampaign(db, ads, settings.account, cap, label, campaign.name, existing);
      db.set('sync_requested', '1');
    }
  }
  // Ads whose copy came after their campaign was uploaded go into the existing campaign.
  for (const wave of wavesOn) {
    for (const campaign of db.campaignsToTopUp(wave)) {
      await topUpCampaign(db, ads, settings.account, cap, campaign.name);
      db.set('sync_requested', '1');
    }
  }
}

async function enableWaves(db: Db, ads: AdsPort, settings: Settings, cap: number): Promise<void> {
  for (const wave of WAVES) {
    const key = `enable_${wave}_was`;
    const was = db.get(key) === 'TRUE';
    const now = settings.enable[wave];
    if (now && !was) await enableWave(db, ads, settings.account, cap, wave);
    db.set(key, now ? 'TRUE' : 'FALSE');
  }
}

// ---------- main ----------
function missingEnv(): string[] {
  return REQUIRED_ENV.filter((name) => !process.env[name]);
}

async function main(): Promise<void> {
  // Wait for Railway variables instead of crashing, so the logs say what is missing.
  while (missingEnv().length > 0) {
    log(`Waiting for Railway variables: ${missingEnv().join(', ')}`);
    await sleep(60);
  }
  const dataDir = process.env.DATA_DIR ?? '/data';
  if (!existsSync(dataDir) || !statSync(dataDir).isDirectory()) {
    log(`${dataDir} is not a mounted volume; refusing to start (state must survive restarts)`);
    process.exit(1);
  }
  const env = process.env as Record<string, string>;
  const db = new Db(join(dataDir, 'rsa.sqlite'));
  // A failed preflight is tried again after a restart.
  if (db.get('preflight') === 'failed') db.set('preflight', '');
  // One-time (10 Nov 2026): copy that failed only because the answer wasn't read as JSON gets 3 new tries.
  if (db.get('reset_unreadable_copy_v1') !== 'done') {
    const reset = db.resetUnreadableCopy();
    db.set('reset_unreadable_copy_v1', 'done');
    log(`ad copy: ${reset} articles whose answers couldn't be read get 3 new tries`);
  }
  const sheet = googleSheet(env.SHEET_ID, env.GOOGLE_SERVICE_ACCOUNT_JSON);
  await sheet.ensureTabs();
  const adsPorts = new Map<string, AdsPort>();
  const deps: Deps = {
    db,
    sheet,
    batches: anthropicBatchClient(env.ANTHROPIC_API_KEY),
    adsFor: (customerId) => {
      const cached = adsPorts.get(customerId);
      if (cached) return cached;
      const port = googleAdsPort(
        {
          developerToken: env.GOOGLE_ADS_DEVELOPER_TOKEN,
          clientId: env.GOOGLE_ADS_CLIENT_ID,
          clientSecret: env.GOOGLE_ADS_CLIENT_SECRET,
          refreshToken: env.GOOGLE_ADS_REFRESH_TOKEN,
          loginCustomerId: env.GOOGLE_ADS_LOGIN_CUSTOMER_ID,
        },
        customerId,
      );
      adsPorts.set(customerId, port);
      return port;
    },
  };
  log('rsa worker started');
  let lastWrite = 0;
  for (;;) {
    try {
      await tick(deps);
    } catch (error) {
      const message = (error as Error).message ?? String(error);
      db.set('status', `Error (will retry next minute): ${message.slice(0, 300)}`);
      log(`error: ${(error as Error).stack ?? message}`);
    }
    if (Date.now() - lastWrite > SHEET_WRITE_MIN_SECONDS * 1000) {
      try {
        await writeReports(db, sheet);
        lastWrite = Date.now();
      } catch (error) {
        log(`sheet write failed: ${(error as Error).message}`);
      }
    }
    await sleep(TICK_SECONDS);
  }
}

const sleep = (seconds: number) => new Promise((resolve) => setTimeout(resolve, seconds * 1000));

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    log(`fatal: ${(error as Error).stack ?? error}`);
    process.exit(1);
  });
}
