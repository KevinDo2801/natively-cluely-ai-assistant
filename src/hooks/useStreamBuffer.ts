import { useRef, useCallback } from 'react';
import { createPacerState, tickPacer } from '../lib/textRevealPacing.mjs';

/**
 * Overlay reveal rate. The main chat path is tuned to 400 c/s (MAX_REVEAL_CHARACTERS_PER_SECOND),
 * which finishes a short meeting answer in well under a second — fast enough that a user
 * often never SEES it stream. The chat overlays intentionally reveal slower so a provider
 * that bursts the whole answer still types out visibly, word by word, instead of landing
 * in a single imperceptible paint. Tunable per hook via { maxCharactersPerSecond }.
 */
export const OVERLAY_REVEAL_CHARACTERS_PER_SECOND = 150;

/**
 * useStreamBuffer — Buffers high-frequency streaming tokens and reveals them to React state
 * with a deterministic, rate-capped "typewriter" pace via the shared tickPacer state machine
 * (src/lib/textRevealPacing.mjs).
 *
 * This decouples how fast text is DISPLAYED from how fast the provider emits it: a provider
 * that bursts the entire answer at once still drains smoothly over subsequent frames instead
 * of dumping the backlog into the bubble in one paint. Word/punctuation-aware boundaries, the
 * initial smoothing buffer, and reduced-motion handling all come from tickPacer, so the
 * overlays match the same reveal cadence the main chat already uses.
 *
 * Legacy RAF-batch surface is preserved (plus two additions for deferred completion):
 *   appendToken(token, onFlush)  — accumulate a chunk; onFlush(revealedSoFar) fires each frame
 *                                    as the reveal advances.
 *   getBufferedContent()         — the FULL accumulated text (for reading).
 *   complete(onFinal)            — mark the stream done; onFinal(fullText) fires only once the
 *                                    reveal has genuinely caught up (deferred completion), so a
 *                                    fast provider's tail still types out instead of snapping.
 *   isDraining()                 — true while the reveal ticker still has backlog to reveal or a
 *                                    deferred completion is pending (used to keep the overlay's
 *                                    chatState from being marked idle mid-drain).
 *   reset()                      — cancel the ticker and clear all state. A no-op while a deferred
 *                                    completion is still draining; the pending onFinal callback owns
 *                                    that reset once the reveal catches up.
 */
export function useStreamBuffer(
  options: { maxCharactersPerSecond?: number } = {},
) {
  const maxCharsPerSec =
    options.maxCharactersPerSecond ?? OVERLAY_REVEAL_CHARACTERS_PER_SECOND;

  const bufferRef = useRef<string>('');
  const pacerRef = useRef(createPacerState());
  const rafIdRef = useRef<number | null>(null);
  const lastTsRef = useRef<number | null>(null);
  const onFlushRef = useRef<((content: string) => void) | null>(null);
  const onCompleteRef = useRef<((fullContent: string) => void) | null>(null);
  const completeRequestedRef = useRef(false);

  function reducedMotion() {
    return (
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    );
  }

  function revealTick(ts: number) {
    rafIdRef.current = null;

    if (lastTsRef.current === null) lastTsRef.current = ts;
    const deltaMs = Math.max(1, ts - lastTsRef.current);
    lastTsRef.current = ts;

    tickPacer(pacerRef.current, bufferRef.current, ts, deltaMs, {
      reducedMotion: reducedMotion(),
      ratePerSecond: maxCharsPerSec,
    });

    const revealed = bufferRef.current.slice(0, pacerRef.current.revealedLen);
    onFlushRef.current?.(revealed);

    if (pacerRef.current.revealedLen >= bufferRef.current.length) {
      // Fully caught up — if a completion is pending, finalize now.
      if (completeRequestedRef.current) {
        completeRequestedRef.current = false;
        const cb = onCompleteRef.current;
        onCompleteRef.current = null;
        cb?.(bufferRef.current);
      }
      return;
    }
    // Still backlog left to reveal — keep draining (the typewriter effect).
    if (rafIdRef.current === null) {
      rafIdRef.current = requestAnimationFrame(revealTick);
    }
  }

  function scheduleTick() {
    if (rafIdRef.current === null) {
      rafIdRef.current = requestAnimationFrame(revealTick);
    }
  }

  const appendToken = useCallback(
    (token: string, onFlush: (content: string) => void) => {
      bufferRef.current += token;
      onFlushRef.current = onFlush;
      if (rafIdRef.current === null) {
        // Fresh reveal ticker — reset the frame clock so this stream's first
        // tick gets a clean delta (and a fresh initial-buffer window).
        lastTsRef.current = null;
        scheduleTick();
      }
    },
    [],
  );

  const getBufferedContent = useCallback(() => bufferRef.current, []);

  const complete = useCallback((onFinal: (fullContent: string) => void) => {
    onCompleteRef.current = onFinal;
    completeRequestedRef.current = true;
    if (pacerRef.current.revealedLen >= bufferRef.current.length) {
      // Already fully revealed (incl. the empty/degenerate no-chunk case) —
      // finalize immediately.
      completeRequestedRef.current = false;
      const cb = onCompleteRef.current;
      onCompleteRef.current = null;
      cb?.(bufferRef.current);
    } else if (rafIdRef.current === null) {
      // The ticker self-terminated but backlog remains (e.g. a burst arrived
      // right as the stream ended) — wake it to finish the drain.
      scheduleTick();
    }
  }, []);

  const isDraining = useCallback(
    () => rafIdRef.current !== null || completeRequestedRef.current,
    [],
  );

  const reset = useCallback(() => {
    // While a deferred final commit is still draining, do NOT wipe state — the
    // pending onFinal callback performs the reset once the reveal catches up.
    if (completeRequestedRef.current) return;
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
    bufferRef.current = '';
    pacerRef.current = createPacerState();
    lastTsRef.current = null;
    onFlushRef.current = null;
    onCompleteRef.current = null;
  }, []);

  return { appendToken, getBufferedContent, complete, isDraining, reset };
}
