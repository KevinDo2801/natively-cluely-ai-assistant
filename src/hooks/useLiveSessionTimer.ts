import { useEffect, useState } from 'react';
import { resolveLiveSessionStartMs } from '../utils/liveSessionStart';

/**
 * Live "Active Session" recording timer.
 *
 * Returns the number of ms elapsed since the current recording session began,
 * ticking once per second while `isLive` is true (0 otherwise). The anchor is
 * re-resolved on every tick from the live meeting row's start + the
 * localStorage session anchor with staleness protection (see
 * src/utils/liveSessionStart.ts) — resolving per tick (a parseInt + Date.parse,
 * negligible) keeps the timer correct even when the anchor source changes
 * mid-session (e.g. a "Continue this session" writes a fresh localStorage
 * anchor while the row keeps its original start) and guarantees the timer can
 * never jump to a phantom 800+ minute count from a stale leftover anchor.
 */
export function useLiveSessionTimer(isLive: boolean, rowStartIso?: string | null): number {
  const [elapsedMs, setElapsedMs] = useState(0);

  useEffect(() => {
    if (!isLive) {
      setElapsedMs(0);
      return;
    }
    const tick = () => {
      const anchorMs = resolveLiveSessionStartMs(rowStartIso);
      setElapsedMs(Math.max(0, Date.now() - anchorMs));
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [isLive, rowStartIso]);

  return elapsedMs;
}
