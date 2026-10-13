import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  foldText,
  tokenizeForRelevance,
  rankPassagesByQuery,
  splitIntoPassages,
  selectRelevantExcerpts,
  allocateFileBudgets,
  TRUNCATION_MARKER,
} from '../chatRelevance.ts';

describe('foldText / tokenizeForRelevance', () => {
  test('folds Vietnamese diacritics so accented and telegraphed typing match', () => {
    assert.equal(foldText('Kinh nghiệm Đại học'), 'kinh nghiem dai hoc');
    assert.deepEqual(tokenizeForRelevance('kinh nghiệm'), tokenizeForRelevance('kinh nghiem'));
  });

  test('keeps whole Vietnamese words instead of splitting at accented letters', () => {
    // The V3 ASCII tokenizer turns "nghiệm" into "nghi" + "m".
    const t = tokenizeForRelevance('nghiệm');
    assert.deepEqual(t, ['nghiem']);
  });

  test('emits CJK character bigrams instead of erasing the text', () => {
    assert.deepEqual(tokenizeForRelevance('工作经验'), ['工作', '作经', '经验']);
  });

  test('keeps Cyrillic words and splits mixed CJK / Latin runs', () => {
    assert.deepEqual(tokenizeForRelevance('опыт работы'), ['опыт', 'работы']);
    assert.deepEqual(tokenizeForRelevance('使用React框架'), ['使用', 'react', '框架']);
  });

  test('drops stopwords and 1-letter noise but keeps numbers', () => {
    assert.deepEqual(tokenizeForRelevance('the a 5 years'), ['5', 'years']);
  });

  test('keeps Hangul syllables intact through NFD folding', () => {
    assert.deepEqual(tokenizeForRelevance('경험'), ['경험']);
  });
});

describe('rankPassagesByQuery', () => {
  const passages = [
    { id: 'a', text: 'Python and Django backend development for five years' },
    { id: 'b', text: 'Led a team of eight engineers building payment systems' },
    { id: 'c', text: 'Bachelor of Science in Computer Science' },
  ];

  test('ranks the passage containing the query terms first', () => {
    const r = rankPassagesByQuery(passages, 'payment systems team');
    assert.equal(r[0].id, 'b');
    assert.ok(r[0].score > 0);
  });

  test('scores 0 when the query shares no term', () => {
    const r = rankPassagesByQuery(passages, 'zzzz qqqq');
    assert.ok(r.every((x) => x.score === 0));
  });

  test('matches Vietnamese typed with and without diacritics', () => {
    const p = [
      { id: '1', text: 'Kinh nghiệm làm việc tại ngân hàng' },
      { id: '2', text: 'Sở thích đọc sách' },
    ];
    assert.equal(rankPassagesByQuery(p, 'kinh nghiem ngan hang')[0].id, '1');
    assert.equal(rankPassagesByQuery(p, 'kinh nghiệm ngân hàng')[0].id, '1');
  });
});

describe('splitIntoPassages', () => {
  test('splits on paragraphs and merges tiny neighbours', () => {
    const out = splitIntoPassages('- a\n- b\n- c\n\nSecond block here', 600);
    assert.ok(out.length >= 1 && out.length <= 2);
    assert.match(out.join('\n'), /Second block here/);
  });

  test('hard-splits unbroken text so a single giant line cannot exceed the target much', () => {
    const out = splitIntoPassages('x'.repeat(5000), 600);
    assert.ok(out.length > 5);
    assert.ok(out.every((p) => p.length <= 1300));
  });

  test('empty input yields no passages', () => {
    assert.deepEqual(splitIntoPassages('   '), []);
  });
});

describe('selectRelevantExcerpts', () => {
  const filler = (n, tag) => Array.from({ length: n }, (_, i) => `${tag} line ${i} about general duties and teamwork.`).join('\n\n');

  test('returns text untouched when it fits the budget (lossless)', () => {
    const r = selectRelevantExcerpts('short text', 'anything', 100);
    assert.equal(r.text, 'short text');
    assert.equal(r.truncated, false);
  });

  test('keeps a relevant passage from the TAIL that head-truncation would drop', () => {
    const doc = `${filler(40, 'early')}\n\nCertifications: AWS Solutions Architect Professional, CKA Kubernetes administrator.`;
    const naive = doc.slice(0, 1500);
    assert.doesNotMatch(naive, /Kubernetes/);
    const r = selectRelevantExcerpts(doc, 'kubernetes certification', 1500);
    assert.match(r.text, /Kubernetes administrator/);
    assert.equal(r.truncated, true);
    assert.ok(r.keptChars <= 1500);
  });

  test('always keeps the head (title / identity) of the document', () => {
    const doc = `NGUYEN VAN A — Senior Engineer\n\n${filler(40, 'mid')}\n\nSkills: Rust, Go.`;
    const r = selectRelevantExcerpts(doc, 'rust', 1200);
    assert.match(r.text, /NGUYEN VAN A/);
    assert.match(r.text, /Skills: Rust, Go\./);
  });

  test('marks omitted stretches so the model knows the excerpt is partial', () => {
    const doc = `${filler(40, 'x')}\n\nTarget: payment gateway migration.`;
    const r = selectRelevantExcerpts(doc, 'payment gateway', 900);
    assert.ok(r.text.includes(TRUNCATION_MARKER));
  });

  test('with no query signal it degrades to head + earliest content (old behaviour, never worse)', () => {
    const doc = filler(60, 'row');
    const r = selectRelevantExcerpts(doc, undefined, 1000);
    assert.match(r.text, /row line 0 /);
    assert.ok(r.keptChars <= 1000);
  });

  test('works for a cross-language question when the document is the matching language', () => {
    const doc = `${filler(40, 'filler')}\n\n学历：北京大学计算机科学硕士，工作经验八年。`;
    const r = selectRelevantExcerpts(doc, '工作经验', 1200);
    assert.match(r.text, /工作经验八年/);
  });

  test('handles a single unbroken 10k string and stays under budget', () => {
    const r = selectRelevantExcerpts('x'.repeat(10000), 'q', 4000);
    assert.ok(r.text.length < 10000);
    assert.equal(r.truncated, true);
    assert.ok(r.text.includes(TRUNCATION_MARKER));
  });

  test('zero budget yields only the marker', () => {
    const r = selectRelevantExcerpts('abc def', 'abc', 0);
    assert.equal(r.text, TRUNCATION_MARKER);
  });
});

describe('allocateFileBudgets', () => {
  const f = (len) => ({ fileName: 'f', content: 'x'.repeat(len) });

  test('short files keep everything; long files share the remainder up to the cap', () => {
    const b = allocateFileBudgets([f(500), f(9000), f(9000)], 4000, 10000);
    assert.equal(b[0], 500);
    assert.equal(b[1], 4000);
    assert.equal(b[2], 4000);
  });

  test('never exceeds the total cap', () => {
    const b = allocateFileBudgets([f(9000), f(9000), f(9000), f(9000)], 4000, 10000);
    assert.ok(b.reduce((s, x) => s + x, 0) <= 10000);
    assert.ok(b.every((x) => x > 0));
  });

  test('preserves input order', () => {
    const b = allocateFileBudgets([f(9000), f(100)], 4000, 10000);
    assert.equal(b[1], 100);
    assert.equal(b[0], 4000);
  });
});
