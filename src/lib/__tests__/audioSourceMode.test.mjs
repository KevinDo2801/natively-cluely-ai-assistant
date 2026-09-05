import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AUDIO_SOURCE_MODES,
  audioSourceIncludesMicrophone,
  audioSourceIncludesSystem,
  isAudioSourceMode,
  normalizeAudioSourceMode,
} from '../../types/audio.ts';

test('audio source modes expose the three launcher choices', () => {
  assert.deepEqual([...AUDIO_SOURCE_MODES], ['both', 'microphone', 'system']);
});

test('audio source channel gates are exhaustive', () => {
  assert.deepEqual(
    AUDIO_SOURCE_MODES.map((source) => ({
      source,
      mic: audioSourceIncludesMicrophone(source),
      system: audioSourceIncludesSystem(source),
    })),
    [
      { source: 'both', mic: true, system: true },
      { source: 'microphone', mic: true, system: false },
      { source: 'system', mic: false, system: true },
    ],
  );
});

test('invalid persisted values fail closed to the backwards-compatible both mode', () => {
  assert.equal(isAudioSourceMode('microphone'), true);
  assert.equal(isAudioSourceMode('speaker'), false);
  assert.equal(normalizeAudioSourceMode('speaker'), 'both');
  assert.equal(normalizeAudioSourceMode(undefined), 'both');
});
