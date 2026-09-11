/**
 * Unit tests for the dictation waveform's display shaping.
 *
 * These lock in the two properties that were visibly wrong in the UI: silence
 * must collapse to a dot (no half-drawn waveform), and ordinary speech must fill
 * a useful share of the 28px track instead of drawing a thin thread.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DICTATION_BAR_COUNT,
  DICTATION_BAR_MAX_PX,
  DICTATION_BAR_MIN_PX,
  DICTATION_SILENCE_FLOOR,
  createDictationLevels,
  dictationBarHeight,
  pushDictationLevel,
} from '../dictationWaveform.mjs';

test('dictationBarHeight', async (t) => {
  await t.test('collapses silence to the smallest bar — never to nothing', () => {
    assert.equal(dictationBarHeight(0), DICTATION_BAR_MIN_PX);
    assert.equal(dictationBarHeight(DICTATION_SILENCE_FLOOR), DICTATION_BAR_MIN_PX);
    // Below the floor is still silence — a negative RMS is not physically
    // meaningful but must not shrink the bar past the minimum.
    assert.equal(dictationBarHeight(0.01), DICTATION_BAR_MIN_PX);
    assert.equal(dictationBarHeight(-5), DICTATION_BAR_MIN_PX);
    // A resting waveform must still LOOK like a waveform: the minimum has to be
    // a real share of the track, not a hairline with dead space above it.
    const track = DICTATION_BAR_MAX_PX - DICTATION_BAR_MIN_PX;
    assert.ok(
      DICTATION_BAR_MIN_PX / DICTATION_BAR_MAX_PX >= 0.12,
      `silence bar is only ${DICTATION_BAR_MIN_PX}/${DICTATION_BAR_MAX_PX} tall`,
    );
    assert.ok(track > 0);
  });

  await t.test('fills the track at full scale and never exceeds it', () => {
    assert.equal(dictationBarHeight(1), DICTATION_BAR_MAX_PX);
    assert.equal(dictationBarHeight(5), DICTATION_BAR_MAX_PX);
    // MAX must equal the track height, or a clipping level leaves a gap.
    assert.equal(DICTATION_BAR_MAX_PX, 40, 'track = 42px bar minus its 1px border');
  });

  await t.test('spreads ordinary speech across the track', () => {
    const track = DICTATION_BAR_MAX_PX - DICTATION_BAR_MIN_PX;
    const share = (level) => (dictationBarHeight(level) - DICTATION_BAR_MIN_PX) / track;
    // The levels real speech produces on the shared RMS/10000 scale. The old
    // linear mapping drew these at 8–30% of the track, which read as empty
    // space above a thin line.
    assert.ok(share(0.1) > 0.2 && share(0.1) < 0.35, `level 0.1 got ${share(0.1)}`);
    assert.ok(share(0.2) > 0.35 && share(0.2) < 0.5, `level 0.2 got ${share(0.2)}`);
    assert.ok(share(0.4) > 0.55 && share(0.4) < 0.7, `level 0.4 got ${share(0.4)}`);
    assert.ok(share(0.7) > 0.75, `level 0.7 got ${share(0.7)}`);
  });

  await t.test('rises monotonically', () => {
    let previous = -Infinity;
    for (let level = 0; level <= 1; level += 0.01) {
      const height = dictationBarHeight(level);
      assert.ok(height >= previous, `height fell at level ${level}`);
      previous = height;
    }
  });

  await t.test('coerces non-finite input instead of producing NaN heights', () => {
    // NaN in a CSS height silently drops the declaration (the bar would either
    // vanish or keep a stale height), so it must never leave this function.
    for (const bad of [NaN, Infinity, -Infinity, undefined, null, '0.5']) {
      const height = dictationBarHeight(bad);
      assert.ok(Number.isFinite(height), `height for ${String(bad)} was ${height}`);
      assert.ok(height >= DICTATION_BAR_MIN_PX && height <= DICTATION_BAR_MAX_PX);
    }
    assert.equal(dictationBarHeight(NaN), DICTATION_BAR_MIN_PX);
  });
});

test('createDictationLevels', async (t) => {
  await t.test('is a flat, empty waveform', () => {
    const levels = createDictationLevels();
    assert.equal(levels.length, DICTATION_BAR_COUNT);
    assert.ok(levels.every((l) => l === 0));
  });

  await t.test('returns a fresh array each call', () => {
    const a = createDictationLevels();
    const b = createDictationLevels();
    a[0] = 1;
    assert.equal(b[0], 0, 'a shared array would let one session leak into the next');
  });
});

test('pushDictationLevel', async (t) => {
  await t.test('scrolls: drops the oldest bar and appends the newest', () => {
    const levels = createDictationLevels();
    levels[0] = 0.9;
    const next = pushDictationLevel(levels, 0.5);
    assert.equal(next.length, DICTATION_BAR_COUNT);
    assert.equal(next[DICTATION_BAR_COUNT - 1], 0.5, 'the newest reading must land at the END');
    assert.equal(next[0], 0, 'the oldest reading must have scrolled off');
    // Input array untouched — the component passes React state straight in.
    assert.equal(levels[0], 0.9, 'the input array must not be mutated');
  });

  await t.test('floors a silent reading so the bar keeps a dot', () => {
    const next = pushDictationLevel(createDictationLevels(), 0);
    assert.equal(next[next.length - 1], DICTATION_SILENCE_FLOOR);
  });

  await t.test('clamps a malformed reading instead of blanking or overflowing', () => {
    // The level crosses an IPC boundary: a bad value must not be able to blank
    // the waveform (NaN) or grow a bar past the track (>1).
    assert.equal(pushDictationLevel(createDictationLevels(), NaN).at(-1), DICTATION_SILENCE_FLOOR);
    assert.equal(pushDictationLevel(createDictationLevels(), 99).at(-1), 1);
    assert.equal(pushDictationLevel(createDictationLevels(), -1).at(-1), DICTATION_SILENCE_FLOOR);
    assert.ok(Number.isFinite(dictationBarHeight(pushDictationLevel(createDictationLevels(), NaN).at(-1))));
  });

  await t.test('recovers from a missing or wrong-sized previous window', () => {
    for (const bad of [undefined, null, [], [1, 2, 3], 'nope']) {
      const next = pushDictationLevel(bad, 0.3);
      assert.equal(next.length, DICTATION_BAR_COUNT, `recovery failed for ${JSON.stringify(bad)}`);
      assert.equal(next.at(-1), 0.3);
    }
  });
});
