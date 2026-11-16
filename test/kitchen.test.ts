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
  // Pilot: the first campaign of every theme, nothing else.
  const pilotCampaigns = [...new Set(out.filter((a) => a.wave === 'pilot').map((a) => a.campaign))];
  assert.deepEqual(pilotCampaigns.map((c) => c.split(' | ')[0]).sort(), ['Cakes', 'Chicken']);
  const firstPerTheme = new Map<string, string>();
  for (const a of out) if (!firstPerTheme.has(a.campaign.split(' | ')[0])) firstPerTheme.set(a.campaign.split(' | ')[0], a.campaign);
  assert.deepEqual(pilotCampaigns.sort(), [...firstPerTheme.values()].sort());
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
  // Pilot = one campaign per theme.
  const themesInList = new Set(db.allArticles().map((a) => a.theme));
  assert.equal(db.campaigns('pilot').length, themesInList.size);
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

test('pot butter is left out: not grouped, no copy, never uploaded', async () => {
  const { deps, sheet, batches, ads, db } = setup();
  const input = sheet.tabs.get('Input')!;
  input.push(['https://ponly.com/kitchen/how-to-make-pot-butter/', 'How to Make Pot Butter', 'how to make pot butter']);
  sheet.setting('Account', '197-000-0000');
  for (let i = 0; i < 3; i++) await tick(deps);
  const pot = db.article('https://ponly.com/kitchen/how-to-make-pot-butter/')!;
  assert.equal(pot.wave, 'excluded');
  assert.equal(pot.campaign, '');
  sheet.setting('Upload pilot', 'TRUE');
  sheet.setting('Upload rest', 'TRUE');
  for (let i = 0; i < 4; i++) await tick(deps);
  assert.ok(!batches.sent.flat().some((r) => r.custom_id === `a${pot.row_index}`), 'no copy written');
  assert.ok(!ads.calls.some((c) => c.operations.some((o) => JSON.stringify(o.resource).includes('pot-butter'))), 'never sent to Google');
  assert.ok(db.campaigns().every((c) => c.status === 'uploaded'));
});

test('"Other" articles are re-tagged with extra themes, then grouped again (one-time, before any upload)', async () => {
  const { deps, sheet, batches, db } = setup();
  sheet.setting('Account', '197-000-0000');
  for (let i = 0; i < 3; i++) await tick(deps);
  assert.equal(db.get('grouped'), '1');
  const otherBefore = db.allArticles().filter((a) => a.theme === 'Other');
  assert.ok(otherBefore.length > 0);
  // Haiku proposes "Butter Basics" for some "Other" keywords; the re-tag uses it.
  const original = batches.answer;
  batches.answer = (req) => {
    if (req.custom_id === 'extra') return { custom_id: 'extra', type: 'succeeded', text: JSON.stringify({ themes: ['Chicken', 'Quick Bites'] }) };
    if (req.custom_id.startsWith('t')) {
      const content = (req.params.messages as { content: string }[])[0].content;
      assert.match(content, /Quick Bites/, 'extra theme offered when tagging');
      return { custom_id: req.custom_id, type: 'succeeded', text: JSON.stringify({ theme: 'Quick Bites', dish: 'bites' }) };
    }
    return original(req);
  };
  assert.equal(db.reopenOtherForRetag(), otherBefore.length);
  for (let i = 0; i < 3; i++) await tick(deps);
  assert.equal(db.get('grouped'), '1');
  const themes = JSON.parse(db.get('themes')!);
  assert.deepEqual(themes.slice(-2), ['Quick Bites', 'Other'], 'new theme added; Chicken not added twice; Other last');
  assert.equal(themes.filter((t: string) => t === 'Chicken').length, 1);
  for (const a of otherBefore) assert.equal(db.article(a.url)!.theme, 'Quick Bites');
  // Articles outside "Other" kept their themes.
  for (const a of db.allArticles().filter((x) => !otherBefore.some((o) => o.url === x.url))) assert.equal(a.theme, themeFor(a.keyword).theme);
  assert.ok(db.campaigns().some((c) => c.name.startsWith('Quick Bites | ')));
  assert.equal(db.reopenOtherForRetag(), 0, 'nothing left in Other');
});

test('"Other" re-tag never runs once something is in Google Ads', async () => {
  const { deps, sheet, db } = setup();
  sheet.setting('Account', '197-000-0000');
  for (let i = 0; i < 3; i++) await tick(deps);
  db.sql.prepare("UPDATE campaigns SET status = 'uploaded', campaign_id = '9' WHERE rowid = 1").run();
  assert.equal(db.reopenOtherForRetag(), 0);
  assert.equal(db.get('grouped'), '1');
});

