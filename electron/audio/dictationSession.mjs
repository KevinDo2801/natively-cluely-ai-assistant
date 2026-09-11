/**
 * One-shot voice DICTATION for the overlay composer: press record, speak, press
 * stop, get text — as opposed to the meeting pipeline, which streams a live
 * transcript for the whole session.
 *
 * WHY THIS EXISTS AS A SEPARATE MODULE
 * It reuses the exact same two halves the meeting pipeline uses (the native
 * MicrophoneCapture and the user-configured STT provider from
 * `createSTTProvider('user')`), but it drives them for a bounded, single-purpose
 * session whose ONLY output is one string. Keeping that lifecycle here — instead
 * of inlining it next to startMeeting — means:
 *   - the stop/cancel/finalize race is testable with fake capture+STT emitters,
 *   - the native capture, the STT provider and the level sink are all injected,
 *     so no Electron/native import is reachable from this file and no platform
 *     branch is needed (device/permission handling already lives behind
 *     MicrophoneCapture and the caller's permission probe).
 *
 * NOT a platform-specific module: it must behave identically on macOS and
 * Windows. Anything that genuinely differs per platform (TCC prompts, device
 * enumeration, the cpal/WASAPI handle behind MicrophoneCapture) stays outside.
 */

import { mergeTranscriptChunks } from '../../src/lib/transcriptMerge.mjs';

/**
 * After the last audio chunk is handed over, a streaming provider still has to
 * flush its socket buffer and run its own end-of-utterance detection before it
 * emits the final segment. 2.5s is the same order as the meetin pipeline's
 * draining grace window: long enough for a real final, short enough that a
 * provider that died mid-session cannot hang the composer.
 */
export const DICTATION_FINALIZE_GRACE_MS = 2500;

/**
 * Hard ceiling on one dictation session. The native capture keeps the OS
 * microphone held for as long as it runs (macOS orange indicator, Windows
 * device handle), so a session the user walked away from must not stay open
 * forever. On expiry the session stops itself and returns whatever it has.
 */
export const DICTATION_MAX_MS = 5 * 60_000;

/**
 * RMS of a 16-bit mono PCM chunk, normalised to 0..1 — the waveform's input.
 *
 * Deliberately the SAME math (and the same 10-sample stride) the Settings >
 * Audio level meter uses, so a given microphone reads identically in both
 * places; a user who calibrated their gain in Settings sees the same bar height
 * while dictating. The divisor 10000 maps a fairly loud 16-bit signal to 1.0
 * and clamps above it, rather than using the true 32767 full scale, which left
 * normal speech pegged in the bottom fifth of the meter.
 */
export function computeRmsLevel(chunk) {
  // Hardened over the Settings > Audio copy: a 1-byte buffer would make
  // readInt16LE throw a RangeError inside the main process. Sub-sample input is
  // never audio, so it is silence.
  if (!chunk || chunk.length < 2) return 0;
  let sum = 0;
  const step = 10;
  const len = chunk.length;
  for (let i = 0; i + 1 < len; i += 2 * step) {
    const val = chunk.readInt16LE(i);
    sum += val * val;
  }
  // NOT floored: this must stay bit-identical to main.ts's computeRmsLevel, so
  // the waveform and the Settings meter agree sample for sample.
  const count = len / (2 * step);
  if (count <= 0) return 0;
  const rms = Math.sqrt(sum / count);
  return Math.min(rms / 10000, 1.0);
}

/**
 * Placeholder returned by stop() when the session never recorded anything.
 * Exported so callers can compare without re-declaring the literal.
 */
export const DICTATION_EMPTY_TEXT = '';

/**
 * Owns one dictation session: capture → STT → text.
 *
 * @param {object} deps
 * @param {(deviceId?: string) => any} deps.createCapture  MicrophoneCapture factory
 * @param {() => any} deps.createStt                        STT provider factory ('user' channel)
 * @param {(level: number) => void} [deps.emitLevel]        waveform sink, 0..1
 * @param {(result: { text: string, error: Error | null }) => void} [deps.onAutoStop]
 * @param {number} [deps.finalizeGraceMs]
 * @param {number} [deps.maxMs]
 * @param {() => number} [deps.now]
 * @param {(fn: () => void, ms: number) => any} [deps.setTimer]
 * @param {(handle: any) => void} [deps.clearTimer]
 */
