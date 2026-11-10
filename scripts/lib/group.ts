// Copied unchanged in logic from abhishekblue/n8n-bulk-google-ads scripts/bulk-rsa/group.ts.
export interface Article {
  url: string;
  title: string;
  keyword: string;
  category: string;
}

const ADS_PER_AD_GROUP = 3; // Google allows max 3 enabled RSAs per ad group
const AD_GROUPS_PER_CAMPAIGN = 4;
const CAMPAIGN_PREFIX = 'RSA';

export interface AdGroup {
  name: string;
  articles: Article[];
}

export interface Campaign {
  name: string;
  category: string;
  adGroups: AdGroup[];
}

// Words that change the wording of a search but not its topic.
// "proverbs 4:23 explained" / "proverbs 4:23 meaning" -> "proverbs 4:23"
const FILLER_WORDS = new Set([
  'a', 'an', 'the', 'of', 'for', 'about', 'on', 'to', 'in', 'and', 'with',
  'what', 'does', 'do', 'say', 'says', 'is',
  'bible', 'biblical', 'verse', 'verses', 'quote', 'quotes', 'passage', 'passages',
  'scripture', 'scriptures', 'meaning', 'meanings', 'explained', 'explanation', 'explain',
]);

export function topicCore(keyword: string): string {
  const words = keyword
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/[^a-z0-9:' ]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 0);
  const core = words.filter((word) => !FILLER_WORDS.has(word));
  return (core.length > 0 ? core : words).join(' ');
}

const MIN_SIMILARITY = 0.2;

function trigrams(text: string): Set<string> {
  const padded = ` ${text} `;
  const result = new Set<string>();
  for (let i = 0; i < padded.length - 2; i++) result.add(padded.slice(i, i + 3));
  return result;
}

function similarity(a: Set<string>, b: Set<string>): number {
  let shared = 0;
  for (const gram of a) if (b.has(gram)) shared++;
  return shared / (a.size + b.size - shared);
}

// Step 1: articles whose keywords share the same topic core go together.
// Step 2: leftovers are matched to their most similar leftovers (same category) by character trigrams.
function groupArticles(articles: Article[]): Article[][] {
  const groups: Article[][] = [];
  const buckets = new Map<string, Article[]>();
  for (const article of articles) {
    const key = `${article.category}|${topicCore(article.keyword)}`;
    buckets.set(key, [...(buckets.get(key) ?? []), article]);
  }

  const leftoversByCategory = new Map<string, Article[]>();
  for (const bucket of buckets.values()) {
    let i = 0;
    for (; i + ADS_PER_AD_GROUP <= bucket.length; i += ADS_PER_AD_GROUP) {
      groups.push(bucket.slice(i, i + ADS_PER_AD_GROUP));
    }
    const rest = bucket.slice(i);
    if (rest.length === 0) continue;
    const category = rest[0].category;
    leftoversByCategory.set(category, [...(leftoversByCategory.get(category) ?? []), ...rest]);
  }

  for (const leftovers of leftoversByCategory.values()) {
    groups.push(...groupLeftovers(leftovers));
  }
  return groups;
}

// Most similar pairs are merged first (never above ADS_PER_AD_GROUP). Whatever is still short of a
// full group after that is packed with its alphabetical neighbours.
function groupLeftovers(leftovers: Article[]): Article[][] {
  const items = leftovers
    .map((article) => ({ article, core: topicCore(article.keyword) }))
    .sort((a, b) => a.core.localeCompare(b.core));
  const grams = items.map((item) => trigrams(item.core));

  const edges: { a: number; b: number; score: number }[] = [];
  for (let a = 0; a < items.length; a++) {
    for (let b = a + 1; b < items.length; b++) {
      const score = similarity(grams[a], grams[b]);
      if (score >= MIN_SIMILARITY) edges.push({ a, b, score });
    }
  }
  edges.sort((x, y) => y.score - x.score);

  const groupOf = items.map((_, index) => [index]);
  for (const { a, b } of edges) {
    const groupA = groupOf[a];
    const groupB = groupOf[b];
    if (groupA === groupB || groupA.length + groupB.length > ADS_PER_AD_GROUP) continue;
    groupA.push(...groupB);
    for (const index of groupB) groupOf[index] = groupA;
  }

  const unique = [...new Set(groupOf)].sort((x, y) => Math.min(...x) - Math.min(...y));
  const packed = unique.filter((group) => group.length === ADS_PER_AD_GROUP);
  let current: number[] = [];
  for (const group of unique.filter((group) => group.length < ADS_PER_AD_GROUP)) {
    if (current.length + group.length > ADS_PER_AD_GROUP) {
      packed.push(current);
      current = [];
    }
    current.push(...group);
  }
  if (current.length > 0) packed.push(current);
  return packed.map((group) => group.map((index) => items[index].article));
}

export function buildCampaigns(articles: Article[]): Campaign[] {
  const groupsByCategory = new Map<string, AdGroup[]>();
  for (const group of groupArticles(articles)) {
    const category = group[0].category;
    const adGroup = { name: topicCore(group[0].keyword), articles: group };
    groupsByCategory.set(category, [...(groupsByCategory.get(category) ?? []), adGroup]);
  }

  const campaigns: Campaign[] = [];
  for (const [category, adGroups] of [...groupsByCategory.entries()].sort()) {
    // Sorting by name keeps related topics (e.g. all "proverbs ...") in the same campaigns.
    adGroups.sort((a, b) => a.name.localeCompare(b.name));
    for (let i = 0; i < adGroups.length; i += AD_GROUPS_PER_CAMPAIGN) {
      const number = String(i / AD_GROUPS_PER_CAMPAIGN + 1).padStart(4, '0');
      const campaignAdGroups = adGroups.slice(i, i + AD_GROUPS_PER_CAMPAIGN);
      makeNamesUnique(campaignAdGroups);
      campaigns.push({ name: `${CAMPAIGN_PREFIX} | ${category} | ${number}`, category, adGroups: campaignAdGroups });
    }
  }
  return campaigns;
}

function makeNamesUnique(adGroups: AdGroup[]): void {
  const used = new Map<string, number>();
  for (const adGroup of adGroups) {
    const count = (used.get(adGroup.name) ?? 0) + 1;
    used.set(adGroup.name, count);
    if (count > 1) adGroup.name = `${adGroup.name} ${count}`;
  }
}
