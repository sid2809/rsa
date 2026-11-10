import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { services } from 'google-ads-api';
import { Db } from '../src/db.ts';
import { cleanAdCopy, parseAdCopy } from '../src/adcopy.ts';
import { campaignOperations, AdsError, type AdsPort, type Operation } from '../src/ads.ts';
import { parseInput, parseSettings, SETTINGS_DEFAULTS, type SheetPort } from '../src/sheet.ts';
import type { BatchClient, BatchRequest, BatchResult } from '../src/copy.ts';
import { tick, type Deps } from '../src/worker.ts';
import { outputRows, summaryRows } from '../src/report.ts';
import { buildInput, campaignTheme } from '../scripts/group.ts';
import { FINAL_URL_SUFFIX, MODEL } from '../src/config.ts';

// ---------- fakes ----------
const H = Array.from({ length: 15 }, (_, i) => `Headline Number ${i + 1}`);
const D = Array.from({ length: 4 }, (_, i) => `Description number ${i + 1} for this article.`);

class FakeBatches implements BatchClient {
  sent: BatchRequest[][] = [];
  answer: (req: BatchRequest) => BatchResult = (req) => ({ custom_id: req.custom_id, type: 'succeeded', text: JSON.stringify({ headlines: H, descriptions: D }) });
  async create(requests: BatchRequest[]) {
    this.sent.push(requests);
    return { id: `batch_${this.sent.length}` };
  }
  async status() {
    return { ended: true, counts: {} };
  }
  async *results(id: string) {
    const requests = this.sent[Number(id.split('_')[1]) - 1];
    for (const r of requests) yield this.answer(r);
  }
}

class FakeAds implements AdsPort {
  calls: { operations: Operation[]; validateOnly: boolean }[] = [];
  queries: string[] = [];
  existing: { id: string; name: string }[] = [];
  failAdUrl: string | undefined; // Google rejects the ad with this final URL
  currency = 'INR';
  next = 100;
  created = new Map<string, Record<string, any>>(); // campaign resource name -> resource
  adGroups: { id: string; name: string; campaign: string }[] = [];
  children: { entity: string; adGroup: string }[] = [];
  async mutate(operations: Operation[], options?: { validateOnly?: boolean }) {
    // Every operation must be a valid Google Ads API message (same conversion the library does).
    for (const op of operations) {
      const key = `${op.entity}_operation`;
      const message = { [key]: { [op.operation]: op.resource } };
      const problem = services.MutateOperation.verify(message);
      assert.equal(problem, null, `${op.entity} ${op.operation}: ${problem}`);
    }
    this.calls.push({ operations, validateOnly: !!options?.validateOnly });
    const failIndex = operations.findIndex((op) => op.entity === 'ad_group_ad' && (op.resource as any).ad.final_urls[0] === this.failAdUrl);
    if (failIndex >= 0) {
      throw new AdsError([{ index: failIndex, message: 'A policy was violated.', code: 'policy_finding_error.POLICY_FINDING' }], 'policy');
    }
    if (options?.validateOnly) return operations.map(() => '');
    const temp = new Map<string, string>();
    return operations.map((op) => {
      const r = op.resource as Record<string, any>;
      if (op.operation !== 'create') return typeof op.resource === 'string' ? op.resource : r.resource_name;
      const id = String(this.next++);
      if (op.entity === 'ad_group_ad') {
        this.children.push({ entity: op.entity, adGroup: temp.get(r.ad_group) ?? r.ad_group });
        return `customers/1/adGroupAds/${(temp.get(r.ad_group) ?? r.ad_group).split('/').pop()}~${id}`;
      }
      const real = `customers/1/${op.entity}s/${id}`;
      if (r.resource_name) temp.set(r.resource_name, real);
      if (op.entity === 'ad_group') this.adGroups.push({ id, name: r.name, campaign: temp.get(r.campaign) ?? r.campaign });
      if (op.entity === 'ad_group_ad' || op.entity === 'ad_group_criterion') this.children.push({ entity: op.entity, adGroup: temp.get(r.ad_group) ?? r.ad_group });
      if (op.entity === 'campaign') this.created.set(real, r);
      return real;
    });
  }
  async query(gaql: string): Promise<Record<string, any>[]> {
    this.queries.push(gaql);
    if (gaql.includes('FROM customer')) return [{ customer: { currency_code: this.currency, auto_tagging_enabled: true, descriptive_name: 'Test account' } }];
    if (gaql.includes('FROM label')) return [];
    if (gaql.includes('FROM campaign_criterion')) {
      return [{ campaign_criterion: { location: { geo_target_constant: 'geoTargetConstants/2840' } } }, { campaign_criterion: { language: { language_constant: 'languageConstants/1000' } } }];
    }
    if (gaql.includes('FROM campaign WHERE campaign.resource_name')) {
      const name = gaql.match(/'([^']+)'/)![1];
      const c = this.created.get(name)!;
      return [{ campaign: { ...c, status: 3, advertising_channel_type: 2, geo_target_type_setting: { positive_geo_target_type: 7 } }, campaign_budget: { amount_micros: 2_700_000_000 } }];
    }
    if (gaql.includes('campaign.name LIKE') && gaql.startsWith('SELECT campaign.id, campaign.name')) return this.existing.map((c) => ({ campaign: c }));
    if (gaql.includes('FROM ad_group_ad WHERE campaign.id')) return [];
    if (gaql.includes('FROM ad_group WHERE campaign.id')) {
      const campaignId = gaql.match(/campaign\.id = (\d+)/)![1];
      return this.adGroups.filter((g) => g.campaign.endsWith(`/${campaignId}`)).map((g) => ({ ad_group: { id: g.id, name: g.name } }));
    }
    if (gaql.includes('campaign.serving_status')) return [];
    if (gaql.includes('policy_summary')) return [];
    return [];
  }
}

