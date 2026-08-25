// Phase 6 Slice 0, item 5 — assertNoAuthorityContradiction removal.
//
// docs/context-rebuild/03_ROOT_CAUSES.md (RC8) and 05_COMPONENT_DISPOSITION.md
// (§A6) found this dev-only tripwire had zero production callers, zero test
// coverage, and checked a condition (sourceOwner==='clarify' +
// finalAction==='answer') distinct from the one actually implicated in the
// investigation (RC1: finalAction hardcoded regardless of
// evidenceCoverage.confidence). Deleted from
// electron/intelligence/context-os/integration.ts and its re-export from
// electron/intelligence/context-os/index.ts.
//
// This is the negative/grep-shaped test the migration plan's Slice 0
// pre-required-tests section calls for: assert no importer remains
// repo-wide, and assert the compiled module no longer exports it.
//
// Run with: npm run build:electron && node --test electron/intelligence/__tests__/AssertNoAuthorityContradictionRemoved2026_07_25.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../..');
const cjsRequire = createRequire(import.meta.url);

// The premium submodule was removed from this repo, so premium/electron is
// absent — only scan directories that exist so the main-repo scan still runs
// instead of erroring on the missing dir.
const scanTargets = ['electron', 'src'].filter((d) => fs.existsSync(path.join(repoRoot, d)));
if (fs.existsSync(path.join(repoRoot, 'premium/electron'))) scanTargets.push('premium/electron');

/** Recursively collect source files under `root` (pure Node — no shell grep). */
function collectSourceFiles(root, out = []) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist-electron') continue;
      collectSourceFiles(full, out);
    } else if (/\.(ts|tsx|js|mjs|cjs)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

test('no source file repo-wide imports/calls assertNoAuthorityContradiction', () => {
  // Matches actual usage syntax (an import/re-export list entry or a call),
  // not the removal note's prose mention of the identifier in
  // integration.ts's comment, and excludes this test file's own text.
  const usageRe = /assertNoAuthorityContradiction[,}(]/;
  const remaining = [];
  for (const target of scanTargets) {
    for (const file of collectSourceFiles(path.join(repoRoot, target))) {
      if (file.endsWith('AssertNoAuthorityContradictionRemoved2026_07_25.test.mjs')) continue;
      const src = fs.readFileSync(file, 'utf8');
      if (usageRe.test(src)) remaining.push(path.relative(repoRoot, file));
    }
  }
  assert.deepEqual(remaining, [], `expected zero real usages, found:\n${remaining.join('\n')}`);
});

test('compiled context-os index no longer exports assertNoAuthorityContradiction', () => {
  const co = cjsRequire(path.resolve(repoRoot, 'dist-electron/electron/intelligence/context-os/index.js'));
  assert.equal(co.assertNoAuthorityContradiction, undefined);
});
