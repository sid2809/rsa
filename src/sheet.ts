import { google, type sheets_v4 } from 'googleapis';

// The Sheet is the control panel. Tabs:
//   Input        Campaign | Ad Group | Keyword | Title | URL | Wave   (paste the grouping file here)
//   Settings     Account, Pause, Daily API quota cap, Upload/Enable boxes per wave
//   Output       one row per article (written by the worker)
//   Summary      totals, API use, pilot pass/fail (written by the worker)
//   Campaign map campaign ID -> name (to match utm_campaign={campaignid} in analytics)

export const SETTINGS_DEFAULTS: [string, string, string][] = [
  ['Account', '', 'Google Ads account ID the campaigns go in, e.g. 123-456-7890'],
  ['Pause', 'FALSE', 'TRUE stops the worker (it does NOT pause campaigns in Google Ads)'],
  ['Daily API quota cap', '14000', 'Operations per 24 h for this tool. This + the display pipeline cap must be 15,000 or less'],
  ['Upload pilot', 'FALSE', 'TRUE: write ad copy for the pilot, run the preflight, upload pilot campaigns (paused)'],
  ['Enable pilot', 'FALSE', 'Untick -> tick: enables the pilot campaigns uploaded so far, once'],
  ['Upload rest', 'FALSE', 'TRUE: write ad copy for the rest and upload it (paused), within the daily cap'],
  ['Enable rest', 'FALSE', 'Untick -> tick: enables the rest campaigns uploaded so far, once'],
];

export const TABS = ['Input', 'Settings', 'Output', 'Summary', 'Campaign map'] as const;

export interface SheetPort {
  ensureTabs(): Promise<void>;
  read(tab: string): Promise<string[][]>;
  write(tab: string, rows: (string | number)[][]): Promise<void>;
}

export function googleSheet(spreadsheetId: string, serviceAccountJson: string): SheetPort {
  const credentials = JSON.parse(serviceAccountJson);
  const auth = new google.auth.GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  const api: sheets_v4.Sheets = google.sheets({ version: 'v4', auth });

  return {
    async ensureTabs() {
      const meta = await api.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties' });
      const existing = new Set((meta.data.sheets ?? []).map((s) => s.properties?.title));
      const missing = TABS.filter((t) => !existing.has(t));
      if (missing.length > 0) {
        await api.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: missing.map((title) => ({ addSheet: { properties: { title } } })) } });
      }
      if (missing.includes('Settings')) {
        await api.spreadsheets.values.update({
          spreadsheetId,
          range: 'Settings!A1',
          valueInputOption: 'USER_ENTERED',
          requestBody: { values: [['Setting', 'Value', 'What it does'], ...SETTINGS_DEFAULTS] },
        });
        // Checkboxes for the TRUE/FALSE rows (Pause and the four wave boxes).
        const after = await api.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties' });
        const sheetId = after.data.sheets?.find((s) => s.properties?.title === 'Settings')?.properties?.sheetId;
        const boxRows = SETTINGS_DEFAULTS.map((row, i) => (row[1] === 'FALSE' ? i + 1 : -1)).filter((i) => i > 0);
        await api.spreadsheets.batchUpdate({
          spreadsheetId,
          requestBody: {
            requests: boxRows.map((rowIndex) => ({
              setDataValidation: {
                range: { sheetId, startRowIndex: rowIndex, endRowIndex: rowIndex + 1, startColumnIndex: 1, endColumnIndex: 2 },
                rule: { condition: { type: 'BOOLEAN' }, strict: true },
              },
            })),
          },
        });
      }
    },
    async read(tab) {
      const response = await api.spreadsheets.values.get({ spreadsheetId, range: `${tab}`, valueRenderOption: 'FORMATTED_VALUE' });
      return (response.data.values ?? []).map((row) => row.map((cell) => String(cell ?? '')));
    },
    async write(tab, rows) {
      await api.spreadsheets.values.clear({ spreadsheetId, range: `${tab}` });
      if (rows.length === 0) return;
      await api.spreadsheets.values.update({
        spreadsheetId,
        range: `${tab}!A1`,
        valueInputOption: 'RAW',
        requestBody: { values: rows },
      });
    },
  };
}

export interface Settings {
  account: string;
  pause: boolean;
  quotaCap: number;
  upload: Record<string, boolean>;
  enable: Record<string, boolean>;
}

export function parseSettings(rows: string[][]): Settings {
  const map = new Map(rows.map((r) => [String(r[0] ?? '').trim().toLowerCase(), String(r[1] ?? '').trim()]));
  const bool = (key: string) => (map.get(key) ?? '').toUpperCase() === 'TRUE';
  const cap = Number((map.get('daily api quota cap') ?? '').replace(/[^0-9]/g, ''));
  return {
    account: map.get('account') ?? '',
    pause: bool('pause'),
    quotaCap: Number.isFinite(cap) && cap > 0 ? cap : 0,
    upload: { pilot: bool('upload pilot'), rest: bool('upload rest') },
    enable: { pilot: bool('enable pilot'), rest: bool('enable rest') },
  };
}

export interface InputRow {
  campaign: string;
  adGroup: string;
  keyword: string;
  title: string;
  url: string;
  wave: 'pilot' | 'rest';
}

// Reads the Input tab (the grouping file). Every problem is returned; nothing is imported if there are any.
export function parseInput(rows: string[][]): { rows: InputRow[]; problems: string[] } {
  const problems: string[] = [];
  if (rows.length === 0) return { rows: [], problems: ['Input tab is empty'] };
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const col = (name: string) => header.indexOf(name);
  const needed = ['campaign', 'ad group', 'keyword', 'title', 'url', 'wave'];
  const missing = needed.filter((n) => col(n) < 0);
  if (missing.length > 0) return { rows: [], problems: [`Input header is missing: ${missing.join(', ')}`] };

  const out: InputRow[] = [];
  const urls = new Set<string>();
  rows.slice(1).forEach((r, i) => {
    const line = i + 2;
    const get = (n: string) => String(r[col(n)] ?? '').trim();
    const row = { campaign: get('campaign'), adGroup: get('ad group'), keyword: get('keyword'), title: get('title'), url: get('url'), wave: get('wave').toLowerCase() };
    if (Object.values(row).every((v) => v === '')) return;
    if (!row.campaign || !row.adGroup || !row.keyword || !row.title) problems.push(`row ${line}: empty cell`);
    if (!/^https:\/\//.test(row.url)) problems.push(`row ${line}: URL must start with https://`);
    if (urls.has(row.url)) problems.push(`row ${line}: duplicate URL`);
    if (row.wave !== 'pilot' && row.wave !== 'rest') problems.push(`row ${line}: Wave must be pilot or rest`);
    urls.add(row.url);
    out.push(row as InputRow);
  });

  // Structure checks: Google allows at most 3 enabled RSAs per ad group; a campaign must sit in one wave.
  const perAdGroup = new Map<string, number>();
  const campaignWave = new Map<string, string>();
  for (const row of out) {
    const key = `${row.campaign}\u0000${row.adGroup}`;
    perAdGroup.set(key, (perAdGroup.get(key) ?? 0) + 1);
    const wave = campaignWave.get(row.campaign);
    if (wave && wave !== row.wave) problems.push(`campaign "${row.campaign}" is in both waves`);
    campaignWave.set(row.campaign, row.wave);
  }
  for (const [key, count] of perAdGroup) {
    if (count > 3) problems.push(`ad group "${key.replace('\u0000', ' / ')}" has ${count} articles (max 3 ads)`);
  }
  return { rows: out, problems: [...new Set(problems)].slice(0, 50) };
}
