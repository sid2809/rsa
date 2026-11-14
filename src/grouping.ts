// Grouping by Haiku, for lists that come without a Campaign column (Kitchen and later lists).
//
// 1. Themes: one request with every keyword; Haiku returns a list of themes (campaign level, e.g. "Chicken").
// 2. Tags:   one request per article; Haiku picks one theme from that list and names the dish/topic.
// 3. Code:   articles with the same dish go together, 3 per ad group (Google's max enabled RSAs),
//            up to 4 ad groups per campaign, never mixing themes. Campaign name "<Theme> | 0001".
// The result is written to the Output tab for review before "Upload pilot" is ticked.
import type { Db, ArticleRow } from './db.ts';
import type { BatchClient, BatchRequest } from './copy.ts';
import { MODEL, type Wave } from './config.ts';
import { log } from './log.ts';

export const TAG_MAX_ATTEMPTS = 3;
export const THEMES_MAX_ATTEMPTS = 3;
export const ADS_PER_AD_GROUP = 3;
export const AD_GROUPS_PER_CAMPAIGN = 4;
export const PILOT_MIN_ARTICLES = 100;
export const MAX_THEME_LENGTH = 30;
export const OTHER_THEME = 'Other';

const THEMES_PROMPT = `You organise a recipe and cooking website's articles into Google Ads campaigns.
You get every article's search keyword. Return a list of themes that together cover all of them.

Rules:
- Between 20 and 60 themes. Each theme becomes the name of several campaigns, so it must be a short, plain name of 1 to 3 words, at most ${MAX_THEME_LENGTH} characters, Title Case (e.g. "Chicken", "Cheesecake", "Butter Conversions", "Slow Cooker").
- Group by what the searcher wants: the main dish, ingredient or kitchen task. Articles about the same dish must fit the same theme.
- Themes must not overlap: every keyword should clearly belong to exactly one theme.
- Include "${OTHER_THEME}" for keywords that fit nothing else.`;

const TAG_PROMPT = `You tag one article of a recipe and cooking website for Google Ads grouping.
Return:
- theme: exactly one theme from the given list, the one the searcher's intent belongs to.
- dish: the specific dish, ingredient or kitchen task, 1 to 4 lowercase words (e.g. "banana bread", "chicken marsala", "butter conversion", "roast peppers"). Articles about the same thing must get the same dish, so use the plain common name, singular, without words like "recipe", "easy", "best" or "how to".`;

export function themesRequest(keywords: string[]): BatchRequest {
  return {
    custom_id: 'themes',
    params: {
      model: MODEL,
      max_tokens: 4000,
      system: THEMES_PROMPT,
      output_config: {
        format: {
          type: 'json_schema',
          schema: { type: 'object', properties: { themes: { type: 'array', items: { type: 'string' } } }, required: ['themes'], additionalProperties: false },
        },
      },
      messages: [{ role: 'user', content: `Keywords (one per line):\n${keywords.join('\n')}` }],
    },
  };
}

export function tagRequest(article: { row_index: number; title: string; keyword: string }, themes: string[]): BatchRequest {
  return {
    custom_id: `t${article.row_index}`,
    params: {
      model: MODEL,
      max_tokens: 300,
      system: TAG_PROMPT,
      output_config: {
        format: {
          type: 'json_schema',
          schema: {
            type: 'object',
            properties: { theme: { type: 'string', enum: themes }, dish: { type: 'string' } },
            required: ['theme', 'dish'],
            additionalProperties: false,
          },
        },
      },
      messages: [{ role: 'user', content: `Themes: ${themes.join(' | ')}\n\nArticle title: ${article.title}\nSearch keyword: ${article.keyword}` }],
    },
  };
}

function parseJson(text: string): any {
  const candidates = [text.trim()];
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) candidates.push(text.slice(start, end + 1));
  for (const c of candidates) {
    try {
      return JSON.parse(c);
    } catch {
      // next
    }
  }
  return undefined;
}

