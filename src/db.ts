import { DatabaseSync } from 'node:sqlite';
import { isComplete, isUsable, type AdCopy } from './adcopy.ts';
import type { Wave } from './config.ts';

// State lives in SQLite on the Railway volume, so a restart never re-creates anything.
//
// Article copy_status: pending -> (in a batch) -> done | failed
// Article ad_status:   pending -> uploaded | error (left out of its ad group) | skipped (no copy)
// Campaign status:     pending -> uploaded | failed

export interface ArticleRow {
  url: string;
  campaign: string;
  ad_group: string;
  keyword: string;
  title: string;
  wave: Wave;
  row_index: number;
  copy_status: 'pending' | 'done' | 'failed';
  copy_attempts: number;
  batch_id: string | null;
  headlines: string | null; // JSON
  descriptions: string | null; // JSON
  copy_error: string | null;
  ad_status: 'pending' | 'uploaded' | 'error' | 'skipped';
  ad_id: string | null;
  ad_group_id: string | null;
  approval: string | null;
  policy_topics: string | null;
  error: string | null;
}

export interface CampaignRow {
  name: string;
  wave: Wave;
  status: 'pending' | 'uploaded' | 'failed';
  campaign_id: string | null;
  attempts: number;
  error: string | null;
  enabled_at: string | null;
  serving_status: string | null;
}

export class Db {
  readonly sql: DatabaseSync;

