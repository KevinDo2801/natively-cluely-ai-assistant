// SessionTracker.getRecapContext — transcript-only recap grounding.
//
// ROOT CAUSE this pins: the Recap quick action used to ground on
// `getFormattedContext(120)` (the rolling window), which (a) only covers the
// last ~120s and (b) INCLUDES role === 'assistant' entries — i.e. previous AI
// suggestions. A recap therefore read like chat history / old suggestions
// instead of "what actually happened in the meeting so far".
//
// THE FIX: getRecapContext() reads the DURABLE store (fullTranscript + epoch
// summaries), strips every assistant entry, and labels only INTERVIEWER / ME.
//
// Requires: npm run build:electron.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(__dirname, '../../../dist-electron/electron');
const { SessionTracker } = await import(pathToFileURL(path.join(distDir, 'SessionTracker.js')).href);

function freshTracker() {
  return new SessionTracker();
}

function seg(speaker, text, ts) {
  return { speaker, text, timestamp: ts, final: true, confidence: 1, origin: 'stt' };
}

describe('SessionTracker.getRecapContext (transcript-only recap)', () => {
  test('returns interviewer + user turns in order, labelled INTERVIEWER / ME', () => {
    const s = freshTracker();
    const now = Date.now();
    s.addTranscript(seg('interviewer', 'Can you tell me about your backend scaling experience?', now - 30000));
    s.addTranscript(seg('user', 'I built Lazy Clips and moved it from sequential to parallel workers.', now - 20000));
    s.addTranscript(seg('interviewer', 'How did you identify the bottleneck?', now - 10000));

    const ctx = s.getRecapContext();
    assert.ok(ctx.includes('[INTERVIEWER]: Can you tell me about your backend scaling experience?'));
    assert.ok(ctx.includes('[ME]: I built Lazy Clips and moved it from sequential to parallel workers.'));
    assert.ok(ctx.includes('[INTERVIEWER]: How did you identify the bottleneck?'));
    // Order preserved.
    assert.ok(ctx.indexOf('backend scaling experience') < ctx.indexOf('Lazy Clips'));
    assert.ok(ctx.indexOf('Lazy Clips') < ctx.indexOf('identify the bottleneck'));
  });

  test('EXCLUDES assistant (previous AI suggestion) entries entirely', () => {
    const s = freshTracker();
    const now = Date.now();
    s.addTranscript(seg('interviewer', 'What is the current technical stack?', now - 30000));
    s.addAssistantMessage('A previous AI suggestion about what to say next, stored as an assistant turn.');
    s.addTranscript(seg('user', 'We use TypeScript and Redis.', now - 10000));

    const ctx = s.getRecapContext();
    assert.ok(ctx.includes('What is the current technical stack?'));
    assert.ok(ctx.includes('We use TypeScript and Redis.'));
    assert.ok(!ctx.includes('previous AI suggestion'),
      'recap context must never contain assistant-written text');
    assert.ok(!ctx.includes('ASSISTANT'),
      'recap context must not label any line ASSISTANT');
  });

  test('contrast: getFullSessionContext still includes the assistant turn (recap must NOT use it)', () => {
    const s = freshTracker();
    const now = Date.now();
    s.addTranscript(seg('interviewer', 'What is the current technical stack?', now - 30000));
    s.addAssistantMessage('A previous AI suggestion about what to say next, stored as an assistant turn.');
    s.addTranscript(seg('user', 'We use TypeScript and Redis.', now - 10000));

    assert.ok(s.getFullSessionContext().includes('previous AI suggestion'),
      'full-session context is allowed to contain assistant turns; only recap must strip them');
    assert.ok(!s.getRecapContext().includes('previous AI suggestion'));
  });

  test('reads the DURABLE store: an old turn outside the rolling window still appears', () => {
    const s = freshTracker();
    const now = Date.now();
    s.addTranscript(seg('interviewer', 'A topic raised ten minutes ago, long past the rolling window.', now - 600000));
    s.addTranscript(seg('user', 'And the reply to that old topic, also outside the window.', now - 590000));

    assert.ok(s.getRecapContext().includes('A topic raised ten minutes ago'),
      'recap must span the whole meeting, not just the last 120s');
    assert.ok(!s.getFormattedContext(120).includes('A topic raised ten minutes ago'),
      'control: the rolling window really did evict it — proving recap uses the durable store');
  });

  test('empty session returns empty string (no fabricated recap content)', () => {
    const s = freshTracker();
    assert.equal(s.getRecapContext(), '');
  });
});

describe('SessionTracker.getSttTranscript (transcript persistence = real audio only)', () => {
  test('includes ONLY origin stt/test segments — typed chat and AI answers are excluded', () => {
    const s = freshTracker();
    const now = Date.now();
    s.addTranscript(seg('interviewer', 'What is the current technical stack?', now - 30000));
    s.addTranscript({ speaker: 'user', text: 'A typed manual-chat question (or a quick-action prompt).', timestamp: now - 20000, final: true, confidence: 1, origin: 'manual_chat' });
    s.addAssistantMessage('A previous AI suggestion, stored as an assistant turn.');
    s.addTranscript(seg('user', 'We use TypeScript and Redis.', now - 10000));

    const stt = s.getSttTranscript();
    assert.equal(stt.length, 2, 'only the two real-audio segments survive');
    assert.ok(stt.some((t) => t.text.includes('current technical stack')));
    assert.ok(stt.some((t) => t.text.includes('TypeScript and Redis')));
    assert.ok(!stt.some((t) => t.text.includes('typed manual-chat question')),
      'typed chat must never be persisted as meeting transcript');
    assert.ok(!stt.some((t) => t.text.includes('previous AI suggestion')),
      'assistant answers must never be persisted as meeting transcript');
  });

  test('getFullTranscript still exposes everything for in-session context (recap/persist are the STT-only readers)', () => {
    const s = freshTracker();
    const now = Date.now();
    s.addTranscript(seg('interviewer', 'Spoken interviewer question.', now - 30000));
    s.addTranscript({ speaker: 'user', text: 'A typed manual-chat question.', timestamp: now - 20000, final: true, confidence: 1, origin: 'manual_chat' });
    s.addAssistantMessage('An AI answer that is conversation context, not meeting audio.');
    s.addTranscript(seg('user', 'Spoken user reply.', now - 10000));

    assert.equal(s.getFullTranscript().length, 4, 'full transcript keeps all turns (follow-up context)');
    assert.equal(s.getSttTranscript().length, 2, 'persisted transcript is STT-only');
  });
});

