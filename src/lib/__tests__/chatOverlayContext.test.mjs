import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { composeChatOverlayContext } from '../chatOverlayContext.ts';

describe('composeChatOverlayContext', () => {
  test('includes transcript, conversation and files blocks', () => {
    const out = composeChatOverlayContext({
      transcript: 'Q: what planet has most moons\nA: Saturn',
      chatHistory: 'User: explain what she said',
      files: [{ fileName: 'notes.md', content: 'file body' }],
    });
    assert.match(out, /MEETING TRANSCRIPT/);
    assert.match(out, /what planet has most moons/);
    assert.match(out, /CONVERSATION SO FAR/);
    assert.match(out, /explain what she said/);
    assert.match(out, /REFERENCE FILES/);
    assert.match(out, /notes\.md/);
  });

  test('omits files block when no files', () => {
    const out = composeChatOverlayContext({ transcript: 'hello', chatHistory: '' });
    assert.doesNotMatch(out, /REFERENCE FILES/);
    assert.match(out, /MEETING TRANSCRIPT/);
    assert.doesNotMatch(out, /CONVERSATION SO FAR/);
  });

  test('omits conversation block when empty', () => {
    const out = composeChatOverlayContext({ transcript: 'hello', chatHistory: '  ' });
    assert.doesNotMatch(out, /CONVERSATION SO FAR/);
  });

  test('truncates oversized files to keep the context bounded', () => {
    const big = 'x'.repeat(10000);
    const out = composeChatOverlayContext({
      transcript: 't',
      chatHistory: '',
      files: [{ fileName: 'big.txt', content: big }],
    });
    assert.match(out, /\[\.\.\.truncated\]/);
    // The truncated body must be far smaller than the original file.
    assert.ok(out.length < big.length);
  });

  test('honors a custom persona and transcript label', () => {
    const out = composeChatOverlayContext({
      transcript: 't',
      chatHistory: '',
      persona: 'You are recalling a meeting.',
      transcriptLabel: '[MEETING CONTEXT:]',
    });
    assert.match(out, /You are recalling a meeting\./);
    assert.match(out, /\[MEETING CONTEXT:\]/);
    assert.doesNotMatch(out, /MEETING TRANSCRIPT \(real audio/);
  });

  test('default persona nudges vague questions toward most recent content', () => {
    const out = composeChatOverlayContext({ transcript: 't', chatHistory: '' });
    assert.match(out, /MOST RECENT/i);
  });
});
