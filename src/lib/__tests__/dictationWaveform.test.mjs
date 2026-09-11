/**
 * Unit tests for the dictation waveform's display shaping and bar geometry.
 *
 * These lock in the properties that were visibly wrong in the UI: the waveform
 * must span the composer (not cluster in the middle), silence must still read as
 * a waveform, and ordinary speech must fill a useful share of the track.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DICTATION_BAR_GAP_PX,
  DICTATION_BAR_MAX_PX,
  DICTATION_BAR_MIN_PX,
  DICTATION_BAR_WIDTH_PX,
  DICTATION_MIN_BAR_COUNT,
  DICTATION_SILENCE_FLOOR,
  createDictationLevels,
  dictationBarCount,
  dictationBarHeight,
  pushDictationLevel,
  resizeDictationLevels,
} from '../dictationWaveform.mjs';

/** Width in px a run of `n` bars actually occupies, including the gaps. */
const spanOf = (n) => n * DICTATION_BAR_WIDTH_PX + (n - 1) * DICTATION_BAR_GAP_PX;

test('dictationBarCount', async (t) => {
  await t.test('spans the given width, leaving under one bar-pitch of slack', () => {
    // The real composer track, measured on the running overlay: ~600px at the
    // narrow shell width and ~656px at the wide one.
    for (const width of [420, 536, 600, 656, 692]) {
      const count = dictationBarCount(width);
      const span = spanOf(count);
      assert.ok(
        span <= width,
        `${count} bars span ${span}px, which overflows a ${width}px track`,
      );
      assert.ok(
        width - span < DICTATION_BAR_WIDTH_PX + DICTATION_BAR_GAP_PX,
        `${count} bars span only ${span}px of a ${width}px track — a whole extra bar would fit`,
      );
    }
  });

  await t.test('covers vastly more of the bar than the old fixed 44 bars', () => {
    // The regression this replaced: 44 bars covered 174px of a 600px track.
    const count = dictationBarCount(600);
    assert.ok(count > 140, `expected a width-covering count, got ${count}`);
    assert.ok(spanOf(count) > 560, `only covered ${spanOf(count)}px of 600px`);
  });

  await t.test('never drops below the readable minimum', () => {
    for (const width of [0, -10, 1, 40, 100, NaN, Infinity, undefined, null]) {
      const count = dictationBarCount(width);
      assert.ok(Number.isFinite(count), `count for ${String(width)} was ${count}`);
      assert.ok(count >= DICTATION_MIN_BAR_COUNT, `count for ${String(width)} was ${count}`);
    }
  });

  await t.test('grows monotonically with width', () => {
    let previous = 0;
    for (let width = 100; width <= 800; width += 4) {
      const count = dictationBarCount(width);
      assert.ok(count >= previous, `count fell at width ${width}`);
      previous = count;
    }
  });
});

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
    assert.ok(
      DICTATION_BAR_MIN_PX / DICTATION_BAR_MAX_PX >= 0.12,
      `silence bar is only ${DICTATION_BAR_MIN_PX}/${DICTATION_BAR_MAX_PX} tall`,
    );
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
    // linear mapping drew these at 8-30% of the track, which read as empty
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
  });
});

test('createDictationLevels', async (t) => {
  await t.test('is a flat, empty waveform of the requested length', () => {
    const levels = createDictationLevels(150);
    assert.equal(levels.length, 150);
    assert.ok(levels.every((l) => l === 0));
  });

  await t.test('defaults to the readable minimum and rejects a bad count', () => {
    assert.equal(createDictationLevels().length, DICTATION_MIN_BAR_COUNT);
    for (const bad of [0, -3, NaN, undefined, null]) {
      assert.equal(createDictationLevels(bad).length, DICTATION_MIN_BAR_COUNT, `count=${String(bad)}`);
    }
  });

  await t.test('returns a fresh array each call', () => {
    const a = createDictationLevels(40);
    const b = createDictationLevels(40);
    a[0] = 1;
    assert.equal(b[0], 0, 'a shared array would let one session leak into the next');
  });
});

test('resizeDictationLevels', async (t) => {
  await t.test('keeps the NEWEST readings when shrinking', () => {
    // The newest reading is the rightmost bar, anchored to the right edge of the
    // track. Dropping from the front is what stops the visible waveform shifting
    // sideways when the composer narrows.
    const levels = [...Array(10).keys()].map((i) => i / 10);
    const shrunk = resizeDictationLevels(levels, 4);
    assert.equal(shrunk.length, 4);
    assert.deepEqual(shrunk, [0.6, 0.7, 0.8, 0.9]);
  });

  await t.test('prepends silence when growing, so the history stays put', () => {
    const levels = [0.5, 0.6];
    const grown = resizeDictationLevels(levels, 5);
    assert.equal(grown.length, 5);
    assert.deepEqual(grown, [0, 0, 0, 0.5, 0.6]);
  });

  await t.test('is a no-op at the same length, and recovers from junk input', () => {
    const levels = [0.1, 0.2];
    assert.equal(resizeDictationLevels(levels, 2), levels, 'must not clone needlessly');
    for (const bad of [undefined, null, [], 'nope']) {
      const out = resizeDictationLevels(bad, 6);
      assert.equal(out.length, 6, `recovery failed for ${JSON.stringify(bad)}`);
      assert.ok(out.every((l) => l === 0));
    }
    assert.equal(resizeDictationLevels([1, 2, 3], NaN).length, DICTATION_MIN_BAR_COUNT);
  });
});

test('pushDictationLevel', async (t) => {
  await t.test('scrolls: drops the oldest bar and appends the newest', () => {
    const levels = createDictationLevels(4);
    levels[0] = 0.9;
    const next = pushDictationLevel(levels, 0.5);
    assert.equal(next.length, 4, 'length-preserving: the track decides the count');
    assert.equal(next[3], 0.5, 'the newest reading must land at the END');
    assert.equal(next[0], 0, 'the oldest reading must have scrolled off');
    assert.equal(levels[0], 0.9, 'the input array must not be mutated');
  });

  await t.test('floors a silent reading so the bar keeps a visible minimum', () => {
    const next = pushDictationLevel(createDictationLevels(4), 0);
    assert.equal(next.at(-1), DICTATION_SILENCE_FLOOR);
  });

  await t.test('clamps a malformed reading instead of blanking or overflowing', () => {
    // The level crosses an IPC boundary: a bad value must not be able to blank
    // the waveform (NaN) or grow a bar past the track (>1).
    assert.equal(pushDictationLevel(createDictationLevels(4), NaN).at(-1), DICTATION_SILENCE_FLOOR);
    assert.equal(pushDictationLevel(createDictationLevels(4), 99).at(-1), 1);
    assert.equal(pushDictationLevel(createDictationLevels(4), -1).at(-1), DICTATION_SILENCE_FLOOR);
  });

  await t.test('recovers from a missing or empty previous window', () => {
    for (const bad of [undefined, null, [], 'nope']) {
      const next = pushDictationLevel(bad, 0.3);
      assert.equal(next.length, DICTATION_MIN_BAR_COUNT, `recovery failed for ${JSON.stringify(bad)}`);
      assert.equal(next.at(-1), 0.3);
    }
  });
});
