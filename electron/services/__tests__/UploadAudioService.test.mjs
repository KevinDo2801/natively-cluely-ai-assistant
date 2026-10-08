import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDeepgramUpload } from '../../../dist-electron/electron/services/UploadAudioParser.js';

test('parses Deepgram diarized utterances into Natively transcript segments', () => {
  const result = parseDeepgramUpload({
    metadata: { duration: 4.2 },
    results: {
      channels: [{ detected_language: 'vi', alternatives: [{ transcript: 'Xin chào. Chào bạn.' }] }],
      utterances: [
        { speaker: 0, start: 0, end: 1.8, transcript: 'Xin chào.' },
        { speaker: 1, start: 2, end: 4.2, transcript: 'Chào bạn.' },
      ],
    },
  }, true);

  assert.equal(result.detectedLanguage, 'vi');
  assert.equal(result.durationSeconds, 4.2);
  assert.deepEqual(result.segments, [
    { speaker: 'Speaker 1', text: 'Xin chào.', startMs: 0, endMs: 1800 },
    { speaker: 'Speaker 2', text: 'Chào bạn.', startMs: 2000, endMs: 4200 },
  ]);
  assert.equal(result.transcript, 'Speaker 1: Xin chào.\n\nSpeaker 2: Chào bạn.');
});

test('falls back to one Audio segment when speaker detection is off', () => {
  const result = parseDeepgramUpload({
    metadata: { duration: 2 },
    results: { channels: [{ alternatives: [{ transcript: 'A plain transcript.' }] }] },
  }, false);

  assert.equal(result.transcript, 'A plain transcript.');
  assert.deepEqual(result.segments, [
    { speaker: 'Audio', text: 'A plain transcript.', startMs: 0, endMs: 2000 },
  ]);
});

test('reports a no-speech error for an empty Deepgram result', () => {
  assert.throws(
    () => parseDeepgramUpload({ results: { channels: [{ alternatives: [{ transcript: '' }] }] } }, true),
    /did not detect speech/i,
  );
});

test('extracts the language code from per-alternative languages objects', () => {
  const result = parseDeepgramUpload({
    metadata: { duration: 1 },
    results: {
      channels: [{
        alternatives: [{
          transcript: 'Hi.',
          // Deepgram returns `languages` as an array of {language, confidence}
          // objects — the parser must read `.language`, not surface the object.
          languages: [{ language: 'en', confidence: 0.99 }],
        }],
      }],
    },
  }, false);

  assert.equal(result.detectedLanguage, 'en');
});

test('groups diarized words by speaker when utterances are absent', () => {
  const result = parseDeepgramUpload({
    metadata: { duration: 5 },
    results: {
      channels: [{
        alternatives: [{
          transcript: 'Hello there. How are you?',
          words: [
            { word: 'hello', punctuated_word: 'Hello', start: 0, end: 1, speaker: 0 },
            { word: 'there', punctuated_word: 'there.', start: 1, end: 2, speaker: 0 },
            { word: 'how', punctuated_word: 'How', start: 2, end: 3, speaker: 1 },
            { word: 'are', punctuated_word: 'are', start: 3, end: 4, speaker: 1 },
            { word: 'you', punctuated_word: 'you?', start: 4, end: 5, speaker: 1 },
          ],
        }],
      }],
    },
  }, true);

  assert.deepEqual(result.segments, [
    { speaker: 'Speaker 1', text: 'Hello there.', startMs: 0, endMs: 2000 },
    { speaker: 'Speaker 2', text: 'How are you?', startMs: 2000, endMs: 5000 },
  ]);
  assert.equal(result.transcript, 'Speaker 1: Hello there.\n\nSpeaker 2: How are you?');
});
