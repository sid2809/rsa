import { GoogleAdsApi, enums } from 'google-ads-api';
import type { ArticleRow } from './db.ts';
import {
  CAMPAIGN_BUDGET_INR,
  MAX_CPC_INR,
  LOCATION_ID,
  LANGUAGE_ID,
  NETWORKS,
  FINAL_URL_SUFFIX,
  KEYWORD_MATCH_TYPE,
  TEXT_ASSET_AUTOMATION_OFF,
} from './config.ts';

// The parts of the Google Ads API this pipeline uses (tests pass a fake).
export interface AdsPort {
  // One atomic request: everything is created, or nothing is. Returns the resource name of each operation, in order.
  mutate(operations: Operation[], options?: { validateOnly?: boolean }): Promise<string[]>;
  query(gaql: string): Promise<Record<string, any>[]>;
}

export interface Operation {
  entity: string;
  operation: 'create' | 'update' | 'remove';
  resource: Record<string, unknown> | string; // a remove takes just the resource name
}

export interface AdsFailure {
  index: number | undefined; // which operation in the request, when Google says
  message: string;
  code: string;
}

export class AdsError extends Error {
  readonly failures: AdsFailure[];
  constructor(failures: AdsFailure[], fallback: string) {
    super(failures.length > 0 ? failures.map((f) => `${f.code}: ${f.message}`).join(' | ') : fallback);
    this.failures = failures;
  }
}

export function cleanCustomerId(id: string): string {
  return id.replace(/[^0-9]/g, '');
}

export const toMicros = (inr: number) => Math.round(inr * 1_000_000);

export interface GoogleAdsCredentials {
  developerToken: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  loginCustomerId: string;
}

export function googleAdsPort(credentials: GoogleAdsCredentials, customerId: string): AdsPort {
  const client = new GoogleAdsApi({
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
    developer_token: credentials.developerToken,
  });
  const customer = client.Customer({
    customer_id: cleanCustomerId(customerId),
    login_customer_id: cleanCustomerId(credentials.loginCustomerId),
    refresh_token: credentials.refreshToken,
  });
  return {
    async mutate(operations, options) {
      try {
        const response = await customer.mutateResources(operations as never, { validate_only: options?.validateOnly ?? false, partial_failure: false });
        return (response.mutate_operation_responses ?? []).map(resourceNameOf);
      } catch (error) {
        throw toAdsError(error);
      }
    },
    async query(gaql) {
      try {
        return (await customer.query(gaql)) as Record<string, any>[];
      } catch (error) {
        throw toAdsError(error);
      }
    },
  };
}

function resourceNameOf(response: Record<string, any>): string {
  for (const value of Object.values(response ?? {})) {
    if (value && typeof value === 'object' && typeof value.resource_name === 'string') return value.resource_name;
  }
  return '';
}

export function toAdsError(error: unknown): AdsError {
  const raw = error as { errors?: any[]; message?: string };
  const failures: AdsFailure[] = [];
  for (const item of raw?.errors ?? []) {
    const elements: any[] = item?.location?.field_path_elements ?? [];
    const opElement = elements.find((e) => e?.field_name === 'mutate_operations');
    const code = item?.error_code ? Object.entries(item.error_code).map(([k, v]) => `${k}.${v}`).join(',') : 'UNKNOWN';
    let message = String(item?.message ?? 'unknown error');
    const policy = item?.details?.policy_finding_details?.policy_topic_entries;
    if (Array.isArray(policy) && policy.length > 0) message += ` [policy: ${policy.map((p: any) => p.topic).join(', ')}]`;
    failures.push({ index: typeof opElement?.index === 'number' ? opElement.index : undefined, message, code });
  }
  return new AdsError(failures, raw?.message ?? String(error));
}

export const idFromResourceName = (name: string) => name.split('/').pop() ?? '';

// ---------- what one campaign looks like ----------

// What each operation in the request is for, so a failure can be traced back to an article.
export type OpRole =
  | { kind: 'campaign' }
  | { kind: 'ad_group'; adGroup: string }
  | { kind: 'keyword'; adGroup: string; urls: string[] }
  | { kind: 'ad'; adGroup: string; url: string };

export interface CampaignPlan {
  operations: Operation[];
  roles: OpRole[];
}

export interface Ad {
  url: string;
  adGroup: string;
  keyword: string;
  headlines: string[];
  descriptions: string[];
}

export function adsFromArticles(articles: ArticleRow[]): Ad[] {
  return articles.map((a) => ({
    url: a.url,
    adGroup: a.ad_group,
    keyword: a.keyword,
    headlines: JSON.parse(a.headlines ?? '[]'),
    descriptions: JSON.parse(a.descriptions ?? '[]'),
  }));
}