describe('SessionTracker interim STT (recap/persist see the transcript UP TO NOW)', () => {
  // ROOT CAUSE this pins: STT emits partials while the person is speaking and
  // only commits a FINAL after endpoint detection + inference (~1-5s), and
  // SessionTracker.addTranscript drops non-final segments. Clicking Recap
  // right after talking therefore saw an empty/stale transcript ("There's
  // nothing to recap yet") until the final landed seconds later. The STT-only
  // readers append the guarded tail of each speaker's pending interim, so the
  // recap reflects what was ACTUALLY said up to the current moment.

  test('recap includes the user\'s in-flight (not-yet-final) speech immediately', () => {
    const s = freshTracker();
    const now = Date.now();
    s.addTranscript(seg('interviewer', 'What is your experience with scaling systems?', now - 30000));
    // User is mid-utterance: only a partial has arrived, no final yet.
    s.handleTranscript({ speaker: 'user', text: 'I built Lazy Clips and moved it from sequential', timestamp: now, final: false, confidence: 0.9, origin: 'stt' });

    const ctx = s.getRecapContext();
    assert.ok(ctx.includes('[INTERVIEWER]: What is your experience with scaling systems?'));
    assert.ok(ctx.includes('[ME]: I built Lazy Clips and moved it from sequential'),
      'recap must include the just-said, not-yet-final words');
  });

  test('recap includes the interviewer\'s in-flight partial too', () => {
    const s = freshTracker();
    const now = Date.now();
    s.addTranscript(seg('user', 'I used Redis for caching.', now - 20000));
    s.handleTranscript({ speaker: 'interviewer', text: 'How did you handle the cache invalidation', timestamp: now, final: false, confidence: 0.9, origin: 'stt' });

    const ctx = s.getRecapContext();
    assert.ok(ctx.includes('[INTERVIEWER]: How did you handle the cache invalidation'));
  });

  test('the final REPLACES the interim — the view never duplicates speech', () => {
    const s = freshTracker();
    const now = Date.now();
    s.addTranscript(seg('interviewer', 'What is your experience with scaling?', now - 30000));
    s.handleTranscript({ speaker: 'user', text: 'I built Lazy Clips and moved it to parallel workers', timestamp: now - 2000, final: false, confidence: 0.9, origin: 'stt' });

    assert.equal(s.getSttTranscript().length, 2, 'committed final + pending interim');
    assert.ok(s.getSttTranscript().some((t) => !t.final), 'interim entry carries final: false');

    // Final lands moments later — clears the interim and commits once.
    s.handleTranscript({ speaker: 'user', text: 'I built Lazy Clips and moved it to parallel workers.', timestamp: now, final: true, confidence: 0.99, origin: 'stt' });

    const stt = s.getSttTranscript();
    assert.equal(stt.length, 2, 'final replaces the interim — no duplicate entry');
    assert.ok(stt.every((t) => t.final), 'only final segments survive after finalization');
    assert.ok(stt.some((t) => t.text.includes('parallel workers.')));
  });

  test('a stale (>30s) dead interim is skipped — dead speech never enters the recap', () => {
    const s = freshTracker();
    const now = Date.now();
    s.handleTranscript({ speaker: 'user', text: 'This was said a long time ago and never finalized', timestamp: now - 60000, final: false, confidence: 0.9, origin: 'stt' });

    assert.equal(s.getRecapContext(), '');
    assert.equal(s.getSttTranscript().length, 0, 'stale interim must not be appended');
  });

  test('pending interim still excludes typed chat and assistant answers (STT-only invariant holds)', () => {
    const s = freshTracker();
    const now = Date.now();
    s.addTranscript(seg('interviewer', 'Real spoken question.', now - 30000));
    s.addTranscript({ speaker: 'user', text: 'A typed manual-chat question (or quick-action prompt).', timestamp: now - 20000, final: true, confidence: 1, origin: 'manual_chat' });
    s.addAssistantMessage('A previous AI suggestion.');
    s.handleTranscript({ speaker: 'user', text: 'In-flight real spoken answer', timestamp: now, final: false, confidence: 0.9, origin: 'stt' });

    const stt = s.getSttTranscript();
    assert.equal(stt.length, 2, 'interviewer final + pending user interim');
    assert.ok(stt.some((t) => t.text.includes('Real spoken question')));
    assert.ok(stt.some((t) => t.text.includes('In-flight real spoken answer')));
    assert.ok(!stt.some((t) => t.text.includes('typed manual-chat question')), 'typed chat never leaks in');
    assert.ok(!stt.some((t) => t.text.includes('previous AI suggestion')), 'assistant never leaks in');
  });
});
