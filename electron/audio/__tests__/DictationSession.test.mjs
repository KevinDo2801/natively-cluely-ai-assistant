/**
 * Unit tests for the one-shot voice-dictation lifecycle
 * (electron/audio/dictationSession.mjs).
 *
 * These tests run on BOTH platforms by construction: the module takes the
 * capture, the STT provider, the level sink and the timers as injected
 * dependencies and contains no `process.platform` branch, so there is no
 * platform branch here to leave uncovered. The genuinely platform-specific
 * halves — the native cpal/WASAPI capture behind MicrophoneCapture and the TCC
 * prompt — are stubbed, and remain covered by their own suites
 * (MicrophoneCapturePreWarmFailed, CaptureStopAwaitable, …).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import {
  computeRmsLevel,
  createDictationSession,
  DICTATION_FINALIZE_GRACE_MS,
  DICTATION_MAX_MS,
} from '../dictationSession.mjs';

// ── Fakes ───────────────────────────────────────────────────────────────────

class FakeCapture extends EventEmitter {
  constructor({ failStart = false, startError = null } = {}) {
    super();
    this.started = false;
    this.startCount = 0;
    this.stopCount = 0;
    this.destroyCount = 0;
    this.preWarmDisabled = 0;
    this.failStart = failStart;
    this.startError = startError;
    this.stopResolvers = [];
  }

  start() {
    this.startCount++;
    if (this.failStart) throw this.startError ?? new Error('no microphone');
    this.started = true;
  }

  stop() {
    this.stopCount++;
    this.started = false;
    return new Promise((resolve) => this.stopResolvers.push(resolve));
  }

  /** Release the (deferred) native teardown, as MicrophoneCapture does. */
  finishStop() {
    const pending = this.stopResolvers.splice(0);
    for (const resolve of pending) resolve();
  }

  destroy() { this.destroyCount++; }

  disablePreWarm() { this.preWarmDisabled++; }
}

class FakeStt extends EventEmitter {
  constructor({ failStart = false } = {}) {
    super();
    this.started = false;
    this.stopped = 0;
    this.finalized = 0;
    this.notifySpeechEndedCount = 0;
    this.bytes = [];
    this.failStart = failStart;
  }

  start() {
    if (this.failStart) throw new Error('stt boom');
    this.started = true;
  }

  write(chunk) { this.bytes.push(chunk); this.emit('write', chunk); }
  stop() { this.stopped++; this.started = false; }
  finalize() { this.finalized++; }
  notifySpeechEnded() { this.notifySpeechEndedCount++; }
  setSampleRate(rate) { this.sampleRate = rate; }
}

/** A controllable timer host so the grace/ceiling waits are deterministic. */
function createTimerHost() {
  const pending = new Map();
  let id = 0;
  return {
    setTimer: (fn, ms) => {
      const handle = ++id;
      pending.set(handle, { fn, ms });
      return handle;
    },
    clearTimer: (handle) => { pending.delete(handle); },
    /** Run every armed timer with `ms <= ceiling`. */
    fireAll(ceiling = Infinity) {
      for (const [handle, entry] of [...pending]) {
        if (entry.ms <= ceiling) {
          pending.delete(handle);
          entry.fn();
        }
      }
    },
    get armedMs() { return [...pending.values()].map((e) => e.ms); },
    get size() { return pending.size; },
  };
}

/** A 16-bit mono PCM chunk. `amplitude` is the peak sample value. */
function pcmChunk(samples, amplitude = 3000) {
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    // Alternating sign so the RMS reflects `amplitude`.
    buf.writeInt16LE(i % 2 === 0 ? amplitude : -amplitude, i * 2);
  }
  return buf;
}

function createHarness(overrides = {}) {
  const capture = new FakeCapture(overrides.capture);
  const stt = overrides.stt === null ? null : new FakeStt(overrides.stt);
  const levels = [];
  const timers = createTimerHost();
  const session = createDictationSession({
    createCapture: () => capture,
    createStt: () => stt,
    emitLevel: (l) => levels.push(l),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    now: overrides.now,
    finalizeGraceMs: overrides.finalizeGraceMs,
    maxMs: overrides.maxMs,
  });
  return { session, capture, stt, levels, timers };
}