export function createDictationSession(deps) {
  const {
    createCapture,
    createStt,
    emitLevel,
    onAutoStop,
    finalizeGraceMs = DICTATION_FINALIZE_GRACE_MS,
    maxMs = DICTATION_MAX_MS,
    now = () => Date.now(),
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (handle) => clearTimeout(handle),
  } = deps || {};

  let capture = null;
  let stt = null;
  let active = false;
  /** Set once stop()/cancel() has begun, so a late capture chunk cannot append
   *  audio to an STT socket we are already closing down. */
  let closing = false;
  let text = '';
  /** Last non-final segment, used only when NO final ever arrived — several
   *  providers (and every socket that drops mid-utterance) end a short phrase
   *  with partials only, and returning '' there would lose the words. */
  let lastPartial = '';
  let firstError = null;
  let maxTimer = null;
  let startedAt = 0;
  /** Bytes handed to the provider. Zero means the user never spoke (or the
   *  microphone delivered nothing), and stop() can return immediately instead
   *  of waiting out a flush that has no audio behind it. */
  let writtenBytes = 0;
  /** Segment counters — diagnostics only (they make a stubbed/partial-only
   *  provider obvious in the log). */
  let finalSegments = 0;
  let partialSegments = 0;
  /** Resolver for the grace wait in stop(); called by the first final segment
   *  to arrive after finalize() so a responsive provider is not made to wait
   *  out the whole grace window. */
  let graceResolve = null;
  let graceTimer = null;

  const levelSink = typeof emitLevel === 'function' ? emitLevel : () => {};

  const clearMaxTimer = () => {
    if (maxTimer !== null) {
      try { clearTimer(maxTimer); } catch { /* timer host already gone */ }
      maxTimer = null;
    }
  };

  const detachListeners = () => {
    try { capture?.removeAllListeners?.(); } catch { /* ignore */ }
    try { stt?.removeAllListeners?.(); } catch { /* ignore */ }
  };

  /**
   * Unwind a session that failed to START (the microphone threw). Nothing was
   * captured, so there is no audio worth finalizing: the provider is stopped
   * outright rather than asked to transcribe. Awaitable — the native capture's
   * stop() resolves only once the OS-side device handle is actually released,
   * which is what lets an immediate retry reopen the microphone.
   */
  const abortFailedStart = async () => {
    clearMaxTimer();
    const dyingCapture = capture;
    const dyingStt = stt;
    capture = null;
    stt = null;
    active = false;
    closing = true;
    detachListeners();

    try { dyingStt?.stop?.(); } catch { /* best-effort teardown */ }
    try { dyingStt?.removeAllListeners?.(); } catch { /* ignore */ }
    try {
      // disablePreWarm BEFORE stop(): MicrophoneCapture's post-teardown pre-warm
      // would otherwise construct a fresh native monitor and re-open the cpal
      // input stream right after we released it — relighting the macOS mic
      // indicator with no session to justify it. Same discipline as endMeeting.
      dyingCapture?.disablePreWarm?.();
      await dyingCapture?.stop?.();
    } catch { /* best-effort teardown */ }
    try { dyingCapture?.destroy?.(); } catch { /* best-effort teardown */ }
  };

  const onTranscript = (segment) => {
    // NOT gated on `closing`: stop() deliberately keeps listening through its
    // grace window, and the segment it is waiting for arrives precisely while
    // closing is true. Only the audio WRITE path is gated (see the 'data'
    // handler) — that is the one that must not outlive the flush request.
    if (!segment) return;
    const segmentText = typeof segment.text === 'string' ? segment.text : '';
    if (!segmentText.trim()) return;
    if (segment.isFinal) {
      text = mergeTranscriptChunks(text, segmentText);
      finalSegments++;
      // A final that lands during the grace window releases stop() early.
      if (graceResolve) {
        const resolve = graceResolve;
        graceResolve = null;
        if (graceTimer !== null) {
          try { clearTimer(graceTimer); } catch { /* timer host already gone */ }
          graceTimer = null;
        }
        resolve();
      }
      return;
    }
    lastPartial = segmentText;
    partialSegments++;
  };

  const onError = (err) => {
    if (firstError) return;
    const wrapped = err instanceof Error ? err : new Error(String(err));
    // Silence from a provider that never produced a single segment is already
    // reported to the user by the caller through the empty-text path; an error
    // that arrives AFTER we have text must not discard it.
    firstError = wrapped;
    if (graceResolve) {
      const resolve = graceResolve;
      graceResolve = null;
      if (graceTimer !== null) {
        try { clearTimer(graceTimer); } catch { /* timer host already gone */ }
        graceTimer = null;
      }
      resolve();
    }
  };

  const startedSession = {
    /**
     * Begin capturing. Throws (after cleaning up anything already opened) when
     * the microphone or the STT provider cannot be brought up, so the caller
     * can surface a real message instead of a session that silently records
     * nothing.
     */
    start(deviceId) {
      if (active) throw new Error('Dictation is already running.');
      if (typeof createCapture !== 'function') throw new Error('Dictation is unavailable: no microphone capture factory.');

      text = '';
      lastPartial = '';
      firstError = null;
      writtenBytes = 0;
      finalSegments = 0;
      partialSegments = 0;
      closing = false;
      startedAt = now();

      const nextStt = createStt ? createStt() : null;
      if (!nextStt) {
        // No provider configured ('none' in Settings > Audio, or a provider whose
        // key is missing). Recording would produce audio nobody can transcribe,
        // so fail before the microphone is opened at all.
        throw new Error('Speech-to-text is not configured. Choose an STT provider in Settings, then try again.');
      }
      stt = nextStt;

      try {
        stt.on?.('transcript', onTranscript);
        stt.on?.('error', onError);
        stt.start?.();
      } catch (err) {
        try { stt.stop?.(); } catch { /* best-effort teardown */ }
        try { stt.removeAllListeners?.(); } catch { /* ignore */ }
        stt = null;
        onError(err);
        throw err instanceof Error ? err : new Error(String(err));
      }

      try {
        capture = createCapture(deviceId);
      } catch (err) {
        capture = null;
        try { stt.stop?.(); } catch { /* ignore */ }
        detachListeners();
        stt = null;
        throw err instanceof Error ? err : new Error(String(err));
      }

      capture.on?.('data', (chunk) => {
        if (!active || closing) return;
        if (!chunk || chunk.length === 0) return;
        // Level FIRST: the waveform must keep moving even if the provider's
        // socket is unhappy, otherwise a transcript outage looks like a dead mic.
        try { levelSink(computeRmsLevel(chunk)); } catch { /* sink is a UI detail */ }
        try { stt?.write?.(chunk); writtenBytes += chunk.length; } catch (err) { onError(err); }
      });
      capture.on?.('speech_ended', () => {
        if (!active || closing) return;
        // Providers that flush on end-of-speech (RestSTT, the WS VAD ones) rely
        // on this to emit their segment before the user presses stop.
        try { stt?.notifySpeechEnded?.(); } catch (err) { onError(err); }
      });
      capture.on?.('error', onError);
      capture.on?.('sample_rate_changed', (rate) => {
        try { stt?.setSampleRate?.(rate); } catch { /* provider may not support it */ }
      });

      active = true;

      try {
        capture.start();
      } catch (err) {
        onError(err);
        void abortFailedStart();
        throw err instanceof Error ? err : new Error(String(err));
      }

      maxTimer = setTimer(() => {
        console.warn(`[Dictation] Session hit the ${Math.round(maxMs / 1000)}s ceiling — stopping.`);
        // Fire-and-forget: the timer callback cannot be awaited. Notify the
        // owner when teardown completes so its UI cannot remain stuck in the
        // recording state after this safety ceiling fires.
        void startedSession.stop().then((result) => {
          try { onAutoStop?.(result); } catch { /* UI notification is best effort */ }
        });
      }, maxMs);

      return { startedAt };
    },

    get isActive() { return active; },

    get elapsedMs() { return active ? now() - startedAt : 0; },

    /**
     * Stop capturing and RETURN the transcription.
     *
     * Resolves with `{ text, error }` — never rejects, because "the provider
     * dropped but we still have half a sentence" must reach the composer as
     * text, not as a UI error state.
     */
    async stop() {
      if (!active) return { text, error: firstError };
      closing = true;
      active = false;
      clearMaxTimer();

      // 1. Stop the microphone first. Any chunk still in flight would otherwise
      //    be written to an STT socket we are about to finalize, landing after
      //    its end-of-stream marker and getting dropped (or worse, reordering).
      const dyingCapture = capture;
      capture = null;
      try {
        dyingCapture?.disablePreWarm?.();
        await dyingCapture?.stop?.();
      } catch { /* best-effort */ }
      try { dyingCapture?.destroy?.(); } catch { /* best-effort */ }
      try { dyingCapture?.removeAllListeners?.(); } catch { /* ignore */ }

      // 2. Ask the provider for its trailing segment, then wait — bounded — for
      //    it to arrive. Skipped entirely when no audio ever reached the
      //    provider: there is nothing to flush, and making the user wait 2.5s
      //    for an empty recording reads as a hang.
      const dyingStt = stt;
      if (dyingStt) {
        if (writtenBytes > 0) {
          const waitForFinal = new Promise((resolve) => {
            graceResolve = resolve;
            graceTimer = setTimer(() => {
              if (graceResolve === resolve) graceResolve = null;
              graceTimer = null;
              resolve();
            }, finalizeGraceMs);
          });
          try { dyingStt.finalize?.(); } catch (err) { onError(err); }
          await waitForFinal;
          graceResolve = null;
          if (graceTimer !== null) {
            try { clearTimer(graceTimer); } catch { /* timer host already gone */ }
            graceTimer = null;
          }
        } else {
          console.log('[Dictation] No audio reached the STT provider — skipping the flush wait.');
        }
      }
      stt = null;

      // 3. Tear the provider down.
      try { dyingStt?.stop?.(); } catch { /* best-effort */ }
      try { dyingStt?.removeAllListeners?.(); } catch { /* ignore */ }

      console.log(`[Dictation] Stopped: ${finalSegments} final segment(s), ${partialSegments} partial(s), ${(text.trim() || lastPartial.trim()).length} chars, error=${firstError ? firstError.message : 'none'}`);
      return { text: text.trim() || lastPartial.trim(), error: firstError };
    },

    /**
     * Abandon the session: release the microphone and DISCARD the audio WITHOUT
     * asking the provider to transcribe it. Nothing is sent to `finalize()` — the
     * user asked for the words to be thrown away, so paying for an upload (and
     * waiting on it) would be pure waste.
     *
     * The provider is still closed through `stop()` rather than dropped: an
     * abrupt socket teardown is what triggers reconnect storms in the streaming
     * providers (they are built to survive a clean stop, not a severed one).
     */
    async cancel() {
      if (!active && !capture && !stt) return { text: '' };
      closing = true;
      const dyingCapture = capture;
      const dyingStt = stt;
      capture = null;
      stt = null;
      active = false;
      clearMaxTimer();
      graceResolve = null;
      if (graceTimer !== null) {
        try { clearTimer(graceTimer); } catch { /* timer host already gone */ }
        graceTimer = null;
      }

      // Remove listeners from the LOCAL refs — the fields are already null, so
      // detachListeners() would be a no-op here and a late chunk from the dying
      // capture could still reach a provider mid-close.
      try { dyingCapture?.removeAllListeners?.(); } catch { /* ignore */ }
      try { dyingStt?.removeAllListeners?.(); } catch { /* ignore */ }
      try { dyingCapture?.disablePreWarm?.(); } catch { /* ignore */ }
      try { await dyingCapture?.stop?.(); } catch { /* best-effort */ }
      try { dyingCapture?.destroy?.(); } catch { /* ignore */ }
      try { dyingStt?.stop?.(); } catch { /* best-effort */ }

      text = '';
      lastPartial = '';
      firstError = null;
      writtenBytes = 0;
      console.log('[Dictation] Cancelled — audio discarded, microphone released.');
      return { text: '' };
    },
  };

  return startedSession;
}
