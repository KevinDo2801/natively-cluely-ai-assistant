// V3 retrieval used to advertise a 1200 ms budget (retrievalPlan.timeoutMs) that
// no port enforced, so a stalled embedder held the whole answer until the
// embedding pipeline's own 30 s timeout. A hang is now a RECORDED failure.
//
// Run with: npm run build:electron && node --test electron/context-intelligence/__tests__/RetrievalCeiling2026_10.test.mjs

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const base = path.resolve(process.cwd(), 'dist-electron/electron/context-intelligence');
const {
  createLegacyRetrievalPort,
  RETRIEVAL_CEILING_MULTIPLIER,
  RETRIEVAL_CEILING_FLOOR_MS,
} = await import(pathToFileURL(path.join(base, 'retrieval/legacy-retrieval-port.js')).href);
const { decide } = await import(pathToFileURL(path.join(base, 'orchestration/orchestrator.js')).href);

const registry = () => ({
  sourceTypes: new Map([['resume-1', 'RESUME']]),
  activeVersions: new Map([['resume-1', 'v1']]),
  chunkVersions: new Map([['resume-1', 'v1']]),
});
const req = (q) => ({
  requestId: 'r1', requestSequence: 1, surface: 'manual-chat',
  modeId: 'technical-interview', scope: { userId: 'u1' }, sessionId: 's1', manualQuestion: q,
});
const QUESTION = 'Tell me about your team leadership experience.';

describe('retrieval ceiling', () => {
  test('the ceiling is generous: 3× the plan budget and never under 3 s', () => {
    assert.equal(RETRIEVAL_CEILING_MULTIPLIER, 3);
    assert.equal(RETRIEVAL_CEILING_FLOOR_MS, 3000);
  });

  test('a retriever that never returns becomes a recorded failure instead of a hang', async () => {
    const t0 = Date.now();
    const p = createLegacyRetrievalPort({
      retrieve: () => new Promise(() => { /* never settles */ }),
      registry: registry(),
      assumeInScopeWhenUnknown: true,
      ceilingMs: 60,
    });
    const r = await p.retrieve({ decision: decide(req(QUESTION)) });
    assert.ok(Date.now() - t0 < 1000, 'must return near the ceiling, not hang');
    assert.deepEqual(r.evidence, []);
    assert.equal(r.attempts.length, 1);
    assert.match(r.attempts[0].failed, /retrieval_ceiling_exceeded/);
  });

  test('a retriever that finishes in time is unaffected', async () => {
    const p = createLegacyRetrievalPort({
      retrieve: async () => [{ sourceId: 'resume-1', text: 'Led a team of 4 engineers', chunkIndex: 0, score: 0.9 }],
      registry: registry(),
      assumeInScopeWhenUnknown: true,
      ceilingMs: 500,
    });
    const r = await p.retrieve({ decision: decide(req(QUESTION)) });
    assert.equal(r.attempts[0].failed, undefined);
    assert.equal(r.evidence.length, 1);
  });

  test('a late rejection after the ceiling does not crash the process', async () => {
    let rejectLater;
    const p = createLegacyRetrievalPort({
      retrieve: () => new Promise((_, reject) => { rejectLater = reject; }),
      registry: registry(),
      assumeInScopeWhenUnknown: true,
      ceilingMs: 30,
    });
    await p.retrieve({ decision: decide(req(QUESTION)) });
    rejectLater(new Error('provider finally failed'));
    await new Promise((r) => setTimeout(r, 30)); // would surface as unhandledRejection
  });

  test('a synchronously throwing retriever is still recorded, not thrown', async () => {
    const p = createLegacyRetrievalPort({
      retrieve: () => { throw new Error('sync boom'); },
      registry: registry(),
      assumeInScopeWhenUnknown: true,
      ceilingMs: 200,
    });
    const r = await p.retrieve({ decision: decide(req(QUESTION)) });
    assert.match(r.attempts[0].failed, /sync boom/);
  });
});
