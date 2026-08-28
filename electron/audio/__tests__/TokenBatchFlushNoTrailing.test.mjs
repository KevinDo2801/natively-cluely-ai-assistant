import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mainPath = path.resolve(__dirname, '../../../electron/main.ts');
const mainSource = readFileSync(mainPath, 'utf8');

function extractAround(needle, before = 200, after = 1500) {
  const idx = mainSource.indexOf(needle);
  assert.ok(idx >= 0, `could not locate ${needle}`);
  return mainSource.slice(Math.max(0, idx - before), idx + after);
}

test('clearImmediate semantics match the patch: a queued flush is cancellable, and a re-arm after flush still fires', () => {
  // Behavioral proof that the patch shape works against Node's own setImmediate/clearImmediate.
  // Mirrors the patched flushBatchesNow / scheduleBatchFlush / queueBatch closure in main.ts.
  const sent = [];
  const tokenBatches = new Map();
  let pendingFlushHandle = null;
  let batchFlushScheduled = false;
  const send = (kind, items) => sent.push({ kind, items });
  const flushBatchesNow = () => {
    if (pendingFlushHandle) {
      clearImmediate(pendingFlushHandle);
      pendingFlushHandle = null;
    }
    batchFlushScheduled = false;
    for (const [kind, items] of tokenBatches.entries()) {
      if (items.length > 0) send(kind, items.slice());
    }
    tokenBatches.clear();
  };
  const scheduleBatchFlush = () => {
    if (batchFlushScheduled) return;
    batchFlushScheduled = true;
    pendingFlushHandle = setImmediate(() => {
      pendingFlushHandle = null;
      batchFlushScheduled = false;
      flushBatchesNow();
    });
  };
  const queueBatch = (kind, item) => {
    let arr = tokenBatches.get(kind);
    if (!arr) { arr = []; tokenBatches.set(kind, arr); }
    arr.push(item);
    scheduleBatchFlush();
  };

  queueBatch('suggested_answer', { token: 'a' });
  queueBatch('suggested_answer', { token: 'b' });
  flushBatchesNow(); // synchronous final-answer barrier
  const finalMarker = { kind: 'final', payload: 'X' };
  sent.push(finalMarker);

  return new Promise((resolve) => {
    setImmediate(() => {
      try {
        // The cancelled flush must NOT have fired after the final marker.
        const finalIndex = sent.indexOf(finalMarker);
        assert.ok(finalIndex >= 0, 'final marker must be present');
        const trailingBatches = sent.slice(finalIndex + 1).filter((s) => s.kind === 'suggested_answer');
        assert.equal(trailingBatches.length, 0, 'BUG: trailing token batch landed after the final answer.');

        // Producer enqueues again after flush — must schedule a fresh setImmediate that fires.
        queueBatch('suggested_answer', { token: 'c' });
        setImmediate(() => {
          try {
            const reArm = sent.filter((s) => s.kind === 'suggested_answer');
            assert.equal(reArm.length, 2, 'BUG: re-armed flush after final answer must deliver one new batch with one token.');
            assert.deepEqual(reArm[1].items, [{ token: 'c' }], 'BUG: re-armed flush must contain only the post-final token.');
            resolve();
          } catch (e) {
            resolve(Promise.reject(e));
          }
        });
      } catch (e) {
        resolve(Promise.reject(e));
      }
    });
  });
});

test('unified intelligence stream flush cancels its pending setImmediate so trailing tokens cannot land after a final answer', () => {
  // UNIFIED PIPELINE (C6): the inline tokenBatches closure was replaced by
  // IntelligenceStreamBatcher (see electron/intelligence/unified/streamBus.ts
  // + UnifiedStreamBus.test.mjs for the behavioral contract). main.ts must
  // wire it with the same flush-then-final semantics.
  const region = extractAround('new IntelligenceStreamBatcher((events: IntelligenceStreamEvent[]) => {', 100, 1_800);

  assert.ok(
    /'intelligence-stream', events/.test(region),
    'BUG: the unified batcher must deliver the intelligence-stream channel.',
  );
  // sendToMeetingSurfaces covers BOTH the overlay and the launcher with
  // dedupe. getMainWindow() is deliberately NOT used: it returns the launcher
  // whenever no meeting is active, which delivers to the launcher twice and
  // to the overlay zero times — the overlay bubble then blinks forever.
  assert.ok(
    /sendToMeetingSurfaces\(\s*'intelligence-stream', events\s*\)/.test(region),
    'BUG: the unified channel must reach BOTH the overlay and the launcher (sendToMeetingSurfaces), not getMainWindow() only.',
  );
  assert.ok(
    !/sendToWindow\(mainWindow\(\),\s*'intelligence-stream'/.test(region),
    'BUG: the unified channel must not route through getMainWindow() — it misses the overlay when no meeting is active.',
  );
  // The unified done/meta helpers must flush pending tokens before emitting.
  const helperRegion = extractAround('const unifiedDone = (', 100, 1_400);
  assert.ok(
    /flushUnifiedBeforeFinal\(\)/.test(helperRegion),
    'BUG: unifiedDone must flush pending token batches before the final answer.',
  );
  const metaRegion = extractAround('const unifiedMeta = (', 100, 1_400);
  assert.ok(
    /flushUnifiedBeforeFinal\(\)/.test(metaRegion),
    'BUG: unifiedMeta must flush pending token batches before the meta event.',
  );
});

test('manual-chat / phone / search streams are piped from the intelligence stream bus into the unified batcher', () => {
  // UNIFIED PIPELINE (C6-bugfix): _geminiChatStreamHandler, the phone-mirror
  // path and _searchRunner all emit through appState.getIntelligenceStreamBus()
  // (streamBus.emitToken/Done/Error). If setupIntelligenceEvents never
  // subscribes that bus and pipes it into the same unifiedBatcher that reaches
  // the renderer, a manual-chat turn emits into the void: the placeholder
  // bubble blinks forever with no answer. This test pins the wiring.
  const region = extractAround('const unifiedBatcher = new IntelligenceStreamBatcher', 200, 2_200);

  // The bus subscription must feed the SAME batcher that sends to windows.
  assert.ok(
    /intelligenceStreamBus\s*\.\s*on\s*\(\s*['"]event['"]\s*,/.test(region),
    'BUG: the intelligence stream bus must be subscribed so manual-chat/phone/search events reach the renderer.',
  );
  assert.ok(
    /unifiedBatcher\s*\.\s*push\(/.test(region),
    'BUG: the bus subscription must push each event into the unified batcher.',
  );
  assert.ok(
    /const pipeBus\s*=/.test(region),
    'BUG: expected a named bus→batcher pipe (const pipeBus = (event) => unifiedBatcher.push(event)).',
  );
});
