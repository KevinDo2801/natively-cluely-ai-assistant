/**
 * Types for src/lib/dictationWaveform.mjs — display shaping for the overlay
 * dictation waveform.
 */

/** The meter level treated as silence; anything at or below it draws the dot. */
export const DICTATION_SILENCE_FLOOR: number;
export const DICTATION_BAR_MIN_PX: number;
export const DICTATION_BAR_MAX_PX: number;
export const DICTATION_BAR_CURVE_EXPONENT: number;
export const DICTATION_BAR_COUNT: number;

/** Height in px for one bar at meter `level` (0..1). */
export function dictationBarHeight(level: number): number;

/** A flat, silent waveform of DICTATION_BAR_COUNT bars. */
export function createDictationLevels(): number[];

/**
 * Drop the oldest bar and append `level` (clamped to 0..1, floored at the
 * silence level). Returns a fresh array of DICTATION_BAR_COUNT bars.
 */
export function pushDictationLevel(levels: number[] | unknown, level: number): number[];