const titleCase = (s: string) => s.replace(/\s+/g, ' ').trim().split(' ').map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(' ');

// Cleans Haiku's theme list: short, unique, "Other" always present.
export function cleanThemes(raw: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of Array.isArray(raw) ? raw : []) {
    if (typeof t !== 'string') continue;
    const name = titleCase(t.replace(/[|]/g, ' '));
    const key = name.toLowerCase();
    if (!name || name.length > MAX_THEME_LENGTH || seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  if (!seen.has(OTHER_THEME.toLowerCase())) out.push(OTHER_THEME);
  return out.slice(0, 80);
}

// One pass of the grouping step. Returns true once the grouping is saved.
export async function runGrouping(db: Db, client: BatchClient): Promise<boolean> {
  if (db.get('grouped') === '1') return true;

  // 1. Themes
  let themes: string[] | undefined = db.get('themes') ? JSON.parse(db.get('themes')!) : undefined;
  if (!themes) {
    for (const id of db.openBatches('themes')) {
      const status = await client.status(id);
      if (!status.ended) {
        log(`grouping: theme batch ${id} still running`);
        return false;
      }
      let found: string[] | undefined;
      for await (const r of client.results(id)) {
        if (r.type === 'succeeded') {
          const list = cleanThemes(parseJson(r.text ?? '')?.themes);
          if (list.length >= 2) found = list;
        }
      }
      db.closeOtherBatch(id);
      if (found) {
        db.set('themes', JSON.stringify(found));
        themes = found;
        log(`grouping: ${found.length} themes: ${found.join(', ')}`);
      } else {
        db.set('theme_attempts', String(Number(db.get('theme_attempts') ?? '0') + 1));
        log('grouping: theme list answer was not usable');
      }
    }
    if (!themes) {
      if (db.openBatches('themes').length > 0) return false;
      const attempts = Number(db.get('theme_attempts') ?? '0');
      if (attempts >= THEMES_MAX_ATTEMPTS) {
        db.set('status', 'Grouping stopped: Haiku did not return a usable theme list after 3 tries');
        return false;
      }
      const keywords = db.allArticles().map((a) => a.keyword);
      const { id } = await client.create([themesRequest(keywords)]);
      db.addOtherBatch(id, 'themes', 1);
      db.set('status', 'Grouping: asking Haiku for the theme list');
      log(`grouping: theme batch ${id} sent (${keywords.length} keywords)`);
      return false;
    }
  }

  // 2. Tags
  const allowed = new Set(themes);
  for (const id of db.openBatches('tag')) {
    const status = await client.status(id);
    if (!status.ended) {
      log(`grouping: tag batch ${id} still running ${JSON.stringify(status.counts)}`);
      continue;
    }
    let ok = 0;
    for await (const r of client.results(id)) {
      const article = db.articleByIndex(Number(r.custom_id.slice(1)));
      if (!article || article.tag_batch !== id) continue;
      const value = r.type === 'succeeded' ? parseJson(r.text ?? '') : undefined;
      const theme = typeof value?.theme === 'string' && allowed.has(value.theme) ? value.theme : null;
      const dish = typeof value?.dish === 'string' && value.dish.trim() ? value.dish.trim().toLowerCase().slice(0, 60) : article.keyword.toLowerCase();
      db.recordTag(article.url, theme, theme ? dish : null);
      if (theme) ok++;
    }
    db.releaseTagBatch(id);
    db.closeOtherBatch(id);
    log(`grouping: tag batch ${id} ended: ${ok} tagged`);
  }
  if (db.openBatches('tag').length > 0) return false;
  const todo = db.articlesNeedingTag(TAG_MAX_ATTEMPTS);
  if (todo.length > 0) {
    const { id } = await client.create(todo.map((a) => tagRequest(a, themes!)));
    db.markTagBatch(id, todo.map((a) => a.url));
    db.set('status', `Grouping: Haiku is tagging ${todo.length} articles`);
    log(`grouping: tag batch ${id} sent with ${todo.length} articles`);
    return false;
  }
  const leftovers = db.tagLeftoversAsOther();
  if (leftovers > 0) log(`grouping: ${leftovers} articles could not be tagged; put in "${OTHER_THEME}"`);

  // 3. Build and save
  const assignments = buildGrouping(db.allArticles());
  db.saveGrouping(assignments);
  db.set('grouped', '1');
  const campaigns = new Set(assignments.map((a) => a.campaign)).size;
  const adGroups = new Set(assignments.map((a) => `${a.campaign}\u0000${a.adGroup}`)).size;
  db.set('status', `Grouping done: ${campaigns} campaigns, ${adGroups} ad groups. Review the Output tab, then tick "Upload pilot".`);
  log(`grouping: done: ${campaigns} campaigns, ${adGroups} ad groups, ${assignments.length} articles`);
  return true;
}

// Builds ad groups and campaigns from tagged articles. Pure; exported for tests.
export function buildGrouping(articles: Pick<ArticleRow, 'url' | 'keyword' | 'theme' | 'dish'>[]): { url: string; campaign: string; adGroup: string; wave: Wave }[] {
  const byTheme = new Map<string, typeof articles>();
  for (const a of articles) {
    const theme = a.theme || OTHER_THEME;
    byTheme.set(theme, [...(byTheme.get(theme) ?? []), a]);
  }
  const themes = [...byTheme.keys()].sort((x, y) => (x === OTHER_THEME ? 1 : y === OTHER_THEME ? -1 : x.localeCompare(y)));

  const out: { url: string; campaign: string; adGroup: string; wave: Wave }[] = [];
  let campaignNumber = 0;
  let pilotCount = 0;
  for (const theme of themes) {
    // Same dish together: full groups of 3 first, then the remainders, sorted so near dishes sit together.
    const byDish = new Map<string, typeof articles>();
    for (const a of byTheme.get(theme)!) {
      const dish = (a.dish || a.keyword).toLowerCase();
      byDish.set(dish, [...(byDish.get(dish) ?? []), a]);
    }
    const groups: (typeof articles)[] = [];
    const rest: typeof articles = [];
    for (const dish of [...byDish.keys()].sort()) {
      const list = byDish.get(dish)!.sort((x, y) => x.keyword.localeCompare(y.keyword));
      let i = 0;
      for (; i + ADS_PER_AD_GROUP <= list.length; i += ADS_PER_AD_GROUP) groups.push(list.slice(i, i + ADS_PER_AD_GROUP));
      rest.push(...list.slice(i));
    }
    for (let i = 0; i < rest.length; i += ADS_PER_AD_GROUP) groups.push(rest.slice(i, i + ADS_PER_AD_GROUP));

    for (let g = 0; g < groups.length; g += AD_GROUPS_PER_CAMPAIGN) {
      campaignNumber++;
      const campaign = `${theme} | ${String(campaignNumber).padStart(4, '0')}`;
      const chunk = groups.slice(g, g + AD_GROUPS_PER_CAMPAIGN);
      const count = chunk.reduce((n, x) => n + x.length, 0);
      const wave: Wave = pilotCount < PILOT_MIN_ARTICLES ? 'pilot' : 'rest';
      if (wave === 'pilot') pilotCount += count;
      const used = new Set<string>();
      for (const group of chunk) {
        // Ad group name: the most common dish in the group; unique within the campaign.
        const counts = new Map<string, number>();
        for (const a of group) counts.set((a.dish || a.keyword).toLowerCase(), (counts.get((a.dish || a.keyword).toLowerCase()) ?? 0) + 1);
        const base = [...counts.entries()].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))[0][0];
        let name = base;
        for (let n = 2; used.has(name); n++) name = `${base} ${n}`;
        used.add(name);
        for (const a of group) out.push({ url: a.url, campaign, adGroup: name, wave });
      }
    }
  }
  return out;
}