// ── computeRmsLevel ─────────────────────────────────────────────────────────

test('computeRmsLevel', async (t) => {
  await t.test('is 0 for empty / undersized / missing input', () => {
    assert.equal(computeRmsLevel(Buffer.alloc(0)), 0);
    assert.equal(computeRmsLevel(Buffer.alloc(1)), 0);
    assert.equal(computeRmsLevel(null), 0);
    assert.equal(computeRmsLevel(undefined), 0);
  });

  await t.test('is 0 for digital silence', () => {
    assert.equal(computeRmsLevel(Buffer.alloc(1600)), 0);
  });

  await t.test('rises with amplitude and clamps at 1', () => {
    const quiet = computeRmsLevel(pcmChunk(1600, 500));
    const loud = computeRmsLevel(pcmChunk(1600, 5000));
    const clipping = computeRmsLevel(pcmChunk(1600, 32000));
    assert.ok(quiet > 0 && quiet < loud, `expected 0 < ${quiet} < ${loud}`);
    assert.ok(loud < 1, `a normal-speaking level should not saturate (got ${loud})`);
    assert.equal(clipping, 1);
  });

  await t.test('matches the Settings > Audio meter math for the same chunk', () => {
    // Duplicated deliberately from main.ts's computeRmsLevel closure: the two
    // MUST agree or the same microphone reads differently in the waveform and
    // in the Settings level meter. If this assertion breaks, one side changed.
    const chunk = pcmChunk(2048, 4000);
    let sum = 0;
    const step = 10;
    for (let i = 0; i < chunk.length; i += 2 * step) {
      const val = chunk.readInt16LE(i);
      sum += val * val;
    }
    const count = chunk.length / (2 * step);
    const expected = Math.min(Math.sqrt(sum / count) / 10000, 1.0);
    assert.equal(computeRmsLevel(chunk), expected);
  });
});

// ── start ───────────────────────────────────────────────────────────────────

test('start', async (t) => {
  await t.test('opens the STT provider before the microphone and reports levels', () => {
    const { session, capture, stt, levels } = createHarness();
    session.start();

    assert.equal(stt.started, true);
    assert.equal(capture.startCount, 1);
    assert.equal(session.isActive, true);

    capture.emit('data', pcmChunk(1600, 4000));
    assert.equal(levels.length, 1);
    assert.ok(levels[0] > 0 && levels[0] <= 1);
    // …and the very same audio reaches the provider, so the waveform cannot
    // outlive the transcript's own input.
    assert.equal(stt.bytes.length, 1);
  });

  await t.test('falls back to the system default device when no id is given', async () => {
    const seen = [];
    const captures = [];
    const stt = new FakeStt();
    const session = createDictationSession({
      createCapture: (deviceId) => {
        seen.push(deviceId);
        const capture = new FakeCapture();
        captures.push(capture);
        return capture;
      },
      createStt: () => stt,
    });
    session.start(undefined);
    const firstCancel = session.cancel();
    captures[0].finishStop();
    await firstCancel;
    session.start('AirPods');
    assert.deepEqual(seen, [undefined, 'AirPods']);
    assert.equal(captures[0].startCount, 1);
    assert.equal(captures[1].startCount, 1);
    const secondCancel = session.cancel();
    captures[1].finishStop();
    await secondCancel;
  });

  await t.test('refuses a second start while one is running', () => {
    const { session, capture } = createHarness();
    session.start();
    assert.throws(() => session.start(), /already running/i);
    // The guard runs BEFORE anything is opened, so the mic was touched once.
    assert.equal(capture.startCount, 1);
  });

  await t.test('throws before touching the microphone when no provider is configured', () => {
    const { session, capture } = createHarness({ stt: null });
    assert.throws(() => session.start(), /Speech-to-text is not configured/);
    assert.equal(capture.startCount, 0, 'the mic must not be opened for audio nobody can transcribe');
    assert.equal(session.isActive, false);
  });

  await t.test('surfaces a capture failure and releases the provider', () => {
    const { session, stt, capture } = createHarness({ capture: { failStart: true } });
    assert.throws(() => session.start(), /no microphone/);
    assert.equal(session.isActive, false);
    assert.equal(stt.stopped, 1, 'the opened STT provider must not be left connected');
    assert.equal(capture.preWarmDisabled, 1);
  });

  await t.test('surfaces a provider failure before the microphone is opened', () => {
    const { session, capture, stt } = createHarness({ stt: { failStart: true } });
    assert.throws(() => session.start(), /stt boom/);
    assert.equal(capture.startCount, 0);
    assert.equal(stt.stopped, 1);
  });

  await t.test('arms the session ceiling', () => {
    const { session, timers } = createHarness();
    session.start();
    assert.deepEqual(timers.armedMs, [DICTATION_MAX_MS]);
  });
});

