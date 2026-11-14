import assert from 'node:assert/strict';
import { services } from 'google-ads-api';
import { AdsError, type AdsPort, type Operation } from '../src/ads.ts';
import type { SheetPort } from '../src/sheet.ts';
import type { BatchClient, BatchRequest, BatchResult } from '../src/copy.ts';

// ---------- fakes ----------
export const H = Array.from({ length: 15 }, (_, i) => `Headline Number ${i + 1}`);
export const D = Array.from({ length: 4 }, (_, i) => `Description number ${i + 1} for this article.`);

export class FakeBatches implements BatchClient {
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

export class FakeAds implements AdsPort {
  calls: { operations: Operation[]; validateOnly: boolean }[] = [];
  queries: string[] = [];
  existing: { id: string; name: string }[] = [];
  failAdUrl: string | undefined; // Google rejects the ad with this final URL
  failNext: { kind: 'quota' | 'concurrent'; times: number } | undefined; // the next N mutates fail like this
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
    if (this.failNext && this.failNext.times > 0 && !options?.validateOnly) {
      this.failNext.times--;
      if (this.failNext.kind === 'quota') throw new AdsError([{ index: undefined, message: 'Too many requests. Retry in 600 seconds.', code: 'quota_error.2' }], 'quota');
      throw new AdsError([{ index: undefined, message: 'Multiple requests were attempting to modify the same resource at once. Retry the request.', code: 'database_error.2' }], 'db');
    }
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
    if ((gaql.includes('campaign.name LIKE') || gaql.includes('campaign.labels CONTAINS ANY')) && gaql.startsWith('SELECT campaign.id, campaign.name')) return this.existing.map((c) => ({ campaign: c }));
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

export class FakeSheet implements SheetPort {
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

