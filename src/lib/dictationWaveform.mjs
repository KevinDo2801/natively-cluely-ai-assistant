/**
 * Display shaping for the overlay dictation waveform.
 *
 * Pure and side-effect free: the component owns the React state, this module owns
 * the numbers, so the mapping from a meter level to a bar height is unit-testable
 * without rendering anything (which matters — the waveform is the one part of
 * this feature that cannot be verified by typecheck, lint or a source assertion).
 *
 * LEVEL → HEIGHT IS NOT LINEAR, ON PURPOSE. `computeRmsLevel` (main process)
 * returns RMS/10000 clamped to 1, which is the SAME scale the Settings > Audio
 * meter shows — the two must not diverge, so the boost lives here instead of in
 * the shared meter math. On that scale ordinary speech sits around 0.1–0.4:
 * a linear bar (`3 + level * 23`) drew 5–12px inside a 28px track, so the
 * waveform looked like a thin thread floating in an empty bar. Anchoring 0 at the
 * meter's own silence floor and taking a square root spreads normal speech across
 * roughly half to two thirds of the track while quiet moments still collapse to
 * the smallest bar.
 */

/** The meter level treated as "silence". Mirrors the clamp the renderer applies
 *  to incoming levels; anything at or below it draws the minimal dot. */
export const DICTATION_SILENCE_FLOOR = 0.04;

/** Bar height at silence and at full scale, in px.
 *
 *  MAX must equal the waveform track's inner height so a clipping level truly
 *  fills the bar, and MIN must stay a visible share of it: the bar is 42px tall
 *  with a 1px border, so the track is 40px. An earlier 3px/28px pair left the
 *  silence state as a hairline floating in the middle of the bar with dead space
 *  above it — the waveform has to read as a waveform even at rest. */
export const DICTATION_BAR_MIN_PX = 6;
export const DICTATION_BAR_MAX_PX = 40;

/** Square root: a gentle compression that lifts mid levels without letting
 *  near-silence read as activity. */
export const DICTATION_BAR_CURVE_EXPONENT = 0.5;

/** Bars in the scrolling waveform. 44 × (2px bar + 2px gap) ≈ 176px, which fits
 *  the composer at every width the overlay shell can take. */
export const DICTATION_BAR_COUNT = 44;

/**
 * Height in px for one bar at meter `level` (0..1).
 *
 * Monotonic and continuous: level 0 → MIN, level 1 → MAX, and the meter's own
 * silence floor maps exactly to MIN so a quiet room reads as a flat dotted line
 * rather than a half-drawn waveform.
 */
export function dictationBarHeight(level) {
  const safe = Number.isFinite(level) ? Math.max(0, level) : 0;
  const span = 1 - DICTATION_SILENCE_FLOOR;
  const above = safe <= DICTATION_SILENCE_FLOOR ? 0 : Math.min(1, (safe - DICTATION_SILENCE_FLOOR) / span);
  const shaped = Math.pow(above, DICTATION_BAR_CURVE_EXPONENT);
  return DICTATION_BAR_MIN_PX + shaped * (DICTATION_BAR_MAX_PX - DICTATION_BAR_MIN_PX);
}

/** A flat, silent waveform — the state before any audio has arrived. */
export function createDictationLevels() {
  return Array(DICTATION_BAR_COUNT).fill(0);
}

/**
 * Push one meter reading into the scrolling window: drop the oldest bar, append
 * the new one, floored at the silence level.
 *
 * A non-finite or out-of-range reading is coerced rather than rejected — the
 * value crosses an IPC boundary, so a malformed one must not be able to blank the
 * waveform or grow a bar past its track.
 */
export function pushDictationLevel(levels, level) {
  const base = Array.isArray(levels) && levels.length === DICTATION_BAR_COUNT
    ? levels
    : createDictationLevels();
  const safe = Number.isFinite(level) ? Math.min(1, Math.max(0, level)) : 0;
  return [...base.slice(1), Math.max(DICTATION_SILENCE_FLOOR, safe)];
}
