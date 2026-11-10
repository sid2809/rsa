// Prompt and checks copied from abhishekblue/n8n-bulk-google-ads scripts/bulk-rsa (generate.ts, validate.ts).
import {
  HEADLINES_WANTED,
  DESCRIPTIONS_WANTED,
  MAX_HEADLINE_LENGTH,
  MAX_DESCRIPTION_LENGTH,
  MIN_HEADLINES_REQUIRED,
  MIN_DESCRIPTIONS_REQUIRED,
} from './config.ts';

export interface AdCopy {
  headlines: string[];
  descriptions: string[];
}

export const SYSTEM_PROMPT = `You write Google Ads responsive search ad copy for article pages.

Rules:
- Exactly ${HEADLINES_WANTED} headlines, each at most ${MAX_HEADLINE_LENGTH} characters including spaces. Count carefully.
- Exactly ${DESCRIPTIONS_WANTED} descriptions, each at most ${MAX_DESCRIPTION_LENGTH} characters including spaces.
- Every headline must be different in wording and angle; Google mixes them in any order, so each must make sense on its own.
- Put the search keyword (or a natural close variant) in at least 3 headlines when it fits the length limit.
- Describe what the reader gets from the article. Do not promise anything the article title doesn't support.
- No exclamation marks in headlines, no emoji, no ALL CAPS words, no phone numbers, no prices, no "click here".
- Title Case for headlines, sentence case for descriptions ending with a period.`;

export const AD_COPY_SCHEMA = {
  type: 'object',
  properties: {
    headlines: { type: 'array', items: { type: 'string' } },
    descriptions: { type: 'array', items: { type: 'string' } },
  },
  required: ['headlines', 'descriptions'],
  additionalProperties: false,
};

export function userMessage(article: { title: string; keyword: string; url: string }): string {
  return `Article title: ${article.title}\nSearch keyword: ${article.keyword}\nLanding page: ${article.url}`;
}

// Keeps only lines Google Ads will accept; drops the rest instead of failing the whole ad.
export function cleanAdCopy(raw: AdCopy): AdCopy {
  return {
    headlines: cleanLines(raw.headlines, MAX_HEADLINE_LENGTH, true).slice(0, HEADLINES_WANTED),
    descriptions: cleanLines(raw.descriptions, MAX_DESCRIPTION_LENGTH, false).slice(0, DESCRIPTIONS_WANTED),
  };
}

function cleanLines(lines: unknown, maxLength: number, isHeadline: boolean): string[] {
  if (!Array.isArray(lines)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const line of lines) {
    if (typeof line !== 'string') continue;
    const text = line.replace(/\s+/g, ' ').trim();
    const key = text.toLowerCase();
    if (text.length === 0 || text.length > maxLength || seen.has(key)) continue;
    if (isHeadline && text.includes('!')) continue; // Google doesn't allow "!" in headlines
    if (/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(text)) continue; // no emoji
    seen.add(key);
    result.push(text);
  }
  return result;
}

export function isComplete(copy: AdCopy): boolean {
  return copy.headlines.length >= HEADLINES_WANTED && copy.descriptions.length >= DESCRIPTIONS_WANTED;
}

export function isUsable(copy: AdCopy): boolean {
  return copy.headlines.length >= MIN_HEADLINES_REQUIRED && copy.descriptions.length >= MIN_DESCRIPTIONS_REQUIRED;
}

// Parses Claude's JSON answer. Returns undefined if it isn't the expected shape.
export function parseAdCopy(text: string): AdCopy | undefined {
  try {
    const value = JSON.parse(text) as Partial<AdCopy>;
    if (!value || typeof value !== 'object') return undefined;
    return cleanAdCopy({ headlines: value.headlines as string[], descriptions: value.descriptions as string[] });
  } catch {
    return undefined;
  }
}
