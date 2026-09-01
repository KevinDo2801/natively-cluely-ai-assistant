// Regression test for the "STT needs attention" pill that appeared on the
// system-audio (interviewer) channel when AssemblyAI was selected.
//
// WHY THIS EXISTS: the app's system-audio capture emits chunks as short as
// 20ms (640 bytes @16kHz mono). AssemblyAI Universal streaming rejects any
// inbound audio frame shorter than 50ms with:
//     Input Duration Violation: 20.0 ms. Expected between 50 and 1000 ms
// Each rejection is surfaced as an STT 'error', which main.ts counts toward a
// 5-consecutive-error threshold and then flips the channel to 'failed',
// rendering the "STT needs attention" pill. Deepgram tolerates short chunks,
// which is why only the AssemblyAI provider showed the pill.
//
// The fix: AssemblyAIStreamingSTT.write() now buffers incoming chunks and only
// forwards frames whose duration lands inside AssemblyAI's 50–1000ms window.
//
// Hermetic: no network. We stub `this.ws` with a fake OPEN socket and a send
// spy (mirrors NativelyProSTTCloseUpstreamTimers.test.mjs), and drive write()
// with 20ms chunks to assert no too-short frame is ever emitted.
//
// BOTH platforms run the exact same JS STT class, so a single test here covers
// darwin and win32 behavior. It must pass for both (they share the bundle).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distRoot = path.resolve(__dirname, '../../../dist-electron/electron/audio');

const { AssemblyAIStreamingSTT } = await import(
    pathToFileURL(path.join(distRoot, 'AssemblyAIStreamingSTT.js')).href);

// 16-bit mono PCM @16000Hz => 32000 bytes/second => 20 bytes/ms.
const BYTES_PER_MS = 32; // 2 bytes/sample * 16000 samples/sec / 1000
const chunk = (ms) => Buffer.alloc(Math.round(ms * BYTES_PER_MS), 0);

// A fake, OPEN WebSocket whose send() records every frame it receives.
function makeFakeWs(sent) {
    return {
        readyState: 1, // WebSocket.OPEN
        send(buf) { sent.push({ bytes: buf.length, ms: buf.length / BYTES_PER_MS }); },
        close() {},
        removeAllListeners() {},
    };
}

test('write() never emits a frame shorter than 50ms (Input Duration guard)', () => {
    const stt = new AssemblyAIStreamingSTT('test-key');
    const sent = [];
    stt.isActive = true;
    stt.sampleRate = 16000;
    stt.ws = makeFakeWs(sent);

    // Three 20ms system-audio chunks = 60ms total.
    stt.write(chunk(20)); // accumulated 20ms — below 50ms floor, must NOT send
    assert.equal(sent.length, 0, 'a single 20ms chunk must never be sent immediately');

    stt.write(chunk(20)); // accumulated 40ms — still below floor
    assert.equal(sent.length, 0, '40ms accumulated must still be held back');

    stt.write(chunk(20)); // accumulated 60ms — now ≥50ms floor, sends one 60ms frame
    assert.equal(sent.length, 1, 'the 60ms frame should be flushed on the 3rd chunk');
    assert.equal(sent[0].ms, 60, `expected one 60ms frame, got ${sent[0].ms}ms`);
    assert.ok(sent[0].ms >= 50 && sent[0].ms <= 1000, 'frame must be inside AssemblyAI window');
});

test('write() accumulates system-audio scale chunks into a full valid frame', () => {
    const stt = new AssemblyAIStreamingSTT('test-key');
    const sent = [];
    stt.isActive = true;
    stt.sampleRate = 16000;
    stt.ws = makeFakeWs(sent);

    // Real system-audio emission: a stream of 640-byte (20ms) chunks.
    const realChunk = chunk(20);
    assert.equal(realChunk.length, 640, '20ms @16kHz mono should be exactly 640 bytes');

    let total = 0;
    for (let i = 0; i < 20; i++) {
        stt.write(realChunk);
        total += 20;
    }
    const sentMs = sent.reduce((s, f) => s + f.ms, 0);
    // Every frame the stub received must be inside AssemblyAI's window.
    for (const f of sent) {
        assert.ok(f.ms >= 50 && f.ms <= 1000,
            `sent a ${f.ms}ms frame — outside AssemblyAI's 50–1000ms window`);
    }
    // Aggregate is preserved (minus at most one sub-50ms tail still buffered).
    assert.ok(sentMs <= total && sentMs >= total - 50,
        `sent ${sentMs}ms but wrote ${total}ms — aggregate audio was dropped (${sentMs} vs ${total})`);
    // We must not have sent 20 tiny frames (the bug) — should be a handful of ≥50ms frames.
    assert.ok(sent.length > 0 && sent.length < 20,
        `expected the 400ms input to coalesce into a few frames, sent ${sent.length} frames`);
});

test('write() never forwards a frame longer than the 1000ms upper bound', () => {
    const stt = new AssemblyAIStreamingSTT('test-key');
    const sent = [];
    stt.isActive = true;
    stt.sampleRate = 16000;
    stt.ws = makeFakeWs(sent);

    // A single 1300ms chunk must be sliced: one 1000ms frame sent, the
    // remaining 300ms (~≥50ms floor) sent as a second frame, never one 1300ms one.
    stt.write(chunk(1300));

    const sentMs = sent.reduce((s, f) => s + f.ms, 0);
    for (const f of sent) {
        assert.ok(f.ms >= 50 && f.ms <= 1000,
            `sent a ${f.ms}ms frame — outside AssemblyAI's 50–1000ms window`);
    }
    assert.equal(sent[0]?.ms, 1000, `expected the first slice to be clamped to 1000ms, got ${sent[0]?.ms}ms`);
    // Aggregate preserved (minus at most one sub-50ms tail).
    assert.ok(sentMs === 1300, `aggregate audio dropped: sent ${sentMs} of 1300ms`);
});

test('stop() clears the frame accumulator so no stale audio leaks out', () => {
    const stt = new AssemblyAIStreamingSTT('test-key');
    const sent = [];
    stt.isActive = true;
    stt.sampleRate = 16000;
    stt.ws = makeFakeWs(sent);

    stt.write(chunk(20)); // buffer 20ms (below floor)
    assert.equal(stt.pendingFrameBytes, 20 * BYTES_PER_MS, 'audio should be held in the accumulator');

    stt.stop();
    assert.equal(stt.pendingFrameBytes, 0, 'stop() must clear the pending frame accumulator');
    assert.equal(stt.pendingFrame.length, 0, 'stop() must clear the pending frame list');
});
