import { enums } from 'google-ads-api';
import type { Db } from './db.ts';
import {
  type AdsPort,
  AdsError,
  adsFromArticles,
  campaignOperations,
  idFromResourceName,
  gaqlString,
  toMicros,
  cleanCustomerId,
} from './ads.ts';
import {
  LABEL_NAME,
  UPLOAD_MAX_ATTEMPTS,
  CAMPAIGN_BUDGET_INR,
  MAX_CPC_INR,
  FINAL_URL_SUFFIX,
  LOCATION_ID,
  LANGUAGE_ID,
  PILOT_MIN_APPROVED_SHARE,
  PILOT_BLOCKING_POLICY_WORDS,
  type Wave,
} from './config.ts';
import { log } from './log.ts';

export const CAMPAIGN_PREFIX = 'Ponly Faith |';

export class QuotaReached extends Error {}

// Checks the 24-hour operation budget before any Google Ads call. Every call is counted (failed ones too).
export function spend(db: Db, cap: number, count: number, kind: string): void {
  if (db.opsLast24h() + count > cap) throw new QuotaReached(`daily API cap ${cap} reached (${db.opsLast24h()} used in the last 24 h, ${count} more needed for ${kind})`);
  db.addOps(count, kind);
}

const rowsToOps = (rows: number) => Math.max(1, Math.ceil(rows / 10000));

// ---------- label ----------
export async function ensureLabel(db: Db, ads: AdsPort, cap: number): Promise<string> {
  const saved = db.get('label_resource');
  if (saved) return saved;
  spend(db, cap, 1, 'label lookup');
  const rows = await ads.query(`SELECT label.resource_name, label.name FROM label WHERE label.name = ${gaqlString(LABEL_NAME)} AND label.status = 'ENABLED'`);
  let name = rows[0]?.label?.resource_name as string | undefined;
  if (!name) {
    spend(db, cap, 1, 'label create');
    [name] = await ads.mutate([{ entity: 'label', operation: 'create', resource: { name: LABEL_NAME } }]);
    log(`label "${LABEL_NAME}" created`);
  }
  db.set('label_resource', name!);
  return name!;
}