export function campaignOperations(customerId: string, campaignName: string, ads: Ad[], labelResourceName: string): CampaignPlan {
  const cid = cleanCustomerId(customerId);
  const budget = `customers/${cid}/campaignBudgets/-1`;
  const campaign = `customers/${cid}/campaigns/-2`;
  const operations: Operation[] = [];
  const roles: OpRole[] = [];
  const add = (op: Operation, role: OpRole) => {
    operations.push(op);
    roles.push(role);
  };

  add(
    {
      entity: 'campaign_budget',
      operation: 'create',
      resource: {
        resource_name: budget,
        name: `${campaignName} | budget`,
        amount_micros: toMicros(CAMPAIGN_BUDGET_INR),
        delivery_method: enums.BudgetDeliveryMethod.STANDARD,
        explicitly_shared: false,
      },
    },
    { kind: 'campaign' },
  );
  const campaignResource: Record<string, unknown> = {
    resource_name: campaign,
    name: campaignName,
    status: enums.CampaignStatus.PAUSED,
    advertising_channel_type: enums.AdvertisingChannelType.SEARCH,
    campaign_budget: budget,
    network_settings: NETWORKS,
    target_spend: { cpc_bid_ceiling_micros: toMicros(MAX_CPC_INR) },
    geo_target_type_setting: { positive_geo_target_type: enums.PositiveGeoTargetType.PRESENCE },
    contains_eu_political_advertising: enums.EuPoliticalAdvertisingStatus.DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING,
    final_url_suffix: FINAL_URL_SUFFIX,
  };
  if (TEXT_ASSET_AUTOMATION_OFF) {
    campaignResource.asset_automation_settings = [
      { asset_automation_type: enums.AssetAutomationType.TEXT_ASSET_AUTOMATION, asset_automation_status: enums.AssetAutomationStatus.OPTED_OUT },
    ];
  }
  add({ entity: 'campaign', operation: 'create', resource: campaignResource }, { kind: 'campaign' });
  add(
    { entity: 'campaign_criterion', operation: 'create', resource: { campaign, location: { geo_target_constant: `geoTargetConstants/${LOCATION_ID}` } } },
    { kind: 'campaign' },
  );
  add(
    { entity: 'campaign_criterion', operation: 'create', resource: { campaign, language: { language_constant: `languageConstants/${LANGUAGE_ID}` } } },
    { kind: 'campaign' },
  );
  add({ entity: 'campaign_label', operation: 'create', resource: { campaign, label: labelResourceName } }, { kind: 'campaign' });

  appendAdGroups(cid, campaign, ads, new Map(), add);
  return { operations, roles };
}

// Ad groups, keywords and ads. An ad group already in Google Ads (by name, from `existing`) is reused;
// the others are created with temporary IDs.
function appendAdGroups(cid: string, campaign: string, ads: Ad[], existing: Map<string, string>, add: (op: Operation, role: OpRole) => void): void {
  const adGroupNames = [...new Set(ads.map((ad) => ad.adGroup))];
  let temp = 3;
  for (const adGroupName of adGroupNames) {
    const existingId = existing.get(adGroupName);
    const adGroup = existingId ? `customers/${cid}/adGroups/${existingId}` : `customers/${cid}/adGroups/-${temp++}`;
    const groupAds = ads.filter((ad) => ad.adGroup === adGroupName);
    if (!existingId) {
      add(
        {
          entity: 'ad_group',
          operation: 'create',
          resource: { resource_name: adGroup, campaign, name: adGroupName, status: enums.AdGroupStatus.ENABLED, type: enums.AdGroupType.SEARCH_STANDARD },
        },
        { kind: 'ad_group', adGroup: adGroupName },
      );
    }
    // One keyword per article; the same keyword twice in one ad group is added once (as in the repo).
    const byKeyword = new Map<string, string[]>();
    for (const ad of groupAds) {
      const key = ad.keyword.toLowerCase().trim();
      byKeyword.set(key, [...(byKeyword.get(key) ?? []), ad.url]);
    }
    for (const [keyword, urls] of byKeyword) {
      add(
        {
          entity: 'ad_group_criterion',
          operation: 'create',
          resource: { ad_group: adGroup, status: enums.AdGroupCriterionStatus.ENABLED, keyword: { text: keyword, match_type: enums.KeywordMatchType[KEYWORD_MATCH_TYPE] } },
        },
        { kind: 'keyword', adGroup: adGroupName, urls },
      );
    }
    for (const ad of groupAds) {
      add(
        {
          entity: 'ad_group_ad',
          operation: 'create',
          resource: {
            ad_group: adGroup,
            status: enums.AdGroupAdStatus.ENABLED,
            ad: {
              final_urls: [ad.url],
              responsive_search_ad: {
                headlines: ad.headlines.map((text) => ({ text })),
                descriptions: ad.descriptions.map((text) => ({ text })),
              },
            },
          },
        },
        { kind: 'ad', adGroup: adGroupName, url: ad.url },
      );
    }
  }
}

// Adds ads (and their keywords, and any missing ad groups) to a campaign that already exists in Google Ads.
export function topUpOperations(customerId: string, campaignId: string, ads: Ad[], existingAdGroups: Map<string, string>): CampaignPlan {
  const cid = cleanCustomerId(customerId);
  const operations: Operation[] = [];
  const roles: OpRole[] = [];
  appendAdGroups(cid, `customers/${cid}/campaigns/${campaignId}`, ads, existingAdGroups, (op, role) => {
    operations.push(op);
    roles.push(role);
  });
  return { operations, roles };
}

// GAQL string literal
export const gaqlString = (value: string) => `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