test('copy schema and prompt ask for descriptions before headlines', async () => {
  const { AD_COPY_SCHEMA, SYSTEM_PROMPT } = await import('../src/adcopy.ts');
  assert.deepEqual(Object.keys(AD_COPY_SCHEMA.properties), ['descriptions', 'headlines']);
  assert.ok(SYSTEM_PROMPT.indexOf('descriptions, each') < SYSTEM_PROMPT.indexOf('headlines, each'));
});

test('cut-off answer: complete lines are kept, the half-written last one is dropped', async () => {
  const { salvageAdCopy, parseAdCopy } = await import('../src/adcopy.ts');
  // Like the Kitchen pilot (15 Nov 2026): headlines run past 15 and the answer stops at max_tokens.
  const many = Array.from({ length: 40 }, (_, i) => `Headline Number ${i + 1}`);
  const full = JSON.stringify({ descriptions: D, headlines: many });
  const cut = full.slice(0, full.indexOf('Headline Number 30') + 8); // stops inside headline 30
  assert.equal(parseAdCopy(cut), undefined);
  const copy = salvageAdCopy(cut)!;
  assert.equal(copy.descriptions.length, 4);
  assert.equal(copy.headlines.length, 15); // 29 complete, capped at 15
  assert.deepEqual(copy.headlines, many.slice(0, 15));
  // Cut off inside the descriptions: the complete descriptions are kept, no headlines yet.
  const early = JSON.stringify({ descriptions: D, headlines: H });
  const partial = salvageAdCopy(early.slice(0, early.indexOf('Description number 3') + 5))!;
  assert.deepEqual(partial.descriptions, D.slice(0, 2));
  assert.equal(partial.headlines.length, 0);
  // Escaped quotes inside a line are read correctly.
  assert.deepEqual(salvageAdCopy('{"descriptions": ["Say \\"hi\\" to it.", "Two."], "headlines": ["A", "B", "C"')!.descriptions, ['Say "hi" to it.', 'Two.']);
  assert.equal(salvageAdCopy('nothing here'), undefined);
});

test('cut-off answers become ads on the first try (no retry batch)', async () => {
  const { deps, sheet, batches, db } = setup();
  sheet.setting('Account', '197-000-0000');
  for (let i = 0; i < 3; i++) await tick(deps); // grouping
  const many = Array.from({ length: 40 }, (_, i) => `Headline Number ${i + 1}`);
  const full = JSON.stringify({ descriptions: D, headlines: many });
  batches.answer = (req) => ({ custom_id: req.custom_id, type: 'succeeded', text: full.slice(0, full.indexOf('Headline Number 30') + 8), stopReason: 'max_tokens' });
  sheet.setting('Upload pilot', 'TRUE');
  await tick(deps); // copy batch
  await tick(deps); // copy in, upload
  assert.equal(batches.sent.length, 3); // themes, tags, one copy batch: no retries
  const pilot = db.allArticles().filter((a) => a.wave === 'pilot');
  assert.ok(pilot.every((a) => a.copy_status === 'done' && a.ad_status === 'uploaded'));
});

test('one-time reset: cut-off copy gets new tries and the ad goes into its existing campaign', async () => {
  const { deps, sheet, batches, ads, db } = setup();
  sheet.setting('Account', '197-000-0000');
  for (let i = 0; i < 3; i++) await tick(deps); // grouping
  // Before the fix: one article's answer is cut off with nothing usable, every time.
  let victim = -1;
  batches.answer = (req) => {
    const idx = Number(req.custom_id.slice(1));
    if (victim < 0) victim = idx;
    if (idx === victim) return { custom_id: req.custom_id, type: 'succeeded', text: '{"descriptions": ["Half a descr', stopReason: 'max_tokens' };
    return { custom_id: req.custom_id, type: 'succeeded', text: JSON.stringify({ descriptions: D, headlines: H }) };
  };
  sheet.setting('Upload pilot', 'TRUE');
  for (let i = 0; i < 6; i++) await tick(deps);
  const skipped = db.allArticles().filter((a) => a.ad_status === 'skipped' && a.wave === 'pilot');
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].copy_error ?? '', /stop_reason max_tokens/);
  const campaignsBefore = ads.created.size;

  assert.equal(db.resetCutOffCopy(), 1);
  assert.equal(db.resetCutOffCopy(), 0);
  batches.answer = (req) => ({ custom_id: req.custom_id, type: 'succeeded', text: JSON.stringify({ descriptions: D, headlines: H }) });
  for (let i = 0; i < 3; i++) await tick(deps);
  const after = db.article(skipped[0].url)!;
  assert.equal(after.ad_status, 'uploaded');
  assert.ok(after.ad_id);
  assert.equal(ads.created.size, campaignsBefore); // added to the existing campaign, none created
});
