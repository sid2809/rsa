// Kitchen-style list: no Campaign column, grouped by Haiku, its own label. (Each test file runs in its own process.)
import './kitchen-env.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { H, D, FakeBatches, FakeAds, FakeSheet } from './fakes.ts';
import type { BatchRequest } from '../src/copy.ts';

const { Db } = await import('../src/db.ts');
const { tick } = await import('../src/worker.ts');
const { buildGrouping, cleanThemes } = await import('../src/grouping.ts');
const { cleanAdCopy } = await import('../src/adcopy.ts');
const { SETTINGS_DEFAULTS } = await import('../src/sheet.ts');
const { LABEL_NAME } = await import('../src/config.ts');
const { outputRows } = await import('../src/report.ts');

const THEMES = ['Chicken', 'Cakes', 'Butter Conversions', 'Other'];

function themeFor(keyword: string): { theme: string; dish: string } {
  const k = keyword.toLowerCase();
  if (k.includes('chicken')) return { theme: 'Chicken', dish: k.includes('marsala') ? 'chicken marsala' : 'chicken' };
  if (k.includes('cake') || k.includes('cheesecake')) return { theme: 'Cakes', dish: k.includes('cheesecake') ? 'cheesecake' : 'cake' };
  if (k.includes('butter')) return { theme: 'Butter Conversions', dish: 'butter conversion' };
  return { theme: 'Other', dish: k.split(' ').slice(0, 2).join(' ') };
}

function kitchenBatches(): FakeBatches {
  const batches = new FakeBatches();
  batches.answer = (req: BatchRequest) => {
    if (req.custom_id === 'themes') return { custom_id: req.custom_id, type: 'succeeded', text: JSON.stringify({ themes: THEMES }) };
    if (req.custom_id.startsWith('t')) {
      const content = (req.params.messages as { content: string }[])[0].content;
      const keyword = content.match(/Search keyword: (.*)/)![1];
      return { custom_id: req.custom_id, type: 'succeeded', text: JSON.stringify(themeFor(keyword)) };
    }
    return { custom_id: req.custom_id, type: 'succeeded', text: JSON.stringify({ headlines: H, descriptions: D }) };
  };
  return batches;
}

function setup(rows = 400) {
  const csv = readFileSync(new URL('./fixtures/kitchen.csv', import.meta.url), 'utf8').trim().split(/\r?\n/).slice(0, rows + 1);
  const sheet = new FakeSheet();
  sheet.tabs.set('Input', csv.map((line) => line.split(',')));
  sheet.tabs.set('Settings', [['Setting', 'Value', ''], ...SETTINGS_DEFAULTS.map((r) => [...r])]);
  const db = new Db(':memory:');
  const batches = kitchenBatches();
  const ads = new FakeAds();
  return { db, sheet, batches, ads, deps: { db, sheet, batches, adsFor: () => ads } };
}

test('label comes from LABEL_NAME', () => {
  assert.equal(LABEL_NAME, 'Ponly Kitchen');
});

test('themes are cleaned: short, unique, Other always there', () => {
  assert.deepEqual(cleanThemes(['chicken', 'Chicken', 'A Very Long Theme Name That Is Too Long To Use', 'cakes | pies']), ['Chicken', 'Cakes Pies', 'Other']);
});

test('grouping: same dish together, max 3 ads per ad group, max 4 ad groups per campaign, one theme per campaign', () => {
  const articles = Array.from({ length: 50 }, (_, i) => ({
    url: `https://x/${i}`,
    keyword: `k${i}`,
    theme: i < 30 ? 'Chicken' : 'Cakes',
    dish: i < 7 ? 'chicken marsala' : i < 30 ? `chicken ${i % 5}` : 'cheesecake',
  }));
  const out = buildGrouping(articles);
  assert.equal(out.length, 50);
  const byGroup = new Map<string, string[]>();
  for (const a of out) byGroup.set(`${a.campaign}|${a.adGroup}`, [...(byGroup.get(`${a.campaign}|${a.adGroup}`) ?? []), a.url]);
  assert.ok([...byGroup.values()].every((g) => g.length <= 3));
  const groupsPerCampaign = new Map<string, number>();
  for (const key of byGroup.keys()) groupsPerCampaign.set(key.split('|').slice(0, 2).join('|'), (groupsPerCampaign.get(key.split('|').slice(0, 2).join('|')) ?? 0) + 1);
  assert.ok([...groupsPerCampaign.values()].every((n) => n <= 4));
  // Never two themes in one campaign; names are "<Theme> | 0001".
  for (const a of out) {
    const theme = articles.find((x) => x.url === a.url)!.theme;
    assert.ok(a.campaign.startsWith(`${theme} | `), a.campaign);
    assert.match(a.campaign, /^[A-Za-z ]+ \| \d{4}$/);
  }
  // The 7 "chicken marsala" articles: two full ad groups of 3 together.
  const marsala = out.filter((a) => a.adGroup.startsWith('chicken marsala'));
  assert.ok(marsala.length >= 6);
  // Pilot: whole campaigns until at least 100 articles (here all 50).
  assert.ok(out.every((a) => a.wave === 'pilot'));
});

