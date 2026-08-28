// Unified pipeline C1 — IntelligenceStreamBus + IntelligenceStreamBatcher tests.
// Pins the supersession semantics the old paths had:
//   F-303 surface scoping (desktop vs phone never supersede),
//   chatStreamRegistry deterministic abort+invalidate,
//   TokenBatchFlushNoTrailing (done/error flush pending tokens first).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  IntelligenceStreamBus,
  IntelligenceStreamBatcher,
  streamKeyFor,
} from '../../../dist-electron/electron/intelligence/unified/streamBus.js';

describe('IntelligenceStreamBus — monotonic ids', () => {
  test('begin() mints strictly increasing ids across surfaces', () => {
    const bus = new IntelligenceStreamBus();
    const a = bus.begin('desktop', 'chat');
    const b = bus.begin('desktop', 'what_to_answer');
    const c = bus.begin('phone', 'chat');
    assert.ok(a.generationId < b.generationId);
    assert.ok(b.generationId < c.generationId);
  });

  test('streamKeyFor is surface:intent', () => {
    assert.equal(streamKeyFor('desktop', 'chat'), 'desktop:chat');
    assert.equal(streamKeyFor('phone', 'chat'), 'phone:chat');
  });
});

describe('IntelligenceStreamBus — F-303 surface-scoped supersession', () => {
  test('a desktop stream does NOT supersede a phone stream on the same intent', () => {
    const bus = new IntelligenceStreamBus();
    const phone = bus.begin('phone', 'chat');
    const desktop = bus.begin('desktop', 'chat');
    // The phone entry must survive the desktop begin() — separate keys.
    assert.equal(bus.isCurrent(phone.generationId, 'phone', 'chat'), true);
    assert.equal(bus.isCurrent(desktop.generationId, 'desktop', 'chat'), true);
  });

  test('newest-wins applies per streamKey only', () => {
    const bus = new IntelligenceStreamBus();
    const first = bus.begin('desktop', 'chat');
    const second = bus.begin('desktop', 'chat');
    assert.equal(bus.isCurrent(first.generationId, 'desktop', 'chat'), false);
    assert.equal(bus.isCurrent(second.generationId, 'desktop', 'chat'), true);
  });

  test('different intents on the same surface are independent keys', () => {
    const bus = new IntelligenceStreamBus();
    const chat = bus.begin('desktop', 'chat');
    const wta = bus.begin('desktop', 'what_to_answer');
    assert.equal(bus.isCurrent(chat.generationId, 'desktop', 'chat'), true);
    assert.equal(bus.isCurrent(wta.generationId, 'desktop', 'what_to_answer'), true);
  });
});

describe('IntelligenceStreamBus — deterministic abort+invalidate (chatStreamRegistry)', () => {
  test('begin() aborts the prior entry AND deletes it', () => {
    const bus = new IntelligenceStreamBus();
    const first = bus.begin('desktop', 'chat');
    let aborted = false;
    first.controller.signal.addEventListener('abort', () => { aborted = true; });
    const second = bus.begin('desktop', 'chat');
    assert.equal(aborted, true, 'prior controller must be aborted');
    assert.equal(bus.currentFor('desktop', 'chat')?.generationId, second.generationId); // replaced by the new entry
    // the isCurrent check must be deterministic-false for the old id
    assert.equal(bus.isCurrent(first.generationId, 'desktop', 'chat'), false);
  });

  test('abortAll() invalidates everything (scoped or not)', () => {
    const bus = new IntelligenceStreamBus();
    const d = bus.begin('desktop', 'chat');
    const p = bus.begin('phone', 'chat');
    assert.equal(bus.abortAll(), 2);
    assert.equal(bus.isCurrent(d.generationId, 'desktop', 'chat'), false);
    assert.equal(bus.isCurrent(p.generationId, 'phone', 'chat'), false);

    const d2 = bus.begin('desktop', 'chat');
    bus.begin('phone', 'chat');
    assert.equal(bus.abortAll('desktop'), 1);
    assert.equal(bus.isCurrent(d2.generationId, 'desktop', 'chat'), false);
    assert.equal(bus.currentFor('phone', 'chat') !== null, true);
  });

  test('end() only deletes when the id still matches (idempotent)', () => {
    const bus = new IntelligenceStreamBus();
    const first = bus.begin('desktop', 'chat');
    const second = bus.begin('desktop', 'chat');
    bus.end(first.generationId, 'desktop', 'chat'); // stale — must not delete the new entry
    assert.equal(bus.isCurrent(second.generationId, 'desktop', 'chat'), true);
    bus.end(second.generationId, 'desktop', 'chat');
    assert.equal(bus.currentFor('desktop', 'chat'), null);
  });
});