class FakeSheet implements SheetPort {
  tabs = new Map<string, string[][]>();
  async ensureTabs() {}
  async read(tab: string) {
    return this.tabs.get(tab) ?? [];
  }
  async write(tab: string, rows: (string | number)[][]) {
    this.tabs.set(tab, rows.map((r) => r.map(String)));
  }
  setting(name: string, value: string) {
    const rows = this.tabs.get('Settings')!;
    rows.find((r) => r[0] === name)![1] = value;
  }
}

function setup(articleCount = 40) {
  const csv = readFileSync(new URL('./fixtures/articles.csv', import.meta.url), 'utf8');
  const input = buildInput(csv).slice(0, articleCount + 1);
  // Mark the first campaigns (whole campaigns, at least 10 articles) as the pilot in this small test.
  let n = 0;
  let pilotCampaigns = new Set<string>();
  for (const row of input.slice(1)) {
    if (n < 10 || pilotCampaigns.has(row[0])) {
      pilotCampaigns.add(row[0]);
      row[5] = 'pilot';
    } else row[5] = 'rest';
    n++;
  }
  const sheet = new FakeSheet();
  sheet.tabs.set('Input', input);
  sheet.tabs.set('Settings', [['Setting', 'Value', ''], ...SETTINGS_DEFAULTS.map((r) => [...r])]);
  const db = new Db(':memory:');
  const batches = new FakeBatches();
  const ads = new FakeAds();
  const deps: Deps = { db, sheet, batches, adsFor: () => ads };
  return { db, sheet, batches, ads, deps };
}

// ---------- tests ----------
test('grouping script: themes and names', () => {
  assert.equal(campaignTheme('1 chronicles 1'), '1 Chronicles');
  assert.equal(campaignTheme('psalm 34'), 'Psalms');
  assert.equal(campaignTheme("god's grace"), "God's Grace");
  assert.equal(campaignTheme('adversity'), 'Adversity');
  const rows = buildInput('URL,Title,Keywords\nhttps://ponly.com/faith/a/,"Title, with comma",genesis 1 meaning\n');
  assert.deepEqual(rows[1], ['Ponly Faith | Genesis | 0001', 'genesis 1', 'genesis 1 meaning', 'Title, with comma', 'https://ponly.com/faith/a/', 'pilot']);
});