// ── stop ────────────────────────────────────────────────────────────────────

/**
 * Drive stop() up to the point where it is waiting for the trailing final.
 *
 * Ordering matters and is the whole point of this helper: stop() first awaits
 * the native capture teardown and only THEN arms the flush wait, so a transcript
 * emitted before that tick is not inside the window stop() is listening to —
 * exactly the shape of the real race. Returns the still-pending stop() promise
 * plus a promise that resolves once the flush wait is armed.
 */
function stopAndArmFlush(session, capture) {
  const stopPromise = session.stop();
  capture.finishStop();
  const flushArmed = new Promise((resolve) => setImmediate(resolve));
  return { stopPromise, flushArmed };
}

test('stop', async (t) => {
  await t.test('returns the final transcript and tears everything down', async () => {
    const { session, capture, stt } = createHarness();
    session.start();
    capture.emit('data', pcmChunk(1600, 4000));

    const { stopPromise, flushArmed } = stopAndArmFlush(session, capture);
    await flushArmed;
    stt.emit('transcript', { text: 'hello world', isFinal: true });
    const result = await stopPromise;

    assert.equal(result.text, 'hello world');
    assert.equal(result.error, null);
    assert.equal(stt.finalized, 1, 'the provider must be asked for its trailing segment');
    assert.equal(stt.stopped, 1);
    assert.equal(capture.destroyCount, 1);
    assert.equal(capture.preWarmDisabled, 1, 'pre-warm would relight the mic indicator after teardown');
    assert.equal(session.isActive, false);
  });

  await t.test('waits out the grace window when the provider stays silent', async () => {
    const { session, capture, stt, timers } = createHarness();
    session.start();
    capture.emit('data', pcmChunk(1600, 4000));

    const { stopPromise, flushArmed } = stopAndArmFlush(session, capture);
    await flushArmed;

    // Nothing has arrived: the grace timer must be armed, and stop() must still
    // be pending.
    assert.ok(timers.armedMs.includes(DICTATION_FINALIZE_GRACE_MS));
    let settled = false;
    void stopPromise.then(() => { settled = true; });
    await Promise.resolve();
    assert.equal(settled, false, 'stop() must wait for the trailing final');

    timers.fireAll(DICTATION_FINALIZE_GRACE_MS);
    const result = await stopPromise;
    assert.equal(result.text, '');
    assert.equal(stt.stopped, 1);
  });

  await t.test('does not wait when no audio ever reached the provider', async () => {
    const { session, capture, timers } = createHarness();
    session.start();
    const stopPromise = session.stop();
    capture.finishStop();
    const result = await stopPromise;
    assert.equal(result.text, '');
    assert.equal(timers.size, 0, 'no flush wait for a recording that captured nothing');
  });

  await t.test('joins multiple final segments without duplicating an overlap', async () => {
    const { session, capture, stt } = createHarness();
    session.start();
    capture.emit('data', pcmChunk(1600, 4000));
    // A segment committed while the user was still speaking…
    stt.emit('transcript', { text: 'book a flight to', isFinal: true });

    const { stopPromise, flushArmed } = stopAndArmFlush(session, capture);
    await flushArmed;
    // …and the trailing one whose head repeats the previous tail.
    stt.emit('transcript', { text: 'to Hanoi tomorrow', isFinal: true });
    const result = await stopPromise;

    assert.equal(result.text, 'book a flight to Hanoi tomorrow');
  });

  await t.test('falls back to the last partial when no final ever arrived', async () => {
    const { session, capture, stt, timers } = createHarness();
    session.start();
    capture.emit('data', pcmChunk(1600, 4000));
    stt.emit('transcript', { text: 'send the report', isFinal: false });

    const { stopPromise, flushArmed } = stopAndArmFlush(session, capture);
    await flushArmed;
    timers.fireAll(DICTATION_FINALIZE_GRACE_MS);
    const result = await stopPromise;

    assert.equal(result.text, 'send the report', 'a dropped socket must not lose the words the user saw transcribed');
  });

  await t.test('prefers finals over a stale trailing partial', async () => {
    const { session, capture, stt, timers } = createHarness();
    session.start();
    capture.emit('data', pcmChunk(1600, 4000));
    stt.emit('transcript', { text: 'schedule a meet', isFinal: false });
    stt.emit('transcript', { text: 'schedule a meeting for Friday', isFinal: true });

    const { stopPromise, flushArmed } = stopAndArmFlush(session, capture);
    await flushArmed;
    timers.fireAll(DICTATION_FINALIZE_GRACE_MS);
    const result = await stopPromise;
    assert.equal(result.text, 'schedule a meeting for Friday');
  });

  await t.test('reports a provider error but keeps any text already received', async () => {
    const { session, capture, stt, timers } = createHarness();
    session.start();
    capture.emit('data', pcmChunk(1600, 4000));
    stt.emit('transcript', { text: 'half a sentence', isFinal: true });
    stt.emit('error', new Error('socket reset'));

    const { stopPromise, flushArmed } = stopAndArmFlush(session, capture);
    await flushArmed;
    // No trailing final is coming from a provider that just reset its socket, so
    // the grace window is what ends the wait.
    timers.fireAll(DICTATION_FINALIZE_GRACE_MS);
    const result = await stopPromise;

    assert.equal(result.text, 'half a sentence');
    assert.equal(result.error?.message, 'socket reset');
    assert.equal(stt.finalized, 1, 'the flush request is still issued — the error does not abort the teardown');
  });

  await t.test('keeps listening for the trailing final after closing begins', async () => {
    // Regression guard: onTranscript must NOT be gated on `closing`, or the one
    // segment stop() is waiting for is the one it discards.
    const { session, capture, stt } = createHarness();
    session.start();
    capture.emit('data', pcmChunk(1600, 4000));

    const { stopPromise, flushArmed } = stopAndArmFlush(session, capture);
    await flushArmed;
    stt.emit('transcript', { text: 'arrived during the grace window', isFinal: true });
    const result = await stopPromise;

    assert.equal(result.text, 'arrived during the grace window');
  });

  await t.test('drops audio chunks that arrive after stop began', async () => {
    const { session, capture, stt, timers } = createHarness();
    session.start();
    capture.emit('data', pcmChunk(1600, 4000));
    const before = stt.bytes.length;

    const stopPromise = session.stop();
    // A late chunk from the deferred native teardown. It must not reach the
    // provider, and it must not move the waveform either.
    capture.emit('data', pcmChunk(1600, 4000));
    capture.finishStop();
    await new Promise((resolve) => setImmediate(resolve));
    timers.fireAll(DICTATION_FINALIZE_GRACE_MS);
    await stopPromise;

    assert.equal(stt.bytes.length, before, 'post-stop audio must not land after the flush request');
  });

  await t.test('is safe to call twice', async () => {
    const { session, capture, stt } = createHarness();
    session.start();
    capture.emit('data', pcmChunk(1600, 4000));
    const { stopPromise, flushArmed } = stopAndArmFlush(session, capture);
    await flushArmed;
    stt.emit('transcript', { text: 'once', isFinal: true });
    await stopPromise;

    const second = await session.stop();
    assert.equal(second.text, 'once');
    assert.equal(stt.stopped, 1, 'a second stop must not tear the provider down again');
  });

  await t.test('is safe to call without ever starting', async () => {
    const { session } = createHarness();
    const result = await session.stop();
    assert.equal(result.text, '');
    assert.equal(result.error, null);
  });
});

