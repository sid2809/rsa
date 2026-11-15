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
  theme?: string | null;
  dish?: string | null;
  tag_attempts?: number;
  tag_batch?: string | null;
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
    // Columns added later (grouping by Haiku, batch kinds). Existing databases get them on start.
    this.addColumn('articles', 'theme', 'TEXT');
    this.addColumn('articles', 'dish', 'TEXT');
    this.addColumn('articles', 'tag_attempts', 'INTEGER NOT NULL DEFAULT 0');
    this.addColumn('articles', 'tag_batch', 'TEXT');
    this.addColumn('batches', 'kind', "TEXT NOT NULL DEFAULT 'copy'");
  }

  private addColumn(table: string, column: string, type: string): void {
    const columns = this.sql.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!columns.some((c) => c.name === column)) this.sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
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

  openBatches(kind: 'copy' | 'tag' | 'themes' | 'extra' = 'copy'): string[] {
    return (this.sql.prepare("SELECT id FROM batches WHERE status = 'open' AND kind = ? ORDER BY created_at").all(kind) as { id: string }[]).map((r) => r.id);
  }

  addOtherBatch(id: string, kind: 'tag' | 'themes' | 'extra', requestCount: number): void {
    this.sql.prepare('INSERT INTO batches (id, created_at, request_count, kind) VALUES (?, ?, ?, ?)').run(id, new Date().toISOString(), requestCount, kind);
  }

  closeOtherBatch(id: string): void {
    this.sql.prepare("UPDATE batches SET status = 'closed' WHERE id = ?").run(id);
  }

  // ---------- grouping (lists without a Campaign column) ----------
  importUngrouped(rows: { url: string; title: string; keyword: string }[]): void {
    const insert = this.sql.prepare("INSERT INTO articles (url, campaign, ad_group, keyword, title, wave, row_index) VALUES (?, '', '', ?, ?, 'rest', ?)");
    this.sql.exec('BEGIN');
    try {
      rows.forEach((row, index) => insert.run(row.url, row.keyword, row.title, index));
      this.sql.exec('COMMIT');
    } catch (error) {
      this.sql.exec('ROLLBACK');
      throw error;
    }
  }

  articlesNeedingTag(maxAttempts: number): ArticleRow[] {
    return this.sql
      .prepare('SELECT * FROM articles WHERE theme IS NULL AND tag_batch IS NULL AND tag_attempts < ? ORDER BY row_index')
      .all(maxAttempts) as unknown as ArticleRow[];
  }

  markTagBatch(id: string, urls: string[]): void {
    this.sql.exec('BEGIN');
    try {
      const mark = this.sql.prepare('UPDATE articles SET tag_batch = ? WHERE url = ?');
      for (const url of urls) mark.run(id, url);
      this.sql.exec('COMMIT');
    } catch (error) {
      this.sql.exec('ROLLBACK');
      throw error;
    }
  }

  recordTag(url: string, theme: string | null, dish: string | null): void {
    if (theme) this.sql.prepare('UPDATE articles SET theme = ?, dish = ?, tag_batch = NULL WHERE url = ?').run(theme, dish, url);
    else this.sql.prepare('UPDATE articles SET tag_attempts = tag_attempts + 1, tag_batch = NULL WHERE url = ?').run(url);
  }

  // Articles still in a closed tag batch without a result go back in the queue.
  releaseTagBatch(id: string): void {
    this.sql.prepare('UPDATE articles SET tag_batch = NULL, tag_attempts = tag_attempts + 1 WHERE tag_batch = ? AND theme IS NULL').run(id);
  }

  untaggedCount(maxAttempts: number): number {
    return (this.sql.prepare('SELECT COUNT(*) AS n FROM articles WHERE theme IS NULL AND (tag_batch IS NOT NULL OR tag_attempts < ?)').get(maxAttempts) as { n: number }).n;
  }

  // Articles Haiku couldn't tag after every try go to "Other", grouped by their keyword.
  tagLeftoversAsOther(): number {
    return Number(this.sql.prepare("UPDATE articles SET theme = 'Other', dish = keyword WHERE theme IS NULL").run().changes);
  }

  // One-time repair (15 Nov 2026): a tag batch was sent without being recorded, so every article was put in
  // "Other" while Haiku was still tagging. If nothing of this grouping is in Google Ads yet, undo it and
  // record the tag batch so its results are collected. Returns the tag batch IDs recovered.
  repairUnrecordedTagBatches(): string[] {
    if (this.get('mode') !== 'grouping' || this.get('grouped') !== '1') return [];
    const used = this.sql.prepare("SELECT COUNT(*) AS n FROM campaigns WHERE status != 'pending' OR campaign_id IS NOT NULL").get() as { n: number };
    if (used.n > 0) return [];
    const ids = (
      this.sql
        .prepare('SELECT DISTINCT tag_batch AS id FROM articles WHERE tag_batch IS NOT NULL AND tag_batch NOT IN (SELECT id FROM batches)')
        .all() as { id: string }[]
    ).map((r) => r.id);
    if (ids.length === 0) return [];
    this.sql.exec('BEGIN');
    try {
      for (const id of ids) {
        const count = (this.sql.prepare('SELECT COUNT(*) AS n FROM articles WHERE tag_batch = ?').get(id) as { n: number }).n;
        this.sql.prepare("INSERT INTO batches (id, created_at, request_count, kind) VALUES (?, ?, ?, 'tag')").run(id, new Date().toISOString(), count);
      }
      this.sql.exec("UPDATE articles SET theme = NULL, dish = NULL, campaign = '', ad_group = '', wave = 'rest' WHERE tag_batch IS NOT NULL");
      this.sql.exec('DELETE FROM campaigns');
      this.sql.exec("DELETE FROM kv WHERE key = 'grouped'");
      this.sql.exec('COMMIT');
    } catch (error) {
      this.sql.exec('ROLLBACK');
      throw error;
    }
    return ids;
  }

  // Nothing of the grouping is in Google Ads yet (no campaign uploaded or failed).
  groupingUntouched(): boolean {
    const used = this.sql.prepare("SELECT COUNT(*) AS n FROM campaigns WHERE status != 'pending' OR campaign_id IS NOT NULL OR attempts > 0").get() as { n: number };
    return used.n === 0;
  }

  // One-time (15 Nov 2026): re-tag the "Other" articles with extra themes Haiku will propose, then group again.
  // Only while nothing of the grouping is in Google Ads. Returns how many articles go back for tagging.
  reopenOtherForRetag(): number {
    if (this.get('mode') !== 'grouping' || this.get('grouped') !== '1' || !this.groupingUntouched()) return 0;
    this.sql.exec('BEGIN');
    try {
      const n = Number(this.sql.prepare("UPDATE articles SET theme = NULL, dish = NULL, tag_attempts = 0, tag_batch = NULL WHERE theme = 'Other'").run().changes);
      this.sql.exec("UPDATE articles SET campaign = '', ad_group = '', wave = 'rest' WHERE wave != 'excluded'");
      this.sql.exec('DELETE FROM campaigns');
      this.sql.exec("DELETE FROM kv WHERE key = 'grouped'");
      this.set('need_extra_themes', '1');
      this.sql.exec('COMMIT');
      return n;
    } catch (error) {
      this.sql.exec('ROLLBACK');
      throw error;
    }
  }

  // Articles left out on purpose: never tagged, grouped, written or uploaded.
  excludeUrls(urls: string[]): number {
    let n = 0;
    const up = this.sql.prepare(
      "UPDATE articles SET wave = 'excluded', campaign = '', ad_group = '', theme = COALESCE(theme, 'Excluded'), copy_status = 'failed', copy_error = 'left out on purpose', ad_status = 'skipped', error = 'left out on purpose' WHERE url = ? AND ad_status != 'uploaded'",
    );
    for (const url of urls) n += Number(up.run(url).changes);
    this.sql.prepare("DELETE FROM campaigns WHERE status = 'pending' AND campaign_id IS NULL AND name NOT IN (SELECT campaign FROM articles WHERE campaign != '')").run();
    return n;
  }

  saveGrouping(assignments: { url: string; campaign: string; adGroup: string; wave: Wave }[]): void {
    this.sql.exec('BEGIN');
    try {
      const up = this.sql.prepare('UPDATE articles SET campaign = ?, ad_group = ?, wave = ? WHERE url = ?');
      const camp = this.sql.prepare('INSERT OR IGNORE INTO campaigns (name, wave) VALUES (?, ?)');
      for (const a of assignments) {
        up.run(a.campaign, a.adGroup, a.wave, a.url);
        camp.run(a.campaign, a.wave);
      }
      this.sql.exec('COMMIT');
    } catch (error) {
      this.sql.exec('ROLLBACK');
      throw error;
    }
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

  // One-time: articles whose copy failed only because the answer couldn't be read as JSON
  // (fixed 10 Nov 2026) get 3 new tries. Returns how many were reset.
  resetUnreadableCopy(): number {
    const result = this.sql
      .prepare(
        `UPDATE articles SET copy_status = 'pending', copy_attempts = 0, batch_id = NULL, copy_error = NULL
         WHERE copy_status = 'failed' AND copy_error LIKE 'answer was not valid JSON%'`,
      )
      .run();
    return Number(result.changes);
  }

  // Uploaded campaigns that have articles with copy now but no ad yet (their copy came after the upload).
  campaignsToTopUp(wave: Wave): CampaignRow[] {
    return this.sql
      .prepare(
        `SELECT c.* FROM campaigns c WHERE c.wave = ? AND c.status = 'uploaded' AND c.campaign_id IS NOT NULL
         AND EXISTS (SELECT 1 FROM articles a WHERE a.campaign = c.name AND a.ad_status = 'skipped' AND a.copy_status = 'done')
         ORDER BY (SELECT MIN(row_index) FROM articles a WHERE a.campaign = c.name)`,
      )
      .all(wave) as unknown as CampaignRow[];
  }

  markAdsAdded(ads: { url: string; adGroupId: string; adId: string }[], leftOut: { url: string; error: string }[]): void {
    this.sql.exec('BEGIN');
    try {
      const up = this.sql.prepare("UPDATE articles SET ad_status = 'uploaded', ad_group_id = ?, ad_id = ?, error = NULL WHERE url = ?");
      for (const ad of ads) up.run(ad.adGroupId, ad.adId, ad.url);
      const out = this.sql.prepare("UPDATE articles SET ad_status = 'error', error = ? WHERE url = ?");
      for (const item of leftOut) out.run(item.error, item.url);
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

  // Records an error on a campaign without using one of its tries (temporary errors).
  noteCampaignError(name: string, error: string): void {
    this.sql.prepare('UPDATE campaigns SET error = ? WHERE name = ?').run(error, name);
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

  // Calls Google refused for quota are not counted against the worker's own cap.
  refundOps(count: number, kind: string): void {
    if (count > 0) this.sql.prepare('INSERT INTO ops (ts, count, kind) VALUES (?, ?, ?)').run(Date.now(), -count, kind);
  }

  // One-time: pending campaigns whose tries were used up by quota or temporary errors get them back.
  resetTemporaryFailures(): number {
    return Number(
      this.sql
        .prepare("UPDATE campaigns SET attempts = 0 WHERE status = 'pending' AND (error LIKE 'quota_error%' OR error LIKE 'database_error%' OR error LIKE 'internal_error%')")
        .run().changes,
    );
  }

  opsLast24h(): number {
    const since = Date.now() - 24 * 3600 * 1000;
    return (this.sql.prepare('SELECT COALESCE(SUM(count), 0) AS n FROM ops WHERE ts > ?').get(since) as { n: number }).n;
  }
}
