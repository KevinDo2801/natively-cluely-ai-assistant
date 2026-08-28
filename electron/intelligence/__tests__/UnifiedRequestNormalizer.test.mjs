// Unified pipeline C1 — request normalization tests.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeRequest,
  manualChatRequest,
  whatToSayRequest,
  quickActionRequest,
  searchRequest,
  phoneMirrorRequest,
  outputIntentFor,
  streamIntentFor,
  surfaceFor,
  normalizeRefinementIntent,
  mintRequestId,
} from '../../../dist-electron/electron/intelligence/unified/requestNormalizer.js';

describe('UnifiedRequestNormalizer — source → outputIntent mapping', () => {
  test('manual_chat → assistant_answer', () => {
    assert.equal(outputIntentFor('manual_chat'), 'assistant_answer');
  });
  test('what_to_say / auto_transcript → speak_for_user', () => {
    assert.equal(outputIntentFor('what_to_say'), 'speak_for_user');
    assert.equal(outputIntentFor('auto_transcript'), 'speak_for_user');
  });
  test('recap → summary, clarify → clarification', () => {
    assert.equal(outputIntentFor('recap'), 'summary');
    assert.equal(outputIntentFor('clarify'), 'clarification');
  });
  test('code_hint → code; meeting/global search → assistant_answer', () => {
    assert.equal(outputIntentFor('code_hint'), 'code');
    assert.equal(outputIntentFor('meeting_search'), 'assistant_answer');
    assert.equal(outputIntentFor('global_search'), 'assistant_answer');
  });
});

describe('UnifiedRequestNormalizer — stream intent mapping', () => {
  test('typed chat and searches stream as "chat"', () => {
    assert.equal(streamIntentFor({ source: 'manual_chat' }), 'chat');
    assert.equal(streamIntentFor({ source: 'meeting_search' }), 'chat');
    assert.equal(streamIntentFor({ source: 'global_search' }), 'chat');
    assert.equal(streamIntentFor({ source: 'phone_mirror' }), 'chat');
  });
  test('WTA surfaces stream as "what_to_answer"', () => {
    assert.equal(streamIntentFor({ source: 'what_to_say' }), 'what_to_answer');
    assert.equal(streamIntentFor({ source: 'auto_transcript' }), 'what_to_answer');
    assert.equal(streamIntentFor({ source: 'code_hint' }), 'what_to_answer');
    assert.equal(streamIntentFor({ source: 'brainstorm' }), 'what_to_answer');
  });
  test('recap/clarify/follow_up_questions keep their intents', () => {
    assert.equal(streamIntentFor({ source: 'recap' }), 'recap');
    assert.equal(streamIntentFor({ source: 'clarify' }), 'clarify');
    assert.equal(streamIntentFor({ source: 'follow_up_questions' }), 'follow_up_questions');
  });
  test('follow_up resolves the refinement intent (unknown → rephrase)', () => {
    assert.equal(streamIntentFor({ source: 'follow_up', followUpIntent: 'shorten' }), 'shorten');
    assert.equal(streamIntentFor({ source: 'follow_up', followUpIntent: 'make it longer' }), 'rephrase');
    assert.equal(streamIntentFor({ source: 'follow_up' }), 'rephrase');
  });
});

describe('UnifiedRequestNormalizer — surface resolution', () => {
  test('phone_mirror is the only phone surface', () => {
    assert.equal(surfaceFor('phone_mirror'), 'phone');
    assert.equal(surfaceFor('manual_chat'), 'desktop');
    assert.equal(surfaceFor('what_to_say'), 'desktop');
  });
});

describe('UnifiedRequestNormalizer — request shaping', () => {
  test('normalizeRequest fills defaults and never throws on unknown source', () => {
    const req = normalizeRequest({ source: 'unknown_source', text: 'hi' });
    assert.equal(req.source, 'manual_chat');
    assert.equal(req.surface, 'desktop');
    assert.equal(req.outputIntent, 'assistant_answer');
    assert.ok(req.requestId.length > 0);
  });

  test('manualChatRequest keeps the legacy context + skip flag', () => {
    const req = manualChatRequest({ message: 'hello', context: 'CTX', skipSystemPrompt: true, pinnedModeId: 'm1' });
    assert.equal(req.source, 'manual_chat');
    assert.equal(req.text, 'hello');
    assert.equal(req.legacyContext, 'CTX');
    assert.equal(req.skipSystemPrompt, true);
    assert.equal(req.pinnedModeId, 'm1');
  });

  test('imagePaths are capped at 5 and empty arrays drop to undefined', () => {
    const req = normalizeRequest({ source: 'manual_chat', imagePaths: ['a', 'b', 'c', 'd', 'e', 'f'] });
    assert.equal(req.imagePaths.length, 5);
    const empty = normalizeRequest({ source: 'manual_chat', imagePaths: [] });
    assert.equal(empty.imagePaths, undefined);
  });

  test('whatToSayRequest carries dom/screen/prompt options', () => {
    const req = whatToSayRequest({
      question: 'q', domContext: '<dom>', promptInstruction: 'p', screenContext: { text: 's' }, pinnedModeId: 'm',
    });
    assert.equal(req.source, 'what_to_say');
    assert.equal(req.outputIntent, 'speak_for_user');
    assert.equal(req.domContext, '<dom>');
    assert.equal(req.promptInstruction, 'p');
    assert.equal(req.pinnedModeId, 'm');
  });

  test('quickActionRequest maps every quick action source', () => {
    for (const source of ['recap', 'clarify', 'follow_up', 'follow_up_questions', 'code_hint', 'brainstorm']) {
      const req = quickActionRequest({ source });
      assert.equal(req.source, source);
      assert.equal(req.surface, 'desktop');
    }
    const fu = quickActionRequest({ source: 'follow_up', followUpIntent: 'rephrase' });
    assert.equal(fu.followUpIntent, 'rephrase');
  });

  test('searchRequest scopes meeting_search with meetingId', () => {
    const m = searchRequest({ source: 'meeting_search', query: 'what was said?', meetingId: 'mid-1' });
    assert.equal(m.source, 'meeting_search');
    assert.equal(m.meetingId, 'mid-1');
    const g = searchRequest({ source: 'global_search', query: 'anything' });
    assert.equal(g.meetingId, undefined);
  });

  test('phoneMirrorRequest is a phone-surface chat request', () => {
    const req = phoneMirrorRequest({ message: 'hi from phone', pinnedModeId: 'm' });
    assert.equal(req.source, 'phone_mirror');
    assert.equal(req.surface, 'phone');
    assert.equal(req.outputIntent, 'assistant_answer');
  });

  test('mintRequestId is unique per call', () => {
    assert.notEqual(mintRequestId(), mintRequestId());
  });

  test('normalizeRefinementIntent passes known intents through', () => {
    for (const i of ['shorten', 'rephrase', 'expand', 'add_example', 'more_confident', 'more_casual', 'more_formal', 'simplify']) {
      assert.equal(normalizeRefinementIntent(i), i);
    }
  });
});