describe('IntelligenceStreamBus — claim window (R-17)', () => {
  test('claim/release/hasClaim per surface', () => {
    const bus = new IntelligenceStreamBus();
    assert.equal(bus.hasClaim('desktop'), false);
    bus.claim('desktop');
    assert.equal(bus.hasClaim('desktop'), true);
    assert.equal(bus.hasClaim('phone'), false);
    bus.releaseClaim('desktop');
    assert.equal(bus.hasClaim('desktop'), false);
  });
});

describe('IntelligenceStreamBus — event emission', () => {
  test('emits typed events with streamKey', () => {
    const bus = new IntelligenceStreamBus();
    const seen = [];
    bus.on('event', (e) => seen.push(e));
    const { generationId } = bus.begin('desktop', 'chat');
    bus.emitStart({ generationId, surface: 'desktop', intent: 'chat' });
    bus.emitToken({ generationId, surface: 'desktop', intent: 'chat', text: 'hi' });
    bus.emitDone({ generationId, surface: 'desktop', intent: 'chat', finalText: 'bye', emittedAt: 5, question: 'q' });
    bus.emitError({ generationId, surface: 'desktop', intent: 'chat', error: 'boom' });
    bus.emitMeta({ generationId, surface: 'desktop', intent: 'chat', metaKind: 'code_verified', metaPayload: { passed: 1 } });

    assert.deepEqual(seen.map((e) => e.type), ['start', 'token', 'done', 'error', 'meta']);
    assert.equal(seen[0].streamKey, 'desktop:chat');
    assert.equal(seen[1].text, 'hi');
    assert.equal(seen[2].finalText, 'bye');
    assert.equal(seen[2].emittedAt, 5);
    assert.equal(seen[2].question, 'q');
    assert.equal(seen[4].metaKind, 'code_verified');
  });
});

describe('IntelligenceStreamBatcher — TokenBatchFlushNoTrailing semantics', () => {
  function harness() {
    const flushed = [];
    let scheduled = null;
    const batcher = new IntelligenceStreamBatcher(
      (events) => flushed.push(events),
      (fn) => { scheduled = fn; return { fn }; },
      () => { scheduled = null; },
    );
    return { flushed, batcher, getScheduled: () => scheduled };
  }

  test('token events batch; done/error/meta flush the batch FIRST then emit alone', () => {
    const { flushed, batcher } = harness();
    const ev = (type, text) => ({ type, generationId: 1, surface: 'desktop', intent: 'chat', streamKey: 'desktop:chat', text });
    batcher.push(ev('token', 'a'));
    batcher.push(ev('token', 'b'));
    assert.equal(flushed.length, 0, 'no flush before the tick');

    batcher.push(ev('done', undefined));
    assert.equal(flushed.length, 2);
    assert.deepEqual(flushed[0].map((e) => e.text), ['a', 'b']);
    assert.equal(flushed[1][0].type, 'done');
  });

  test('flushNow emits pending tokens exactly once', () => {
    const { flushed, batcher, getScheduled } = harness();
    const ev = (type, text) => ({ type, generationId: 1, surface: 'desktop', intent: 'chat', streamKey: 'desktop:chat', text });
    batcher.push(ev('token', 'a'));
    assert.ok(getScheduled() !== null, 'a flush is scheduled');
    batcher.flushNow();
    assert.deepEqual(flushed[0].map((e) => e.text), ['a']);
    assert.equal(getScheduled(), null, 'scheduled flush disarmed');
    batcher.flushNow();
    assert.equal(flushed.length, 1, 'second flush is a no-op');
  });

  test('cancelPending drops buffered tokens and disarms', () => {
    const { batcher, getScheduled } = harness();
    const ev = (type, text) => ({ type, generationId: 1, surface: 'desktop', intent: 'chat', streamKey: 'desktop:chat', text });
    batcher.push(ev('token', 'a'));
    batcher.cancelPending();
    assert.equal(getScheduled(), null);
  });

  test('error events never trail behind pending tokens', () => {
    const { flushed, batcher } = harness();
    const ev = (type, text) => ({ type, generationId: 1, surface: 'desktop', intent: 'chat', streamKey: 'desktop:chat', text, error: text });
    batcher.push(ev('token', 'a'));
    batcher.push(ev('error', 'boom'));
    assert.equal(flushed.length, 2);
    assert.deepEqual(flushed[0].map((e) => e.text), ['a']);
    assert.equal(flushed[1][0].type, 'error');
  });
});
