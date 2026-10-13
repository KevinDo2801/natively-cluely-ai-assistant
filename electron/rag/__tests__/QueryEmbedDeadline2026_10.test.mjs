// Interactive query embedding is raced against a deadline so a slow embedder
// degrades the caller (lexical ranking / no recall) instead of stalling it ~30 s.
//
// Run with: npm run build:electron && node --test electron/rag/__tests__/QueryEmbedDeadline2026_10.test.mjs

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const dist = path.resolve(process.cwd(), 'dist-electron/electron');
const { EmbeddingPipeline, QUERY_EMBED_DEADLINE_MS } = await import(pathToFileURL(path.join(dist, 'rag/EmbeddingPipeline.js')).href);
const { RAGRetriever } = await import(pathToFileURL(path.join(dist, 'rag/RAGRetriever.js')).href);

// The method only needs getEmbeddingForQuery, so a prototype-only instance
// avoids constructing a database-backed pipeline.
const pipelineWith = (getEmbeddingForQuery) => {
  const p = Object.create(EmbeddingPipeline.prototype);
  p.getEmbeddingForQuery = getEmbeddingForQuery;
  return p;
};

describe('getEmbeddingForQueryWithin', () => {
  test('default deadline is interactive (seconds), far below the 30 s indexing timeout', () => {
    assert.ok(QUERY_EMBED_DEADLINE_MS >= 250 && QUERY_EMBED_DEADLINE_MS <= 5000);
  });

  test('returns the embedding when the provider answers in time', async () => {
    const p = pipelineWith(async () => [0.1, 0.2]);
    assert.deepEqual(await p.getEmbeddingForQueryWithin('q', 200), [0.1, 0.2]);
  });

  test('rejects at the deadline when the provider is slow', async () => {
    const p = pipelineWith(() => new Promise((resolve) => setTimeout(() => resolve([1]), 400)));
    const t0 = Date.now();
    await assert.rejects(p.getEmbeddingForQueryWithin('q', 40), /interactive deadline/);
    assert.ok(Date.now() - t0 < 300);
  });

  test('propagates a provider failure unchanged', async () => {
    const p = pipelineWith(async () => { throw new Error('429 rate limited'); });
    await assert.rejects(p.getEmbeddingForQueryWithin('q', 200), /429 rate limited/);
  });

  test('the underlying call is NOT cancelled (failover bookkeeping stays intact)', async () => {
    let settled = false;
    const p = pipelineWith(() => new Promise((resolve) => setTimeout(() => { settled = true; resolve([1]); }, 80)));
    await assert.rejects(p.getEmbeddingForQueryWithin('q', 20));
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(settled, true);
  });

  test('a late rejection after the deadline does not become an unhandled rejection', async () => {
    const p = pipelineWith(() => new Promise((_, reject) => setTimeout(() => reject(new Error('late')), 60)));
    await assert.rejects(p.getEmbeddingForQueryWithin('q', 20));
    await new Promise((r) => setTimeout(r, 100));
  });
});

describe('RAGRetriever uses the deadline', () => {
  const retriever = (pipeline) => new RAGRetriever({ searchSimilar: async () => [], searchSummaries: async () => [] }, pipeline);

  test('a slow embedder yields EMPTY context (caller falls through) instead of hanging', async () => {
    const pipeline = pipelineWith(() => new Promise((resolve) => setTimeout(() => resolve([1]), 500)));
    const r = retriever(pipeline);
    const t0 = Date.now();
    // Use the deadline-aware path with a tiny deadline via the pipeline stub.
    pipeline.getEmbeddingForQueryWithin = (text) => EmbeddingPipeline.prototype.getEmbeddingForQueryWithin.call(pipeline, text, 30);
    const out = await r.retrieve('what was decided', { meetingId: 'm' });
    assert.ok(Date.now() - t0 < 300);
    assert.deepEqual(out.chunks, []);
  });

  test('pipelines that only implement the plain method keep working (mocks, older callers)', async () => {
    const pipeline = { getEmbeddingForQuery: async () => [1, 0], getActiveSpaceKey: () => 's' };
    const r = retriever(pipeline);
    const out = await r.retrieve('q', {});
    assert.deepEqual(out.chunks, []); // no candidates, but it reached the store without throwing
  });
});