test('kitchen flow: themes -> tags -> grouping (no upload yet) -> upload with label after the box', async () => {
  const { deps, sheet, batches, ads, db } = setup();
  sheet.setting('Account', '197-000-0000');
  await tick(deps); // import + theme batch
  assert.equal(db.get('mode'), 'grouping');
  assert.equal(batches.sent[0][0].custom_id, 'themes');
  await tick(deps); // themes in -> tag batch
  assert.ok(batches.sent[1].every((r) => r.custom_id.startsWith('t')));
  assert.deepEqual(((batches.sent[1][0].params.output_config as any).format.schema.properties.theme.enum), THEMES);
  await tick(deps); // tags in -> grouping saved
  assert.equal(db.get('grouped'), '1');
  assert.match(db.get('status') ?? '', /Grouping done/);
  // Nothing sent to Google, no copy yet: Upload pilot not ticked.
  assert.equal(ads.calls.length, 0);
  assert.equal(batches.sent.length, 2);
  const out = outputRows(db);
  assert.deepEqual(out[0].slice(-2), ['Theme', 'Dish']);
  assert.ok(out.slice(1).every((r) => /^[A-Za-z ]+ \| \d{4}$/.test(String(r[2]))));

  sheet.setting('Upload pilot', 'TRUE');
  await tick(deps); // copy batch
  await tick(deps); // copy in, preflight, upload
  assert.equal(db.get('preflight'), 'passed', db.get('preflight_notes'));
  assert.match(db.get('preflight_notes') ?? '', /label "Ponly Kitchen"/);
  assert.ok(ads.queries.some((q) => q.includes('campaign.labels CONTAINS ANY')), 'finds campaigns by label');
  const labelCreate = ads.calls.find((c) => c.operations.some((o) => o.entity === 'label'));
  assert.equal((labelCreate!.operations[0].resource as any).name, 'Ponly Kitchen');
  const pilot = db.campaigns('pilot');
  assert.ok(pilot.length > 0 && pilot.every((c) => c.status === 'uploaded'));
  assert.ok(db.allArticles().filter((a) => a.wave === 'pilot').length >= 100);
});