// ---------- preflight ----------
// Runs once before the first upload. Any failure stops uploads; the reason goes to the Summary tab.
export async function preflight(db: Db, ads: AdsPort, customerId: string, cap: number): Promise<string[]> {
  const notes: string[] = [];
  spend(db, cap, 1, 'preflight account');
  const [account] = await ads.query('SELECT customer.currency_code, customer.auto_tagging_enabled, customer.descriptive_name FROM customer');
  const currency = account?.customer?.currency_code;
  if (currency !== 'INR') throw new Error(`account currency is ${currency}, expected INR (budgets and CPC cap are in rupees)`);
  notes.push(`account "${account?.customer?.descriptive_name}", currency INR`);
  notes.push(account?.customer?.auto_tagging_enabled ? 'auto-tagging is ON (gclid will be added)' : 'auto-tagging is OFF: no gclid on clicks. Turn it on in Google Ads > Admin > Account settings if you want it');

  const label = await ensureLabel(db, ads, cap);

  // 1. Check a real campaign of the pilot against Google's rules, without creating it.
  const first = db.campaignsToUpload('pilot', UPLOAD_MAX_ATTEMPTS)[0];
  if (first) {
    const articles = db.articlesOf(first.name).filter((a) => a.copy_status === 'done');
    const plan = campaignOperations(customerId, first.name, adsFromArticles(articles), label);
    spend(db, cap, plan.operations.length, 'preflight validate');
    try {
      await ads.mutate(plan.operations, { validateOnly: true });
      notes.push(`validate-only check of "${first.name}" (${plan.operations.length} operations) passed`);
    } catch (error) {
      if (!(error instanceof AdsError)) throw error;
      // Rejected ads or keywords don't stop the pipeline: the upload leaves those articles out.
      // Anything else (campaign, budget, label, ad group settings) does.
      const roles = error.failures.map((f) => (f.index === undefined ? undefined : plan.roles[f.index]));
      if (error.failures.length === 0 || roles.some((r) => !r || r.kind === 'campaign' || r.kind === 'ad_group')) throw error;
      notes.push(`validate-only check of "${first.name}": campaign settings OK; Google would reject ${error.failures.length} ad/keyword(s): ${error.message.slice(0, 200)}`);
    }
  }

  // 2. Create a test campaign (no ads), read its settings back from Google, then remove it.
  const testName = `RSA preflight test ${new Date().toISOString()}`;
  const testPlan = campaignOperations(customerId, testName, [], label);
  spend(db, cap, testPlan.operations.length, 'preflight test campaign');
  const names = await ads.mutate(testPlan.operations);
  const [budgetName, campaignName] = names;
  try {
    spend(db, cap, 2, 'preflight read back');
    const [row] = await ads.query(
      `SELECT campaign.status, campaign.advertising_channel_type, campaign.network_settings.target_google_search,
              campaign.network_settings.target_search_network, campaign.network_settings.target_content_network,
              campaign.network_settings.target_partner_search_network, campaign.target_spend.cpc_bid_ceiling_micros,
              campaign.geo_target_type_setting.positive_geo_target_type, campaign.final_url_suffix,
              campaign_budget.amount_micros
       FROM campaign WHERE campaign.resource_name = ${gaqlString(campaignName)}`,
    );
    const criteria = await ads.query(
      `SELECT campaign_criterion.type, campaign_criterion.location.geo_target_constant, campaign_criterion.language.language_constant
       FROM campaign_criterion WHERE campaign.resource_name = ${gaqlString(campaignName)}`,
    );
    const c = row?.campaign ?? {};
    const problems: string[] = [];
    const expect = (ok: boolean, what: string) => {
      if (!ok) problems.push(what);
    };
    expect(isEnum(c.status, 'PAUSED'), `status ${c.status}`);
    expect(isEnum(c.advertising_channel_type, 'SEARCH'), `channel ${c.advertising_channel_type}`);
    expect(c.network_settings?.target_google_search === true, 'Google Search not on');
    expect(!c.network_settings?.target_search_network, 'search partners on');
    expect(!c.network_settings?.target_content_network, 'Display Network on');
    expect(!c.network_settings?.target_partner_search_network, 'partner search on');
    expect(Number(c.target_spend?.cpc_bid_ceiling_micros) === toMicros(MAX_CPC_INR), `CPC cap ${c.target_spend?.cpc_bid_ceiling_micros}`);
    expect(isEnum(c.geo_target_type_setting?.positive_geo_target_type, 'PRESENCE'), `location option ${c.geo_target_type_setting?.positive_geo_target_type}`);
    expect(c.final_url_suffix === FINAL_URL_SUFFIX, 'tracking suffix differs');
    expect(Number(row?.campaign_budget?.amount_micros) === toMicros(CAMPAIGN_BUDGET_INR), `budget ${row?.campaign_budget?.amount_micros}`);
    expect(criteria.some((r) => String(r.campaign_criterion?.location?.geo_target_constant ?? '').endsWith(`/${LOCATION_ID}`)), 'US location missing');
    expect(criteria.some((r) => String(r.campaign_criterion?.language?.language_constant ?? '').endsWith(`/${LANGUAGE_ID}`)), 'English missing');
    if (problems.length > 0) throw new Error(`test campaign settings are wrong: ${problems.join('; ')}`);
    notes.push('test campaign read back: paused, Search only, Max Clicks ₹3 cap, ₹2,700 budget, US presence, English, label, tracking suffix: all correct');
  } finally {
    spend(db, cap, 2, 'preflight cleanup');
    await ads.mutate([
      { entity: 'campaign', operation: 'remove', resource: campaignName },
      { entity: 'campaign_budget', operation: 'remove', resource: budgetName },
    ]);
    notes.push('test campaign removed');
  }
  return notes;
}

// Enum values come back as numbers or names depending on the library; accept both.
const ENUM_VALUES: Record<string, number> = {
  PAUSED: enums.CampaignStatus.PAUSED,
  SEARCH: enums.AdvertisingChannelType.SEARCH,
  PRESENCE: enums.PositiveGeoTargetType.PRESENCE,
};
function isEnum(value: unknown, name: string): boolean {
  return value === name || value === ENUM_VALUES[name];
}

// ---------- campaigns that already exist ----------
// Names of this pipeline's campaigns already in Google Ads (protects against creating one twice after a crash).
export async function existingCampaigns(db: Db, ads: AdsPort, cap: number): Promise<Map<string, string>> {
  const rows = await queryCounted(
    db,
    ads,
    cap,
    `SELECT campaign.id, campaign.name FROM campaign WHERE campaign.name LIKE ${gaqlString(`${CAMPAIGN_PREFIX}%`)} AND campaign.status != 'REMOVED'`,
    'existing campaigns',
  );
  return new Map(rows.map((r) => [r.campaign.name as string, String(r.campaign.id)]));
}

async function queryCounted(db: Db, ads: AdsPort, cap: number, gaql: string, kind: string): Promise<Record<string, any>[]> {
  spend(db, cap, 1, kind);
  const rows = await ads.query(gaql);
  db.addOps(rowsToOps(rows.length) - 1, kind);
  return rows;
}

