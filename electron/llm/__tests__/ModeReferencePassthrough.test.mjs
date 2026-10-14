// A small reference file attached to the active mode must reach the model on
// typed chat even when V3 supplied no evidence — notably for non-English
// questions, which the English-only classifier routes to the FAST path.
//
// Run with: npm run build:electron && node --test electron/llm/__tests__/ModeReferencePassthrough.test.mjs

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const dist = path.resolve(process.cwd(), 'dist-electron/electron');
const {
  buildModeReferencePassthrough,
  DEFAULT_PASSTHROUGH_LIMITS,
} = await import(pathToFileURL(path.join(dist, 'llm/modeReferencePassthrough.js')).href);

const resume = {
  fileName: 'Master Resume.pdf',
  content: 'Kiet Do. B.S. Computer Science, University of South Florida, GPA 3.8. '
    + 'Software engineer intern at Acme. Skills: TypeScript, Python, SQL.',
};

describe('mode reference passthrough', () => {
  test('hands a small file over when V3 supplied no evidence (Vietnamese question)', () => {
    const r = buildModeReferencePassthrough({ files: [resume], question: 'trường đại học của tôi là gì?', evidenceCount: 0 });
    assert.equal(r.skipped, undefined);
    assert.match(r.block, /\[FILE: Master Resume\.pdf\]/);
    assert.match(r.block, /University of South Florida/);
    assert.deepEqual(r.dataScopes, ['reference_files']);
    assert.equal(r.files, 1);
  });

  test('does nothing when V3 already supplied evidence (no duplicate context)', () => {
    const r = buildModeReferencePassthrough({ files: [resume], question: 'who am I?', evidenceCount: 3 });
    assert.equal(r.block, '');
    assert.equal(r.skipped, 'has_evidence');
  });

  test('does nothing without files or with only blank files', () => {
    assert.equal(buildModeReferencePassthrough({ files: [], question: 'q', evidenceCount: 0 }).skipped, 'no_files');
    assert.equal(
      buildModeReferencePassthrough({ files: [{ fileName: 'a', content: '   ' }, { fileName: 'b' }], question: 'q', evidenceCount: 0 }).skipped,
      'no_files',
    );
  });

  test('respects the reference_files privacy toggle', () => {
    const r = buildModeReferencePassthrough({
      files: [resume], question: 'q?', evidenceCount: 0, scopePolicy: { reference_files: false },
    });
    assert.equal(r.block, '');
    assert.equal(r.skipped, 'scope_denied');
    // Other toggles do not matter to this scope.
    const ok = buildModeReferencePassthrough({
      files: [resume], question: 'q?', evidenceCount: 0, scopePolicy: { transcript: false },
    });
    assert.notEqual(ok.block, '');
  });

  test('ignores an empty question', () => {
    assert.equal(buildModeReferencePassthrough({ files: [resume], question: '  ', evidenceCount: 0 }).skipped, 'empty_question');
  });

  test('tells the model to override a "no evidence" notice only when asked to', () => {
    const plain = buildModeReferencePassthrough({ files: [resume], question: 'who am I?', evidenceCount: 0 });
    const override = buildModeReferencePassthrough({
      files: [resume], question: 'who am I?', evidenceCount: 0, overridesNoEvidenceNotice: true,
    });
    assert.ok(!/no evidence was found/i.test(plain.block));
    assert.match(override.block, /disregard any statement above that no evidence was found/);
  });

  test('keeps the total within budget and still includes every file', () => {
    const big = (name, tag) => ({ fileName: name, content: Array.from({ length: 400 }, (_, i) => `${tag} line ${i} about unrelated things.`).join('\n') });
    const r = buildModeReferencePassthrough({
      files: [big('a.txt', 'alpha'), big('b.txt', 'beta'), big('c.txt', 'gamma')],
      question: 'alpha line 7?',
      evidenceCount: 0,
    });
    assert.equal(r.files, 3);
    assert.ok(r.chars <= DEFAULT_PASSTHROUGH_LIMITS.totalChars + 200, `chars=${r.chars}`);
    assert.match(r.block, /\[FILE: a\.txt\]/);
    assert.match(r.block, /\[FILE: c\.txt\]/);
  });

  test('a file under the per-file cap is kept verbatim', () => {
    const r = buildModeReferencePassthrough({ files: [resume], question: 'x', evidenceCount: 0 });
    assert.ok(r.block.includes(resume.content));
  });
});
