// Turns an article list into the Input tab file: the repo's grouping, then this project's naming and pilot.
//
//   node scripts/group.ts articles.csv input.csv
//
// articles.csv columns: URL, Title, Keywords (one keyword per row). Output columns: Campaign, Ad Group, Keyword, Title, URL, Wave.
//
// Naming (decided 10 Nov 2026):
//   Campaign  "Ponly Faith | <Bible book of its first ad group, or that ad group's theme> | 0001"
//   Ad group  the repo's name (the topic, e.g. "1 chronicles 1")
// Pilot: whole campaigns from the start until at least 100 articles.
import { readFileSync, writeFileSync } from 'node:fs';
import { buildCampaigns, type Article } from './lib/group.ts';

export const CAMPAIGN_LABEL = 'Ponly Faith';
export const PILOT_MIN_ARTICLES = 100;

const BOOKS = [
  'genesis', 'exodus', 'leviticus', 'numbers', 'deuteronomy', 'joshua', 'judges', 'ruth', '1 samuel', '2 samuel', '1 kings', '2 kings',
  '1 chronicles', '2 chronicles', 'ezra', 'nehemiah', 'esther', 'job', 'psalms', 'psalm', 'proverbs', 'ecclesiastes', 'song of solomon',
  'song of songs', 'isaiah', 'jeremiah', 'lamentations', 'ezekiel', 'daniel', 'hosea', 'joel', 'amos', 'obadiah', 'jonah', 'micah', 'nahum',
  'habakkuk', 'zephaniah', 'haggai', 'zechariah', 'malachi', 'matthew', 'mark', 'luke', 'john', 'acts', 'romans', '1 corinthians',
  '2 corinthians', 'galatians', 'ephesians', 'philippians', 'colossians', '1 thessalonians', '2 thessalonians', '1 timothy', '2 timothy',
  'titus', 'philemon', 'hebrews', 'james', '1 peter', '2 peter', '1 john', '2 john', '3 john', 'jude', 'revelation',
].sort((a, b) => b.length - a.length);

const capitalize = (text: string) => text.split(' ').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

export function campaignTheme(adGroupName: string): string {
  const lower = adGroupName.toLowerCase();
  for (const book of BOOKS) {
    if (lower === book || lower.startsWith(`${book} `)) return capitalize(book === 'psalm' ? 'psalms' : book);
  }
  return capitalize(adGroupName);
}

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  text = text.replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

const csvCell = (value: string) => (/[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);

// https://ponly.com/faith/bible-verses-about-love/ -> "Faith" (as in the repo's input.ts)
function category(url: string): string {
  const first = new URL(url).pathname.split('/').filter(Boolean)[0];
  return first ? first.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ') : 'General';
}

export function buildInput(csvText: string): string[][] {
  const [header, ...body] = parseCsv(csvText);
  const index = (name: string) => header.findIndex((h) => h.trim().toLowerCase() === name);
  const [u, t, k] = [index('url'), index('title'), index('keywords') >= 0 ? index('keywords') : index('keyword')];
  if (u < 0 || t < 0 || k < 0) throw new Error('articles.csv needs URL, Title and Keywords columns');
  const seen = new Set<string>();
  const articles: Article[] = [];
  for (const r of body) {
    const url = r[u].trim();
    if (!url.startsWith('http') || seen.has(url) || !r[t].trim() || !r[k].trim()) continue;
    seen.add(url);
    articles.push({ url, title: r[t].trim(), keyword: r[k].trim(), category: category(url) });
  }

  const out: string[][] = [['Campaign', 'Ad Group', 'Keyword', 'Title', 'URL', 'Wave']];
  let count = 0;
  buildCampaigns(articles).forEach((campaign, i) => {
    const name = `${CAMPAIGN_LABEL} | ${campaignTheme(campaign.adGroups[0].name)} | ${String(i + 1).padStart(4, '0')}`;
    const wave = count < PILOT_MIN_ARTICLES ? 'pilot' : 'rest';
    for (const adGroup of campaign.adGroups) {
      for (const a of adGroup.articles) {
        out.push([name, adGroup.name, a.keyword, a.title, a.url, wave]);
        count++;
      }
    }
  });
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) {
    console.error('Usage: node scripts/group.ts articles.csv input.csv');
    process.exit(1);
  }
  const rows = buildInput(readFileSync(input, 'utf8'));
  writeFileSync(output, rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n', 'utf8');
  console.log(`Wrote ${rows.length - 1} articles to ${output}`);
}