// Takes over a campaign that exists in Google Ads but not in our records (created just before a crash).
async function adoptCampaign(db: Db, ads: AdsPort, cap: number, name: string, campaignId: string): Promise<void> {
  const rows = await queryCounted(
    db,
    ads,
    cap,
    `SELECT ad_group.id, ad_group_ad.ad.id, ad_group_ad.ad.final_urls FROM ad_group_ad WHERE campaign.id = ${campaignId} AND ad_group_ad.status != 'REMOVED'`,
    'adopt campaign',
  );
  const byUrl = new Map<string, { adGroupId: string; adId: string }>();
  for (const r of rows) {
    const url = r.ad_group_ad?.ad?.final_urls?.[0];
    if (url) byUrl.set(url, { adGroupId: String(r.ad_group.id), adId: String(r.ad_group_ad.ad.id) });
  }
  const articles = db.articlesOf(name);
  const found = articles.filter((a) => byUrl.has(a.url)).map((a) => ({ url: a.url, ...byUrl.get(a.url)! }));
  const missing = articles.filter((a) => !byUrl.has(a.url)).map((a) => ({ url: a.url, status: 'error' as const, error: 'not found in the existing campaign in Google Ads' }));
  db.markCampaignUploaded(name, campaignId, found, missing);
  log(`upload: "${name}" already existed in Google Ads (id ${campaignId}); recorded ${found.length} ads, ${missing.length} not found`);
}

// ---------- upload ----------
// Creates one campaign with all its ad groups, keywords and ads in a single atomic request.
// If Google rejects specific ads or keywords, those articles are left out and the rest is sent again.
export async function uploadCampaign(db: Db, ads: AdsPort, customerId: string, cap: number, label: string, name: string, existing: Map<string, string>): Promise<void> {
  const existingId = existing.get(name);
  if (existingId) return adoptCampaign(db, ads, cap, name, existingId);

  const articles = db.articlesOf(name);
  const leftOut: { url: string; status: 'error' | 'skipped'; error: string }[] = articles
    .filter((a) => a.copy_status !== 'done')
    .map((a) => ({ url: a.url, status: 'skipped' as const, error: `no ad copy: ${a.copy_error ?? 'failed'}` }));
  let remaining = articles.filter((a) => a.copy_status === 'done');

  for (let round = 0; round < 10; round++) {
    if (remaining.length === 0) {
      db.markCampaignAttemptFailed(name, 'no articles left to upload', 1);
      log(`upload: "${name}" has no articles left to upload`);
      return;
    }
    const plan = campaignOperations(customerId, name, adsFromArticles(remaining), label);
    spend(db, cap, plan.operations.length, 'upload');
    try {
      const names = await ads.mutate(plan.operations);
      const campaignId = idFromResourceName(names[1]);
      const adGroupIds = new Map<string, string>();
      const uploaded: { url: string; adGroupId: string; adId: string }[] = [];
      plan.roles.forEach((role, i) => {
        if (role.kind === 'ad_group') adGroupIds.set(role.adGroup, idFromResourceName(names[i]));
        if (role.kind === 'ad') {
          // ad_group_ad resource name: customers/x/adGroupAds/{adGroupId}~{adId}
          const adId = idFromResourceName(names[i]).split('~')[1] ?? '';
          uploaded.push({ url: role.url, adGroupId: adGroupIds.get(role.adGroup) ?? '', adId });
        }
      });
      db.markCampaignUploaded(name, campaignId, uploaded, leftOut);
      log(`upload: "${name}" created (id ${campaignId}, ${uploaded.length} ads, ${leftOut.length} left out)`);
      return;
    } catch (error) {
      if (!(error instanceof AdsError)) throw error;
      const badUrls = new Set<string>();
      let campaignLevel = error.failures.length === 0;
      for (const failure of error.failures) {
        const role = failure.index === undefined ? undefined : plan.roles[failure.index];
        if (role?.kind === 'ad') badUrls.add(role.url);
        else if (role?.kind === 'keyword') role.urls.forEach((u) => badUrls.add(u));
        else campaignLevel = true;
      }
      if (campaignLevel || badUrls.size === 0) {
        db.markCampaignAttemptFailed(name, error.message.slice(0, 500), UPLOAD_MAX_ATTEMPTS);
        log(`upload: "${name}" failed: ${error.message.slice(0, 300)}`);
        return;
      }
      for (const url of badUrls) {
        const reasons = error.failures.filter((f) => {
          const role = f.index === undefined ? undefined : plan.roles[f.index];
          return (role?.kind === 'ad' && role.url === url) || (role?.kind === 'keyword' && role.urls.includes(url));
        });
        leftOut.push({ url, status: 'error', error: reasons.map((f) => `${f.code}: ${f.message}`).join(' | ').slice(0, 500) });
      }
      remaining = remaining.filter((a) => !badUrls.has(a.url));
      log(`upload: "${name}": Google rejected ${badUrls.size} ads/keywords; sending again without them`);
    }
  }
  db.markCampaignAttemptFailed(name, 'too many rejected ads', UPLOAD_MAX_ATTEMPTS);
}

