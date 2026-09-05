import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  composeChatOverlayContext,
  isVagueChatQuestion,
  buildReaderLanguageHint,
} from '../chatOverlayContext.ts';

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

  test('default persona nudges toward the NEWEST content at the bottom', () => {
    const out = composeChatOverlayContext({ transcript: 't', chatHistory: '' });
    assert.match(out, /NEWEST content is at the BOTTOM/i);
  });

  test('default persona follows the question language and flexible Cluely-style notes', () => {
    const out = composeChatOverlayContext({ transcript: 't', chatHistory: '' });
    // Language follows the user's question; Vietnamese question → Vietnamese answer.
    assert.match(out, /language of the user's question/);
    // Flexible structure: optional code block, compact Tóm gọn close, and an
    // optional English "say it in class" line for a Vietnamese student in an
    // English lecture — none of them forced.
    assert.match(out, /code block/);
    assert.match(out, /\*\*Tóm gọn:\*\*/);
    assert.match(out, /Nói trong lớp/);
    assert.match(out, /LET THE CONTENT CHOOSE THE SHAPE/);
    // Vague asks get the verbatim quote section, factual ones do not.
    assert.match(out, /\*\*Câu đang nói dở:\*\*/);
    assert.match(out, /Do NOT add the quote section to plain factual or technical questions/);
  });

  test('default persona requires delimited LaTeX instead of code-formatted formulas', () => {
    const out = composeChatOverlayContext({ transcript: 't', chatHistory: '' });
    assert.match(out, /NEVER put mathematical formulas in backticks/);
    assert.match(out, /\$\.\.\.\$ inline or \$\$\.\.\.\$\$/);
    assert.match(out, /\$2\^2\$/);
  });
});

describe('composeChatOverlayContext — vague-question brevity bound', () => {
  test('vague question appends the recent-only short-answer bound', () => {
    const out = composeChatOverlayContext({
      transcript: 't',
      chatHistory: '',
      question: 'giai thich',
    });
    assert.match(out, /what is being said RIGHT NOW/);
    assert.match(out, /Câu đang nói dở/);
    assert.match(out, /do not re-explain topics already covered/i);
    assert.match(out, /never repeat the exact same .*? quote/i);
  });

  test('referential English question triggers the same bound', () => {
    const out = composeChatOverlayContext({
      transcript: 't',
      chatHistory: '',
      question: 'explain what she said',
    });
    assert.match(out, /what is being said RIGHT NOW/);
  });

  test('specific question does NOT get the vague bound', () => {
    const out = composeChatOverlayContext({
      transcript: 't',
      chatHistory: '',
      question: 'what is the kernel for the x derivative?',
    });
    assert.doesNotMatch(out, /never repeat the exact same quote/);
  });

  test('no question leaves the default persona untouched', () => {
    const out = composeChatOverlayContext({ transcript: 't', chatHistory: '' });
    assert.doesNotMatch(out, /never repeat the exact same quote/);
  });

  test('a caller-supplied persona still receives the vague bound', () => {
    const out = composeChatOverlayContext({
      transcript: 't',
      chatHistory: '',
      persona: 'You are recalling a meeting.',
      question: 'anh ay noi gi',
    });
    assert.match(out, /You are recalling a meeting\./);
    assert.match(out, /what is being said RIGHT NOW/);
  });
});

describe('isVagueChatQuestion', () => {
  test('matches Vietnamese and telegraphed no-diacritic phrasings', () => {
    for (const q of ['giai thich', 'giải thích', 'thay dang noi gi', 'anh ay noi gi', 'nghia la gi']) {
      assert.equal(isVagueChatQuestion(q), true, `expected vague: ${q}`);
    }
  });
  test('matches English referential phrasings', () => {
    for (const q of ['explain what she said', 'what did he mean', 'tell me more', 'repeat that']) {
      assert.equal(isVagueChatQuestion(q), true, `expected vague: ${q}`);
    }
  });
  test('rejects specific questions', () => {
    for (const q of ['what is a kernel', 'sigma de lam gi', 'my name is Kiet']) {
      assert.equal(isVagueChatQuestion(q), false, `expected specific: ${q}`);
    }
  });
});

describe('buildReaderLanguageHint', () => {
  test('quotes the last typed message and demands its language', () => {
    const hint = buildReaderLanguageHint('giai thich');
    assert.match(hint, /giai thich/);
    assert.match(hint, /language of that quoted message/);
    assert.match(hint, /overrides any other language guidance/);
  });
  test('collapses whitespace and caps the sample length', () => {
    const long = `a   b ${'x'.repeat(200)}`;
    const hint = buildReaderLanguageHint(long);
    assert.match(hint, /a b/);
    assert.ok(hint.length < 400, 'sample must be bounded');
  });
  test('empty when there is no typed text', () => {
    assert.equal(buildReaderLanguageHint('   '), '');
    assert.equal(buildReaderLanguageHint(''), '');
  });
});
