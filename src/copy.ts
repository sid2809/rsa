import Anthropic from '@anthropic-ai/sdk';
import type { Db } from './db.ts';
import { SYSTEM_PROMPT, AD_COPY_SCHEMA, userMessage, parseAdCopy } from './adcopy.ts';
import { MODEL, COPY_MAX_ATTEMPTS, COPY_MAX_TOKENS, type Wave } from './config.ts';
import { log } from './log.ts';

// The parts of the Anthropic client this file uses (tests pass a fake).
export interface BatchClient {
  create(requests: BatchRequest[]): Promise<{ id: string }>;
  status(id: string): Promise<{ ended: boolean; counts: Record<string, number> }>;
  results(id: string): AsyncIterable<BatchResult>;
}

export interface BatchRequest {
  custom_id: string;
  params: Record<string, unknown>;
}

export interface BatchResult {
  custom_id: string;
  type: 'succeeded' | 'errored' | 'canceled' | 'expired';
  text?: string; // the answer's text, when succeeded
  stopReason?: string | null;
  error?: string;
}

export function anthropicBatchClient(apiKey: string): BatchClient {
  const client = new Anthropic({ apiKey, maxRetries: 6 });
  return {
    async create(requests) {
      const batch = await client.messages.batches.create({ requests: requests as never });
      return { id: batch.id };
    },
    async status(id) {
      const batch = await client.messages.batches.retrieve(id);
      return { ended: batch.processing_status === 'ended', counts: { ...batch.request_counts } };
    },
    async *results(id) {
      for await (const entry of await client.messages.batches.results(id)) {
        const result = entry.result;
        if (result.type === 'succeeded') {
          const text = result.message.content
            .filter((block): block is Anthropic.TextBlock => block.type === 'text')
            .map((block) => block.text)
            .join('');
          yield { custom_id: entry.custom_id, type: 'succeeded', text, stopReason: result.message.stop_reason };
        } else if (result.type === 'errored') {
          yield { custom_id: entry.custom_id, type: 'errored', error: JSON.stringify(result.error).slice(0, 300) };
        } else {
          yield { custom_id: entry.custom_id, type: result.type };
        }
      }
    },
  };
}

export function buildRequest(article: { row_index: number; title: string; keyword: string; url: string }): BatchRequest {
  return {
    custom_id: `a${article.row_index}`,
    params: {
      model: MODEL,
      max_tokens: COPY_MAX_TOKENS,
      system: SYSTEM_PROMPT,
      output_config: { format: { type: 'json_schema', schema: AD_COPY_SCHEMA } },
      messages: [{ role: 'user', content: userMessage(article) }],
    },
  };
}

// Sends one batch with every article of the wave that still needs copy (none already in a batch).
export async function submitCopyBatch(db: Db, client: BatchClient, wave: Wave): Promise<void> {
  const todo = db.articlesNeedingCopy(wave, COPY_MAX_ATTEMPTS);
  if (todo.length === 0) return;
  const { id } = await client.create(todo.map(buildRequest));
  // Saved before waiting, so a restart polls this batch instead of sending a new one.
  db.addBatch(id, todo.map((a) => a.url));
  log(`ad copy: batch ${id} sent with ${todo.length} articles (${wave})`);
}

// Checks every open batch; when one has ended, stores its results.
export async function collectCopyBatches(db: Db, client: BatchClient): Promise<void> {
  for (const id of db.openBatches()) {
    const status = await client.status(id);
    if (!status.ended) {
      log(`ad copy: batch ${id} still running ${JSON.stringify(status.counts)}`);
      continue;
    }
    let ok = 0;
    let retry = 0;
    let bad = 0;
    for await (const result of client.results(id)) {
      const index = Number(result.custom_id.slice(1));
      const article = db.articleByIndex(index);
      if (!article || article.batch_id !== id) continue;
      if (result.type !== 'succeeded') {
        db.recordCopy(article.url, undefined, `batch result ${result.type}${result.error ? `: ${result.error}` : ''}`, COPY_MAX_ATTEMPTS);
        retry++;
        continue;
      }
      if (result.stopReason === 'refusal') {
        db.recordCopy(article.url, undefined, 'Claude refused', COPY_MAX_ATTEMPTS);
        retry++;
        continue;
      }
      const copy = parseAdCopy(result.text ?? '');
      // When an answer can't be used, keep why and how it started, so the Output tab shows what Haiku returned.
      const snippet = (result.text ?? '').replace(/\s+/g, ' ').slice(0, 150);
      const error = copy
        ? `only ${copy.headlines.length} headlines / ${copy.descriptions.length} descriptions passed the checks`
        : `answer was not valid JSON (stop_reason ${result.stopReason ?? 'unknown'}): ${snippet}`;
      if (!copy) bad++;
      db.recordCopy(article.url, copy, error, COPY_MAX_ATTEMPTS);
      ok++;
    }
    db.closeBatch(id);
    log(`ad copy: batch ${id} ended: ${ok} answers (${bad} not readable as JSON), ${retry} errors`);
  }
}