// ---------- enable ----------
// When a wave's Enable box goes from unticked to ticked, enables that wave's uploaded campaigns once.
// Campaigns uploaded after the tick stay paused until the box is unticked and ticked again.
export async function enableWave(db: Db, ads: AdsPort, customerId: string, cap: number, wave: Wave): Promise<number> {
  const cid = cleanCustomerId(customerId);
  const toEnable = db.campaigns(wave).filter((c) => c.status === 'uploaded' && !c.enabled_at && c.campaign_id);
  for (let i = 0; i < toEnable.length; i += 1000) {
    const chunk = toEnable.slice(i, i + 1000);
    spend(db, cap, chunk.length, 'enable');
    await ads.mutate(
      chunk.map((c) => ({
        entity: 'campaign',
        operation: 'update' as const,
        resource: { resource_name: `customers/${cid}/campaigns/${c.campaign_id}`, status: enums.CampaignStatus.ENABLED },
      })),
    );
    for (const c of chunk) db.markEnabled(c.name);
  }
  if (toEnable.length > 0) log(`enable: ${toEnable.length} ${wave} campaigns enabled`);
  return toEnable.length;
}

// ---------- sync ----------
export async function sync(db: Db, ads: AdsPort, cap: number): Promise<void> {
  const campaigns = await queryCounted(
    db,
    ads,
    cap,
    `SELECT campaign.id, campaign.status, campaign.serving_status FROM campaign WHERE campaign.name LIKE ${gaqlString(`${CAMPAIGN_PREFIX}%`)} AND campaign.status != 'REMOVED'`,
    'sync campaigns',
  );
  for (const r of campaigns) db.setCampaignServing(String(r.campaign.id), `${statusName(r.campaign.status)} / ${servingName(r.campaign.serving_status)}`);
  const adsRows = await queryCounted(
    db,
    ads,
    cap,
    `SELECT ad_group_ad.ad.id, ad_group_ad.policy_summary.approval_status, ad_group_ad.policy_summary.review_status,
            ad_group_ad.policy_summary.policy_topic_entries
     FROM ad_group_ad WHERE campaign.name LIKE ${gaqlString(`${CAMPAIGN_PREFIX}%`)} AND campaign.status != 'REMOVED' AND ad_group_ad.status != 'REMOVED'`,
    'sync ads',
  );
  for (const r of adsRows) {
    const summary = r.ad_group_ad?.policy_summary ?? {};
    const topics = (summary.policy_topic_entries ?? []).map((t: any) => t.topic).filter(Boolean).join(', ');
    db.setAdApproval(String(r.ad_group_ad.ad.id), `${approvalName(summary.approval_status)} (${reviewName(summary.review_status)})`, topics);
  }
  db.set('last_sync', new Date().toISOString());
  log(`sync: ${campaigns.length} campaigns, ${adsRows.length} ads`);
}

const names = (table: Record<number | string, string | number>) => (v: unknown) => (typeof v === 'number' ? String(table[v] ?? v) : String(v ?? ''));
const statusName = names(enums.CampaignStatus as never);
const servingName = names(enums.CampaignServingStatus as never);
const approvalName = names(enums.PolicyApprovalStatus as never);
const reviewName = names(enums.PolicyReviewStatus as never);

// Pilot pass rules (same as display): at least 95% of reviewed ads approved, and no clickbait or misrepresentation flags.
export function pilotResult(db: Db): { reviewed: number; approved: number; share: number; blocking: string[]; pass: boolean | undefined } {
  const pilot = db.allArticles().filter((a) => a.wave === 'pilot' && a.ad_status === 'uploaded');
  const reviewed = pilot.filter((a) => a.approval && !a.approval.includes('REVIEW_IN_PROGRESS'));
  const approved = reviewed.filter((a) => a.approval!.startsWith('APPROVED'));
  const blocking = pilot.filter((a) => PILOT_BLOCKING_POLICY_WORDS.some((w) => (a.policy_topics ?? '').toUpperCase().includes(w))).map((a) => a.url);
  const share = reviewed.length > 0 ? approved.length / reviewed.length : 0;
  const pass = reviewed.length < pilot.length || pilot.length === 0 ? undefined : share >= PILOT_MIN_APPROVED_SHARE && blocking.length === 0;
  return { reviewed: reviewed.length, approved: approved.length, share, blocking, pass };
}
