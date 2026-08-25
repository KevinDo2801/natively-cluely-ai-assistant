// electron/llm/__tests__/ExpertiseCategoryHint2026_07_17.test.mjs
//
// Campaign 2 (longsession, 2026-07-17): script-a press A9 ("The JD calls for
// 8+ years and deep Go or Java expertise — how do you stack up there?") got
// candidateProfileChars:0 in the live [TRACE:LONGCTX] prompt_assembled trace
// — zero résumé context reached the prompt despite the question being a
// clear experience-level lookup with grounded facts available ("Go (primary,
// 8+ years production)" in the résumé fixture's Languages line).
//
// Root cause: `detectCategoryHints` / `CATEGORY_KEYWORD_MAP`
// (HybridSearchEngine.ts) maps the word
// "experience" to the 'experience' category, but had NO entry for its
// synonym "expertise" at all — so a question phrased with "expertise"
// produced ZERO category hints, and `buildStructuredCategoryPack`
// (KnowledgeOrchestrator.ts) returned an empty node list ("Deterministic
// structured pack: 1 node(s) for categories []" in the live log — the "1
// node" was an unrelated fallback, not anything matching the question).
//
// Fix: add 'expertise' → ['experience'] to CATEGORY_KEYWORD_MAP, mirroring
// the existing 'experience' entry — both words mean the same thing for this
// classifier's purpose.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// The premium submodule was removed from this repo, so the compiled
// HybridSearchEngine is absent: skip the premium-dependent suites
// gracefully instead of failing at load time.
let PREMIUM_AVAILABLE = true;
let detectCategoryHints;
try {
  ({ detectCategoryHints } = await import(
    pathToFileURL(path.resolve(__dirname, '../../../dist-electron/premium/electron/knowledge/HybridSearchEngine.js')).href
  ));
} catch (err) {
  PREMIUM_AVAILABLE = false;
  console.warn(`[premium-absent] ${err?.code ?? err?.message ?? err} — skipping premium-dependent suites in ${import.meta.url}`);
}
const describeIfPremium = PREMIUM_AVAILABLE ? describe : describe.skip;

describeIfPremium('"expertise" is recognized as an experience-category keyword', () => {
  test('the exact live-failing question now yields the experience category hint', () => {
    const hints = detectCategoryHints('The JD calls for 8+ years and deep Go or Java expertise — how do you stack up there?');
    assert.ok(hints.includes('experience'), `expected 'experience' in hints, got ${JSON.stringify(hints)}`);
  });

  test('"expertise" alone yields the same category as "experience"', () => {
    const withExpertise = detectCategoryHints('what is your Python expertise?');
    const withExperience = detectCategoryHints('what is your Python experience?');
    assert.deepEqual(withExpertise, withExperience);
  });

  test('a question with neither word still yields no category hints (no over-broadening)', () => {
    const hints = detectCategoryHints('what is a hashmap?');
    assert.deepEqual(hints, []);
  });
});
