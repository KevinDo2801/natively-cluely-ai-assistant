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
  return { speaker, text, timestamp: ts, final: true, confidence: 1 };
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
