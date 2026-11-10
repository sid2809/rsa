import type { Db } from './db.ts';
import type { SheetPort } from './sheet.ts';
import { pilotResult } from './upload.ts';
import { WAVES, PILOT_MIN_APPROVED_SHARE } from './config.ts';

export function outputRows(db: Db): (string | number)[][] {
  const header = ['Row', 'Wave', 'Campaign', 'Ad Group', 'Keyword', 'Title', 'URL', 'Copy', 'Headlines', 'Descriptions', 'Ad status', 'Approval', 'Policy topics', 'Campaign ID', 'Ad group ID', 'Ad ID', 'Error'];
  const campaignIds = new Map(db.campaigns().map((c) => [c.name, c.campaign_id ?? '']));
  const rows = db.allArticles().map((a) => [
    a.row_index + 2,
    a.wave,
    a.campaign,
    a.ad_group,
    a.keyword,
    a.title,
    a.url,
    a.copy_status,
    a.headlines ? JSON.parse(a.headlines).join(' | ') : '',
    a.descriptions ? JSON.parse(a.descriptions).join(' | ') : '',
    a.ad_status,
    a.approval ?? '',
    a.policy_topics ?? '',
    campaignIds.get(a.campaign) ?? '',
    a.ad_group_id ?? '',
    a.ad_id ?? '',
    a.error ?? a.copy_error ?? '',
  ]);
  return [header, ...rows];
}

export function campaignMapRows(db: Db): (string | number)[][] {
  const header = ['Campaign ID', 'Campaign', 'Wave', 'Status', 'Enabled by worker at', 'Google status / serving', 'Error'];
  return [header, ...db.campaigns().map((c) => [c.campaign_id ?? '', c.name, c.wave, c.status, c.enabled_at ?? '', c.serving_status ?? '', c.error ?? ''])];
}

export function summaryRows(db: Db): (string | number)[][] {
  const articles = db.allArticles();
  const campaigns = db.campaigns();
  const rows: (string | number)[][] = [['Item', 'Value']];
  rows.push(['Updated', new Date().toISOString()]);
  rows.push(['Status', db.get('status') ?? '']);
  rows.push(['Preflight', `${db.get('preflight') || 'not run yet'}${db.get('preflight_notes') ? `: ${db.get('preflight_notes')}` : ''}`]);
  rows.push(['API operations used, last 24 h', db.opsLast24h()]);
  for (const wave of WAVES) {
    const a = articles.filter((x) => x.wave === wave);
    const c = campaigns.filter((x) => x.wave === wave);
    const count = <T,>(list: T[], f: (x: T) => boolean) => list.filter(f).length;
    rows.push([`${wave}: articles`, a.length]);
    rows.push([`${wave}: ad copy done / pending / failed`, `${count(a, (x) => x.copy_status === 'done')} / ${count(a, (x) => x.copy_status === 'pending')} / ${count(a, (x) => x.copy_status === 'failed')}`]);
    rows.push([`${wave}: campaigns uploaded / pending / failed (of ${c.length})`, `${count(c, (x) => x.status === 'uploaded')} / ${count(c, (x) => x.status === 'pending')} / ${count(c, (x) => x.status === 'failed')}`]);
    rows.push([`${wave}: ads uploaded / left out`, `${count(a, (x) => x.ad_status === 'uploaded')} / ${count(a, (x) => x.ad_status === 'error' || x.ad_status === 'skipped')}`]);
    rows.push([`${wave}: campaigns enabled by worker`, count(c, (x) => !!x.enabled_at)]);
  }
  const pilot = pilotResult(db);
  rows.push(['Pilot: ads reviewed by Google', pilot.reviewed]);
  rows.push(['Pilot: approved share', pilot.reviewed > 0 ? `${(pilot.share * 100).toFixed(1)}% (needs ${PILOT_MIN_APPROVED_SHARE * 100}%)` : '']);
  rows.push(['Pilot: clickbait / misrepresentation flags', pilot.blocking.length]);
  rows.push(['Pilot: PASS?', pilot.pass === undefined ? 'not decided yet (reviews still running)' : pilot.pass ? 'PASS' : 'FAIL']);
  rows.push(['Last sync with Google Ads', db.get('last_sync') ?? '']);
  return rows;
}

export async function writeReports(db: Db, sheet: SheetPort): Promise<void> {
  if (db.articleCount() === 0) {
    await sheet.write('Summary', [['Item', 'Value'], ['Updated', new Date().toISOString()], ['Status', db.get('status') ?? 'waiting for Input']]);
    return;
  }
  await sheet.write('Summary', summaryRows(db));
  await sheet.write('Output', outputRows(db));
  await sheet.write('Campaign map', campaignMapRows(db));
}