  constructor(path: string) {
    this.sql = new DatabaseSync(path);
    this.sql.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS articles (
        url TEXT PRIMARY KEY,
        campaign TEXT NOT NULL,
        ad_group TEXT NOT NULL,
        keyword TEXT NOT NULL,
        title TEXT NOT NULL,
        wave TEXT NOT NULL,
        row_index INTEGER NOT NULL,
        copy_status TEXT NOT NULL DEFAULT 'pending',
        copy_attempts INTEGER NOT NULL DEFAULT 0,
        batch_id TEXT,
        headlines TEXT,
        descriptions TEXT,
        copy_error TEXT,
        ad_status TEXT NOT NULL DEFAULT 'pending',
        ad_id TEXT,
        ad_group_id TEXT,
        approval TEXT,
        policy_topics TEXT,
        error TEXT
      );
      CREATE TABLE IF NOT EXISTS campaigns (
        name TEXT PRIMARY KEY,
        wave TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        campaign_id TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        enabled_at TEXT,
        serving_status TEXT
      );
      CREATE TABLE IF NOT EXISTS batches (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        request_count INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS ops (
        ts INTEGER NOT NULL,
        count INTEGER NOT NULL,
        kind TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  // ---------- key/value ----------
  get(key: string): string | undefined {
    const row = this.sql.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value;
  }

  set(key: string, value: string): void {
    this.sql.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  // ---------- input ----------
  articleCount(): number {
    return (this.sql.prepare('SELECT COUNT(*) AS n FROM articles').get() as { n: number }).n;
  }

  importArticles(rows: { url: string; campaign: string; adGroup: string; keyword: string; title: string; wave: Wave }[]): void {
    const insertArticle = this.sql.prepare(
      'INSERT INTO articles (url, campaign, ad_group, keyword, title, wave, row_index) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    const insertCampaign = this.sql.prepare('INSERT OR IGNORE INTO campaigns (name, wave) VALUES (?, ?)');
    this.sql.exec('BEGIN');
    try {
      rows.forEach((row, index) => {
        insertArticle.run(row.url, row.campaign, row.adGroup, row.keyword, row.title, row.wave, index);
        insertCampaign.run(row.campaign, row.wave);
      });
      this.sql.exec('COMMIT');
    } catch (error) {
      this.sql.exec('ROLLBACK');
      throw error;
    }
  }

  // ---------- ad copy ----------
  articlesNeedingCopy(wave: Wave, maxAttempts: number): ArticleRow[] {
    return this.sql
      .prepare(
        `SELECT * FROM articles WHERE wave = ? AND copy_status = 'pending' AND batch_id IS NULL AND copy_attempts < ?
         ORDER BY row_index`,
      )
      .all(wave, maxAttempts) as unknown as ArticleRow[];
  }

  addBatch(id: string, urls: string[]): void {
    this.sql.exec('BEGIN');
    try {
      this.sql.prepare('INSERT INTO batches (id, created_at, request_count) VALUES (?, ?, ?)').run(id, new Date().toISOString(), urls.length);
      const mark = this.sql.prepare('UPDATE articles SET batch_id = ? WHERE url = ?');
      for (const url of urls) mark.run(id, url);
      this.sql.exec('COMMIT');
    } catch (error) {
      this.sql.exec('ROLLBACK');
      throw error;
    }
  }

  openBatches(): string[] {
    return (this.sql.prepare("SELECT id FROM batches WHERE status = 'open' ORDER BY created_at").all() as { id: string }[]).map((r) => r.id);
  }

  closeBatch(id: string): void {
    this.sql.prepare("UPDATE batches SET status = 'closed' WHERE id = ?").run(id);
    // Anything in the batch without a result goes back in the queue (counts as an attempt).
    this.sql
      .prepare(
        `UPDATE articles SET batch_id = NULL, copy_attempts = copy_attempts + 1, copy_error = COALESCE(copy_error, 'no result in batch')
         WHERE batch_id = ? AND copy_status = 'pending'`,
      )
      .run(id);
  }

  articleByIndex(index: number): ArticleRow | undefined {
    return this.sql.prepare('SELECT * FROM articles WHERE row_index = ?').get(index) as unknown as ArticleRow | undefined;
  }

  article(url: string): ArticleRow | undefined {
    return this.sql.prepare('SELECT * FROM articles WHERE url = ?').get(url) as unknown as ArticleRow | undefined;
  }

  // Records one Claude answer. Keeps the best copy seen so far.
  // Done when the copy is complete (15 + 4), or after the last attempt if the best copy is still usable (3 + 2).
  recordCopy(url: string, copy: AdCopy | undefined, error: string | null, maxAttempts: number): void {
    const row = this.article(url);
    if (!row || row.copy_status !== 'pending') return;
    const attempts = row.copy_attempts + 1;
    const previous: AdCopy | undefined = row.headlines ? { headlines: JSON.parse(row.headlines), descriptions: JSON.parse(row.descriptions ?? '[]') } : undefined;
    const size = (c: AdCopy) => c.headlines.length + c.descriptions.length;
    const best = copy && (!previous || size(copy) > size(previous)) ? copy : previous;
    let status: ArticleRow['copy_status'] = 'pending';
    if (best && isComplete(best)) status = 'done';
    else if (attempts >= maxAttempts) status = best && isUsable(best) ? 'done' : 'failed';
    this.sql
      .prepare(
        `UPDATE articles SET copy_attempts = ?, batch_id = NULL, copy_status = ?, headlines = ?, descriptions = ?, copy_error = ?
         WHERE url = ?`,
      )
      .run(
        attempts,
        status,
        best ? JSON.stringify(best.headlines) : null,
        best ? JSON.stringify(best.descriptions) : null,
        status === 'done' ? null : error,
        url,
      );
  }

  waveCopyPending(wave: Wave): number {
    return (this.sql.prepare("SELECT COUNT(*) AS n FROM articles WHERE wave = ? AND copy_status = 'pending'").get(wave) as { n: number }).n;
  }

  // ---------- campaigns ----------
  campaignsToUpload(wave: Wave, maxAttempts: number): CampaignRow[] {
    return this.sql
      .prepare(
        `SELECT c.* FROM campaigns c WHERE c.wave = ? AND c.status = 'pending' AND c.attempts < ?
         AND NOT EXISTS (SELECT 1 FROM articles a WHERE a.campaign = c.name AND a.copy_status = 'pending')
         ORDER BY (SELECT MIN(row_index) FROM articles a WHERE a.campaign = c.name)`,
      )
      .all(wave, maxAttempts) as unknown as CampaignRow[];
  }

  campaign(name: string): CampaignRow | undefined {
    return this.sql.prepare('SELECT * FROM campaigns WHERE name = ?').get(name) as unknown as CampaignRow | undefined;
  }

  campaigns(wave?: Wave): CampaignRow[] {
    if (wave) return this.sql.prepare('SELECT * FROM campaigns WHERE wave = ? ORDER BY name').all(wave) as unknown as CampaignRow[];
    return this.sql.prepare('SELECT * FROM campaigns ORDER BY name').all() as unknown as CampaignRow[];
  }

  articlesOf(campaign: string): ArticleRow[] {
    return this.sql.prepare('SELECT * FROM articles WHERE campaign = ? ORDER BY row_index').all(campaign) as unknown as ArticleRow[];
  }

  allArticles(): ArticleRow[] {
    return this.sql.prepare('SELECT * FROM articles ORDER BY row_index').all() as unknown as ArticleRow[];
  }

  markCampaignUploaded(name: string, campaignId: string, ads: { url: string; adGroupId: string; adId: string }[], leftOut: { url: string; status: 'error' | 'skipped'; error: string }[]): void {
    this.sql.exec('BEGIN');
    try {
      this.sql.prepare("UPDATE campaigns SET status = 'uploaded', campaign_id = ?, error = NULL WHERE name = ?").run(campaignId, name);
      const up = this.sql.prepare("UPDATE articles SET ad_status = 'uploaded', ad_group_id = ?, ad_id = ?, error = NULL WHERE url = ?");
      for (const ad of ads) up.run(ad.adGroupId, ad.adId, ad.url);
      const out = this.sql.prepare('UPDATE articles SET ad_status = ?, error = ? WHERE url = ?');
      for (const item of leftOut) out.run(item.status, item.error, item.url);
      this.sql.exec('COMMIT');
    } catch (error) {
      this.sql.exec('ROLLBACK');
      throw error;
    }
  }

  markCampaignAttemptFailed(name: string, error: string, maxAttempts: number): void {
    const row = this.campaign(name);
    if (!row) return;
    const attempts = row.attempts + 1;
    this.sql.prepare('UPDATE campaigns SET attempts = ?, error = ?, status = ? WHERE name = ?').run(attempts, error, attempts >= maxAttempts ? 'failed' : 'pending', name);
  }

  markEnabled(name: string): void {
    this.sql.prepare('UPDATE campaigns SET enabled_at = ? WHERE name = ?').run(new Date().toISOString(), name);
  }

  setCampaignServing(campaignId: string, status: string): void {
    this.sql.prepare('UPDATE campaigns SET serving_status = ? WHERE campaign_id = ?').run(status, campaignId);
  }

  setAdApproval(adId: string, approval: string, topics: string): void {
    this.sql.prepare('UPDATE articles SET approval = ?, policy_topics = ? WHERE ad_id = ?').run(approval, topics, adId);
  }

  // ---------- API quota ----------
  addOps(count: number, kind: string): void {
    if (count > 0) this.sql.prepare('INSERT INTO ops (ts, count, kind) VALUES (?, ?, ?)').run(Date.now(), count, kind);
  }

  opsLast24h(): number {
    const since = Date.now() - 24 * 3600 * 1000;
    return (this.sql.prepare('SELECT COALESCE(SUM(count), 0) AS n FROM ops WHERE ts > ?').get(since) as { n: number }).n;
  }
}