test('ad copy checks drop bad lines', () => {
  const copy = cleanAdCopy({
    headlines: ['Good Headline', 'Good Headline', 'Way Too Long Headline That Breaks The Limit', 'Wow!', '  spaced   out  '],
    descriptions: ['Fine description.', 'x'.repeat(91)],
  });
  assert.deepEqual(copy.headlines, ['Good Headline', 'spaced out']);
  assert.deepEqual(copy.descriptions, ['Fine description.']);
  assert.equal(parseAdCopy('not json'), undefined);
});

test('campaign operations: settings Siddharth decided', () => {
  const plan = campaignOperations('197-000-0000', 'Ponly Faith | Genesis | 0001', [
    { url: 'https://ponly.com/faith/a/', adGroup: 'genesis 1', keyword: 'Genesis 1 meaning', headlines: H, descriptions: D },
    { url: 'https://ponly.com/faith/b/', adGroup: 'genesis 1', keyword: 'genesis 1 meaning', headlines: H, descriptions: D },
    { url: 'https://ponly.com/faith/c/', adGroup: 'genesis 2', keyword: 'genesis 2 meaning', headlines: H, descriptions: D },
  ], 'customers/1970000000/labels/5');
  const byEntity = (e: string) => plan.operations.filter((o) => o.entity === e).map((o) => o.resource as Record<string, any>);
  const [budget] = byEntity('campaign_budget');
  const [campaign] = byEntity('campaign');
  assert.equal(budget.amount_micros, 2_700_000_000);
  assert.equal(campaign.status, 3); // PAUSED
  assert.equal(campaign.advertising_channel_type, 2); // SEARCH
  assert.equal(campaign.target_spend.cpc_bid_ceiling_micros, 3_000_000);
  assert.deepEqual(campaign.network_settings, { target_google_search: true, target_search_network: false, target_partner_search_network: false, target_content_network: false });
  assert.equal(campaign.geo_target_type_setting.positive_geo_target_type, 7); // PRESENCE
  assert.equal(campaign.final_url_suffix, FINAL_URL_SUFFIX);
  assert.equal(byEntity('campaign_criterion').length, 2);
  assert.equal(byEntity('campaign_label')[0].label, 'customers/1970000000/labels/5');
  assert.equal(byEntity('ad_group').length, 2);
  const keywords = byEntity('ad_group_criterion');
  assert.equal(keywords.length, 2, 'same keyword twice in one ad group is added once');
  assert.ok(keywords.every((k) => k.keyword.match_type === 3)); // PHRASE
  assert.equal(byEntity('ad_group_ad').length, 3);
  assert.ok(plan.operations[1].resource && (plan.operations[0].resource as any).resource_name.startsWith('customers/1970000000/'));
  // Every operation converts to a valid API message.
  for (const op of plan.operations) assert.equal(services.MutateOperation.verify({ [`${op.entity}_operation`]: { create: op.resource } }), null);
});

test('settings and input parsing', () => {
  const s = parseSettings([['Account', '197-844-9758'], ['Pause', 'FALSE'], ['Daily API quota cap', '7,000'], ['Upload pilot', 'TRUE'], ['Enable pilot', 'FALSE']]);
  assert.equal(s.account, '197-844-9758');
  assert.equal(s.quotaCap, 7000);
  assert.equal(s.upload.pilot, true);
  assert.equal(s.upload.rest, false);
  const bad = parseInput([
    ['Campaign', 'Ad Group', 'Keyword', 'Title', 'URL', 'Wave'],
    ['C', 'G', 'k', 't', 'https://x/1', 'pilot'],
    ['C', 'G', 'k', 't', 'https://x/1', 'pilot'],
    ['C', 'G', 'k', 't', 'https://x/2', 'later'],
    ['C', 'G', 'k', 't', 'https://x/3', 'pilot'],
  ]);
  assert.ok(bad.problems.some((p) => p.includes('duplicate URL')));
  assert.ok(bad.problems.some((p) => p.includes('Wave must be')));
  assert.ok(bad.problems.some((p) => p.includes('max 3 ads')));
  assert.ok(bad.problems.some((p) => p.includes('both waves')));
});