// ── ceiling ─────────────────────────────────────────────────────────────────

test('session ceiling', async (t) => {
  await t.test('stops itself when the user walks away', async () => {
    let autoResult = null;
    const capture = new FakeCapture();
    const stt = new FakeStt();
    const timers = createTimerHost();
    const session = createDictationSession({
      createCapture: () => capture,
      createStt: () => stt,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      maxMs: 30_000,
      onAutoStop: (result) => { autoResult = result; },
    });
    session.start();
    assert.deepEqual(timers.armedMs, [30_000]);

    capture.emit('data', pcmChunk(1600, 4000));
    timers.fireAll(30_000);
    capture.finishStop();
    // Let stop() arm its provider-flush grace timer, then release that timer.
    await new Promise((resolve) => setImmediate(resolve));
    timers.fireAll(DICTATION_FINALIZE_GRACE_MS);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(session.isActive, false);
    assert.equal(autoResult?.text, '');
    assert.equal(stt.stopped, 1, 'the OS microphone must be released, not held forever');
    assert.equal(capture.stopCount, 1);
  });

  await t.test('clears the ceiling when stopped normally', async () => {
    const { session, capture, timers } = createHarness();
    session.start();
    capture.emit('data', pcmChunk(1600, 4000));
    const stopPromise = session.stop();
    capture.finishStop();
    await new Promise((resolve) => setImmediate(resolve));
    timers.fireAll(DICTATION_FINALIZE_GRACE_MS);
    await stopPromise;
    assert.equal(timers.armedMs.includes(DICTATION_MAX_MS), false, 'the ceiling must not fire into a finished session');
  });
});

