// Source-structural regression test for src/hooks/useStreamBuffer.ts.
//
// The overlay chat components (MeetingChatOverlay, GlobalChatOverlay) reveal
// AI answers through this hook, which uses requestAnimationFrame + the shared
// deterministic pacer (tickPacer) under the hood — so it can't be unit-driven
// from a plain node test without a DOM/clock. Like ragStreamChunkCoalescing,
// this pins the invariants a regression could silently break:
//   1. It must pace via the shared tickPacer (rate-capped typewriter), not dump
//      the whole buffered backlog into a single paint.
//   2. `complete` must DEFER the final commit until the reveal has caught up
//      (so a fast provider's tail still types out instead of snapping), rather
//      than finalizing the instant the stream signals done.
//   3. `reset` must be a no-op while a deferred completion is still draining,
//      otherwise the overlays' finally-block reset would kill a mid-drain reveal.
//   4. `isDraining` must exist so the overlays can keep chatState from being
//      flipped to idle before the drain completes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(
  path.resolve(__dirname, '../../hooks/useStreamBuffer.ts'),
  'utf8',
);

test('uses the shared deterministic pacer (createPacerState + tickPacer), not a bespoke batching formula', () => {
  assert.match(source, /import \{\s*createPacerState,\s*tickPacer\s*\} from/, 'must import the shared pacer state machine');
  assert.match(source, /pacerRef = useRef\(createPacerState\(\)\)/, 'must own a per-stream pacer state');
  assert.match(source, /tickPacer\(pacerRef\.current, bufferRef\.current, ts, deltaMs, \{/, 'must pace each frame via tickPacer');
  assert.match(source, /ratePerSecond: maxCharsPerSec/, 'must pass the reveal rate through to tickPacer');
});

test('reveal is a cursor over the accumulated text — commits the revealed prefix, never an append delta', () => {
  assert.match(source, /const revealed = bufferRef\.current\.slice\(0, pacerRef\.current\.revealedLen\)/, 'must slice the revealed prefix of the full accumulated text');
  assert.match(source, /onFlushRef\.current\?\.\(revealed\)/, 'must push the revealed prefix, not the whole buffer');
});

test('complete defers the final commit until the reveal has caught up (no instant snap on done)', () => {
  assert.match(source, /const complete = useCallback\(\(onFinal: \(fullContent: string\) => void\) => \{/, 'complete must exist');
  assert.match(source, /if \(pacerRef\.current\.revealedLen >= bufferRef\.current\.length\) \{/, 'finalize only once the reveal caught up to the full text');
  assert.match(source, /completeRequestedRef\.current = false;/, 'must clear the pending-complete flag before invoking onFinal');
  assert.match(source, /cb\?\.\(bufferRef\.current\)/, 'the caught-up branch must invoke the finalize callback');
  assert.match(source, /wake it to finish the drain/, 'must wake a self-terminated ticker so a late burst still drains to the end');
});

test('reset is a no-op while a deferred completion is draining (protects a mid-drain reveal from the finally reset)', () => {
  assert.match(source, /if \(completeRequestedRef\.current\) return;/, 'reset must bail early while a final commit is pending');
});

test('isDraining reports both a live ticker and a pending deferred completion', () => {
  assert.match(source, /rafIdRef\.current !== null \|\| completeRequestedRef\.current/, 'must treat a running ticker or pending complete as draining');
});

test('revealTick keeps rescheduling while backlog remains (self-terminates once caught up)', () => {
  assert.match(source, /if \(pacerRef\.current\.revealedLen >= bufferRef\.current\.length\) \{/, 'must branch on the reveal-vs-arrived cursor');
  assert.match(source, /requestAnimationFrame\(revealTick\)/, 'must reschedule the reveal ticker while backlog remains');
});