test('nothing happens until Upload pilot is ticked', async () => {
  const { deps, batches, ads, db } = setup();
  await tick(deps);
  assert.equal(db.articleCount(), 40);
  assert.equal(batches.sent.length, 0);
  assert.equal(ads.calls.length, 0);
});

test('full pilot flow: copy, preflight, upload paused, enable on tick, rest waits for its box', async () => {
  const { deps, sheet, batches, ads, db } = setup();
  sheet.setting('Account', '197-000-0000');
  sheet.setting('Upload pilot', 'TRUE');
  await tick(deps); // import, send pilot batch, collect it next tick
  assert.equal(batches.sent.length, 1);
  assert.equal(batches.sent[0][0].params.model, MODEL);
  const pilotCount = db.allArticles().filter((a) => a.wave === 'pilot').length;
  assert.equal(batches.sent[0].length, pilotCount);
  await tick(deps); // collect copy, preflight, upload
  assert.equal(db.get('preflight'), 'passed', db.get('preflight_notes'));
  assert.ok(ads.calls.some((c) => c.validateOnly), 'validate-only check ran');
  const pilot = db.campaigns('pilot');
  assert.ok(pilot.length > 0 && pilot.every((c) => c.status === 'uploaded'));
  assert.ok(db.campaigns('rest').every((c) => c.status === 'pending'));
  assert.ok(db.allArticles().filter((a) => a.wave === 'pilot').every((a) => a.ad_status === 'uploaded' && a.ad_id));
  // Every created campaign (except the removed preflight test) is paused.
  for (const c of ads.created.values()) assert.equal(c.status, 3);
  // The preflight test campaign was removed.
  assert.ok(ads.calls.some((c) => c.operations.some((o) => o.operation === 'remove' && o.entity === 'campaign')));

  // Enable pilot: once on untick -> tick.
  const before = ads.calls.length;
  sheet.setting('Enable pilot', 'TRUE');
  await tick(deps);
  const enableCall = ads.calls.slice(before).find((c) => c.operations.every((o) => o.operation === 'update'));
  assert.ok(enableCall);
  assert.equal(enableCall.operations.length, pilot.length);
  assert.ok(db.campaigns('pilot').every((c) => c.enabled_at));
  const after = ads.calls.length;
  await tick(deps);
  assert.ok(!ads.calls.slice(after).some((c) => c.operations.some((o) => o.operation === 'update')), 'not enabled twice');

  // Rest: only after its box.
  sheet.setting('Upload rest', 'TRUE');
  await tick(deps);
  await tick(deps);
  assert.ok(db.campaigns('rest').every((c) => c.status === 'uploaded'));
  assert.ok(db.campaigns('rest').every((c) => !c.enabled_at), 'rest stays paused');

  // Reports
  const out = outputRows(db);
  assert.equal(out.length, 41);
  const summary = summaryRows(db);
  assert.ok(summary.some((r) => String(r[0]).startsWith('API operations used')));
});