// ── cancel ──────────────────────────────────────────────────────────────────

test('cancel', async (t) => {
  await t.test('releases the microphone, discards the audio and never finalizes', async () => {
    const { session, capture, stt } = createHarness();
    session.start();
    capture.emit('data', pcmChunk(1600, 4000));
    stt.emit('transcript', { text: 'discard me', isFinal: true });

    const cancelPromise = session.cancel();
    capture.finishStop();
    const result = await cancelPromise;

    assert.equal(result.text, '');
    assert.equal(stt.finalized, 0, 'a cancelled recording must not be uploaded');
    assert.equal(stt.stopped, 1);
    assert.equal(capture.preWarmDisabled, 1);
    assert.equal(capture.destroyCount, 1);
    assert.equal(session.isActive, false);
  });

  await t.test('a cancel after cancel is a no-op', async () => {
    const { session, capture } = createHarness();
    session.start();
    const firstCancel = session.cancel();
    capture.finishStop();
    await firstCancel;
    const result = await session.cancel();
    assert.equal(result.text, '');
    assert.equal(capture.stopCount, 1);
  });

  await t.test('allows a fresh session afterwards', async () => {
    const { session, capture, stt, levels } = createHarness();
    session.start();
    const firstCancel = session.cancel();
    capture.finishStop();
    await firstCancel;

    session.start();
    capture.emit('data', pcmChunk(1600, 4000));
    const { stopPromise, flushArmed } = stopAndArmFlush(session, capture);
    await flushArmed;
    stt.emit('transcript', { text: 'second try', isFinal: true });
    const result = await stopPromise;

    assert.equal(result.text, 'second try');
    assert.equal(levels.length, 1, 'the waveform must resume on the new session');
  });
});

// ── speech_ended / sample rate ──────────────────────────────────────────────

test('capture event forwarding', async (t) => {
  await t.test('forwards speech_ended so flush-on-silence providers emit early', () => {
    const { session, capture, stt } = createHarness();
    session.start();
    capture.emit('speech_ended');
    assert.equal(stt.notifySpeechEndedCount, 1);
  });

  await t.test('forwards a dynamic sample-rate change', () => {
    const { session, capture, stt } = createHarness();
    session.start();
    capture.emit('sample_rate_changed', 24000);
    assert.equal(stt.sampleRate, 24000);
  });

  await t.test('a provider without notifySpeechEnded/setSampleRate is not fatal', async () => {
    const capture = new FakeCapture();
    const bare = new EventEmitter();
    bare.start = () => {};
    bare.write = () => {};
    bare.stop = () => {};
    const session = createDictationSession({
      createCapture: () => capture,
      createStt: () => bare,
    });
    session.start();
    assert.doesNotThrow(() => {
      capture.emit('speech_ended');
      capture.emit('sample_rate_changed', 48000);
      capture.emit('data', pcmChunk(1600, 4000));
    });
    const cancelPromise = session.cancel();
    capture.finishStop();
    await cancelPromise;
  });
});