test('Google quota error: waits, no try used, refused call not counted; carries on after the wait', async () => {
  const { deps, sheet, ads, db } = setup();
  sheet.setting('Account', '197-000-0000');
  for (let i = 0; i < 3; i++) await tick(deps); // grouping
  sheet.setting('Upload pilot', 'TRUE');
  await tick(deps); // copy batch
  ads.failNext = { kind: 'quota', times: 1 };
  // Preflight's own calls succeed only if failNext skips them; make preflight pass first.
  ads.failNext.times = 0;
  await tick(deps); // preflight + uploads
  assert.equal(db.get('preflight'), 'passed');
  // Reset: un-upload is not possible, so test on the rest wave.
  sheet.setting('Upload rest', 'TRUE');
  await tick(deps); // rest copy batch sent
  ads.failNext = { kind: 'quota', times: 1 };
  const before = db.opsLast24h();
  await tick(deps); // first rest upload hits quota
  assert.match(db.get('status') ?? '', /Google's daily API limit/);
  assert.ok(db.get('google_quota_until'));
  assert.equal(db.opsLast24h(), before + 1, 'only the existing-campaigns query counted'); // refused upload refunded
  assert.ok(db.campaigns('rest').every((c) => c.attempts === 0 && c.status === 'pending'));
  await tick(deps); // still waiting: no Google calls
  const calls = ads.calls.length;
  await tick(deps);
  assert.equal(ads.calls.length, calls);
  db.set('google_quota_until', new Date(Date.now() - 1000).toISOString()); // the wait is over
  await tick(deps);
  assert.ok(db.campaigns('rest').every((c) => c.status === 'uploaded'));
});

test('temporary "modify the same resource" error: no try used, campaign uploaded on a later pass', async () => {
  const { deps, sheet, ads, db } = setup(150);
  sheet.setting('Account', '197-000-0000');
  for (let i = 0; i < 3; i++) await tick(deps);
  sheet.setting('Upload pilot', 'TRUE');
  await tick(deps);
  ads.failNext = { kind: 'concurrent', times: 0 };
  await tick(deps); // preflight + pilot
  sheet.setting('Upload rest', 'TRUE');
  await tick(deps);
  ads.failNext = { kind: 'concurrent', times: 5 };
  await tick(deps);
  const failedOnce = db.campaigns('rest').filter((c) => (c.error ?? '').includes('Multiple requests'));
  assert.ok(failedOnce.length > 0);
  assert.ok(db.campaigns('rest').every((c) => c.attempts === 0 && c.status !== 'failed'));
  await tick(deps);
  await tick(deps);
  assert.ok(db.campaigns('rest').every((c) => c.status === 'uploaded'));
});

test('copy rules drop clickbait wording, keep Best and 2026', () => {
  const copy = cleanAdCopy({
    headlines: ['Hidden Truth About Bread', 'Best Banana Bread Recipe', 'Banana Bread Recipe 2026', 'Secret Ingredient Revealed', 'Read the Full Recipe'],
    descriptions: ['A plain banana bread recipe with ripe bananas and butter.', 'You won\'t believe this bread.'],
  });
  assert.deepEqual(copy.headlines, ['Best Banana Bread Recipe', 'Banana Bread Recipe 2026']);
  assert.deepEqual(copy.descriptions, ['A plain banana bread recipe with ripe bananas and butter.']);
});

test('tag batch still running: grouping waits for it, and uses Haiku\'s themes (bug of 15 Nov 2026)', async () => {
  const { deps, sheet, batches, db } = setup();
  batches.runningChecks = 2; // every batch shows "running" twice before it ends
  sheet.setting('Account', '197-000-0000');
  for (let i = 0; i < 4; i++) await tick(deps);
  assert.notEqual(db.get('grouped'), '1', 'not grouped while the tag batch is running');
  assert.ok(db.allArticles().every((a) => a.theme === null || a.theme === undefined));
  for (let i = 0; i < 6; i++) await tick(deps);
  assert.equal(db.get('grouped'), '1');
  const themes = new Set(db.allArticles().map((a) => a.theme));
  assert.ok(themes.has('Chicken') && themes.has('Cakes'), JSON.stringify([...themes]));
  const counts = new Map<string, number>();
  for (const a of db.allArticles()) counts.set(a.theme!, (counts.get(a.theme!) ?? 0) + 1);
  // Matches the fake tagger exactly: every article got the theme Haiku gave it.
  for (const a of db.allArticles()) assert.equal(a.theme, themeFor(a.keyword).theme);
  assert.ok(db.campaigns().every((c) => c.name.split(' | ')[0] === db.articlesOf(c.name)[0].theme));
});

test('repair: an "Other" grouping made before the tags came back is undone, and the tags are collected', async () => {
  const { deps, sheet, batches, db } = setup();
  sheet.setting('Account', '197-000-0000');
  await tick(deps); // theme batch
  await tick(deps); // themes in, tag batch sent
  // Recreate the state of 15 Nov: the tag batch row missing, everything put in Other, grouping saved.
  const tagBatch = db.allArticles()[0].tag_batch!;
  db.sql.prepare('DELETE FROM batches WHERE id = ?').run(tagBatch);
  db.tagLeftoversAsOther();
  const { buildGrouping } = await import('../src/grouping.ts');
  db.saveGrouping(buildGrouping(db.allArticles()));
  db.set('grouped', '1');
  assert.ok(db.allArticles().every((a) => a.theme === 'Other'));

  assert.deepEqual(db.repairUnrecordedTagBatches(), [tagBatch]);
  assert.equal(db.campaigns().length, 0);
  await tick(deps); // collects the tag batch, groups again
  assert.equal(db.get('grouped'), '1');
  for (const a of db.allArticles()) assert.equal(a.theme, themeFor(a.keyword).theme);
  assert.deepEqual(db.repairUnrecordedTagBatches(), [], 'runs once');
  void batches;
});

test('repair never touches a grouping that already has campaigns in Google Ads', async () => {
  const { deps, sheet, db } = setup();
  sheet.setting('Account', '197-000-0000');
  for (let i = 0; i < 3; i++) await tick(deps);
  const name = db.campaigns()[0].name;
  db.sql.prepare("UPDATE campaigns SET status = 'uploaded', campaign_id = '1' WHERE name = ?").run(name);
  db.sql.prepare("UPDATE articles SET tag_batch = 'orphan' WHERE row_index = 0").run();
  assert.deepEqual(db.repairUnrecordedTagBatches(), []);
});