test('an ad Google rejects in the preflight check is noted, and left out at upload', async () => {
  const { deps, sheet, ads, db } = setup();
  const target = db.allArticles()[0];
  sheet.setting('Account', '197-000-0000');
  sheet.setting('Upload pilot', 'TRUE');
  await tick(deps);
  const first = db.allArticles()[0];
  ads.failAdUrl = first.url;
  await tick(deps);
  assert.equal(db.get('preflight'), 'passed', db.get('preflight_notes'));
  assert.match(db.get('preflight_notes') ?? '', /would reject 1/);
  assert.equal(db.article(first.url)!.ad_status, 'error');
  assert.equal(db.campaign(first.campaign)!.status, 'uploaded');
  void target;
});

test('rejected ad during upload (after preflight)', async () => {
  const { deps, sheet, ads, db } = setup();
  sheet.setting('Account', '197-000-0000');
  sheet.setting('Upload pilot', 'TRUE');
  await tick(deps);
  // Reject an ad in a rest campaign (preflight only validates the first pilot campaign).
  await tick(deps);
  assert.equal(db.get('preflight'), 'passed');
  const second = db.allArticles().find((a) => a.wave === 'rest')!;
  ads.failAdUrl = second.url;
  sheet.setting('Upload rest', 'TRUE');
  await tick(deps);
  await tick(deps);
  assert.equal(db.get('preflight'), 'passed');
  const row = db.article(second.url)!;
  assert.equal(row.ad_status, 'error');
  assert.match(row.error ?? '', /policy/i);
  assert.equal(db.campaign(second.campaign)!.status, 'uploaded');
  assert.ok(db.articlesOf(second.campaign).filter((a) => a.url !== second.url).every((a) => a.ad_status === 'uploaded'));
});

test('a campaign already in Google Ads is adopted, not created twice', async () => {
  const { deps, sheet, ads, db } = setup();
  sheet.setting('Account', '197-000-0000');
  sheet.setting('Upload pilot', 'TRUE');
  await tick(deps);
  const name = db.campaigns('pilot').map((c) => c.name).sort()[0];
  ads.existing = [{ id: '999', name }];
  await tick(deps);
  assert.equal(db.campaign(name)!.campaign_id, '999');
  const createdNames = [...ads.created.values()].map((c) => c.name);
  assert.ok(!createdNames.includes(name));
});

test('daily cap stops uploads and they continue later', async () => {
  const { deps, sheet, db } = setup();
  sheet.setting('Account', '197-000-0000');
  sheet.setting('Upload pilot', 'TRUE');
  sheet.setting('Daily API quota cap', '60');
  await tick(deps);
  await tick(deps);
  assert.match(db.get('status') ?? '', /daily API cap/);
  assert.ok(db.opsLast24h() <= 60);
  const uploadedBefore = db.campaigns('pilot').filter((c) => c.status === 'uploaded').length;
  sheet.setting('Daily API quota cap', '14000');
  await tick(deps);
  const uploadedAfter = db.campaigns('pilot').filter((c) => c.status === 'uploaded').length;
  assert.ok(uploadedAfter > uploadedBefore);
  assert.ok(db.campaigns('pilot').every((c) => c.status === 'uploaded'));
});

test('copy that keeps failing: retried 3 times, then the article is left out', async () => {
  const { deps, sheet, batches, db } = setup();
  sheet.setting('Account', '197-000-0000');
  sheet.setting('Upload pilot', 'TRUE');
  const bad = new Set<string>();
  batches.answer = (req) => {
    const idx = Number(req.custom_id.slice(1));
    if (idx === 0) {
      bad.add(req.custom_id);
      return { custom_id: req.custom_id, type: 'succeeded', text: '{"headlines":["One"],"descriptions":[]}' };
    }
    return { custom_id: req.custom_id, type: 'succeeded', text: JSON.stringify({ headlines: H, descriptions: D }) };
  };
  for (let i = 0; i < 6; i++) await tick(deps);
  const first = db.articleByIndex(0)!;
  assert.equal(first.copy_attempts, 3);
  assert.equal(first.copy_status, 'failed');
  assert.equal(first.ad_status, 'skipped');
  assert.equal(db.campaign(first.campaign)!.status, 'uploaded');
});

