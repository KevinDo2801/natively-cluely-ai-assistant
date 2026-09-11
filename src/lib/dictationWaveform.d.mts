/**
 * Types for src/lib/dictationWaveform.mjs — display shaping and bar geometry for
 * the overlay dictation waveform.
 */

/** The meter level treated as silence; anything at or below it draws the minimum bar. */
export const DICTATION_SILENCE_FLOOR: number;
export const DICTATION_BAR_MIN_PX: number;
export const DICTATION_BAR_MAX_PX: number;
export const DICTATION_BAR_CURVE_EXPONENT: number;
export const DICTATION_BAR_WIDTH_PX: number;
export const DICTATION_BAR_GAP_PX: number;
export const DICTATION_MIN_BAR_COUNT: number;

/** How many bars fit `width` px, so the waveform spans the composer. */
export function dictationBarCount(width: number): number;

/** Height in px for one bar at meter `level` (0..1). */
export function dictationBarHeight(level: number): number;

/** A flat, silent waveform of `count` bars (DICTATION_MIN_BAR_COUNT by default). */
export function createDictationLevels(count?: number): number[];

/**
 * Re-shape a level window to `count` bars. Shrinking drops the OLDEST readings
 * from the front and growing prepends silence, so the visible waveform stays
 * anchored to the right edge across a composer resize.
 */
export function resizeDictationLevels(levels: number[] | unknown, count: number): number[];

/**
 * Drop the oldest bar and append `level` (clamped to 0..1, floored at the silence
 * level). Length-preserving.
 */
export function pushDictationLevel(levels: number[] | unknown, level: number): number[];