test('preflight stops on a non-INR account', async () => {
  const { deps, sheet, ads, db } = setup();
  ads.currency = 'USD';
  sheet.setting('Account', '197-000-0000');
  sheet.setting('Upload pilot', 'TRUE');
  await tick(deps);
  await tick(deps);
  assert.equal(db.get('preflight'), 'failed');
  assert.match(db.get('preflight_notes') ?? '', /INR/);
  assert.ok(!ads.calls.some((c) => !c.validateOnly && c.operations.some((o) => o.entity === 'ad_group_ad')));
});

test('JSON in a code fence or with text around it is read', () => {
  const json = JSON.stringify({ headlines: H, descriptions: D });
  assert.equal(parseAdCopy('```json\n' + json + '\n```')?.headlines.length, 15);
  assert.equal(parseAdCopy('Here is the ad copy:\n' + json + '\nHope this helps.')?.descriptions.length, 4);
  assert.equal(parseAdCopy('{"headlines": ["a"'), undefined);
});

test('unreadable copy: retried after the fix and added to the already-uploaded campaign', async () => {
  const { deps, sheet, batches, ads, db } = setup();
  sheet.setting('Account', '197-000-0000');
  sheet.setting('Upload pilot', 'TRUE');
  // Every second pilot article gets an answer that isn't JSON (as happened on 10 Nov 2026).
  batches.answer = (req) => {
    const idx = Number(req.custom_id.slice(1));
    if (idx % 2 === 1) return { custom_id: req.custom_id, type: 'succeeded', text: 'Sorry, here you go: headlines...', stopReason: 'end_turn' };
    return { custom_id: req.custom_id, type: 'succeeded', text: JSON.stringify({ headlines: H, descriptions: D }) };
  };
  for (let i = 0; i < 5; i++) await tick(deps);
  const pilot = db.allArticles().filter((a) => a.wave === 'pilot');
  const missing = pilot.filter((a) => a.ad_status === 'skipped');
  assert.ok(missing.length > 0);
  assert.match(db.article(missing[0].url)!.copy_error ?? '', /not valid JSON \(stop_reason end_turn\): Sorry, here you go/);
  assert.ok(db.campaigns('pilot').every((c) => c.status === 'uploaded'));
  const adGroupsBefore = ads.adGroups.length;

  // The fix: the worker restarts, resets those articles, and Haiku's answers are now readable.
  assert.equal(db.resetUnreadableCopy(), missing.length);
  batches.answer = (req) => ({ custom_id: req.custom_id, type: 'succeeded', text: '```json\n' + JSON.stringify({ headlines: H, descriptions: D }) + '\n```' });
  for (let i = 0; i < 3; i++) await tick(deps);

  const after = db.allArticles().filter((a) => a.wave === 'pilot');
  assert.ok(after.every((a) => a.ad_status === 'uploaded' && a.ad_id), JSON.stringify(after.filter((a) => a.ad_status !== 'uploaded').map((a) => [a.url, a.ad_status, a.error])));
  // No campaign created twice: still one campaign per pilot campaign (+ the removed preflight test).
  const created = [...ads.created.values()].map((c) => c.name).filter((n) => n.startsWith('Ponly Faith'));
  assert.equal(created.length, db.campaigns('pilot').length);
  // Ad groups that already existed were reused, not created again: names stay unique per campaign.
  const keys = ads.adGroups.map((g) => `${g.campaign}|${g.name}`);
  assert.equal(new Set(keys).size, keys.length);
  assert.ok(ads.adGroups.length >= adGroupsBefore);
  // Every ad group has at most 3 ads.
  const perGroup = new Map<string, number>();
  for (const c of ads.children.filter((x) => x.entity === 'ad_group_ad')) perGroup.set(c.adGroup, (perGroup.get(c.adGroup) ?? 0) + 1);
  assert.ok([...perGroup.values()].every((n) => n <= 3), JSON.stringify([...perGroup.entries()]));
});
