// electron/services/__tests__/ModeReferenceFileIngestResultContent2026_07_26.test.mjs
//
// Bug fix (2026-07-26, live-testing session): `ingestModeReferenceFile`'s
// returned `ModeReferenceFileIngestResult` omitted `content` even though
// `extractSafeDocumentText`'s result (`extracted.content`) was fully
// available at the call site. `modes:upload-reference-file` (ipcHandlers.ts)
// returns this result verbatim as `{ success: true, file }`, and
// `ModesSettings.tsx`'s `uploadFile()` pushes it straight into its
// `referenceFiles` list, then unconditionally renders `file.content.length`
// for every row — so every successful reference-file upload crashed the
// Modes settings panel (`Cannot read properties of undefined (reading
// 'length')`, caught by the renderer's ErrorBoundary) until the next full
// reload, which re-fetches via `modes:get-reference-files` (whose
// `rowToFile` mapping in ModesManager.ts always included `content`).
//
// Live-reproduced during a real upload of a 66-page PDF into a custom
// document-grounded mode (Session 2026-07-26 shadow-observation testing).
//
// Source-pinned: constructing a real ingestModeReferenceFile() call
// requires a real ModesManager backed by DatabaseManager, which is
// ABI-mismatched in this dev environment (established baseline throughout
// this test suite) — so this proves both halves of the fix by reading the
// source directly, mirroring ModeUploadHardening.test.mjs's own convention
// for testing this exact file.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../..');
const ingestionSrc = fs.readFileSync(
  path.resolve(__dirname, '../ModeReferenceFileIngestion.ts'),
  'utf8',
);
// The premium submodule was removed from this repo, so premium/src is absent:
// the ModesSettings.tsx render-site assertions below skip gracefully instead of
// failing at load time. (The ingestion assertions above use only main-repo
// sources and always run.)
let PREMIUM_AVAILABLE = true;
let modesSettingsSrc = null;
try {
  modesSettingsSrc = fs.readFileSync(
    path.resolve(repoRoot, 'premium/src/ModesSettings.tsx'),
    'utf8',
  );
} catch (err) {
  PREMIUM_AVAILABLE = false;
  console.warn(`[premium-absent] ${err?.code ?? err?.message ?? err} — skipping premium-dependent suites in ${import.meta.url}`);
}
const describeIfPremium = PREMIUM_AVAILABLE ? describe : describe.skip;

describe('ModeReferenceFileIngestResult includes content (the actual bug)', () => {
  test('the interface declares a required `content: string` field', () => {
    const ifaceStart = ingestionSrc.indexOf('export interface ModeReferenceFileIngestResult {');
    const ifaceEnd = ingestionSrc.indexOf('\n}', ifaceStart);
    const iface = ingestionSrc.slice(ifaceStart, ifaceEnd);
    assert.match(iface, /\n\s*content: string;/, 'content must be declared, and required (no `?`)');
  });

  test('the returned object literal actually includes `content: extracted.content`', () => {
    // Pin to ingestModeReferenceFile's OWN return block. The original used
    // `lastIndexOf('return {')`, which drifted to the LATER
    // ingestModeReferenceFileContent function (paste-text path) once that was
    // added — its return legitimately uses `file.content`, so the pinned
    // assertion failed with the fix correctly in place.
    const fnStart = ingestionSrc.indexOf('export const ingestModeReferenceFile = async (');
    assert.ok(fnStart >= 0, 'ingestModeReferenceFile not found in source');
    const fnTail = ingestionSrc.slice(fnStart);
    const returnStart = fnTail.indexOf('return {');
    assert.ok(returnStart >= 0, 'ingestModeReferenceFile return block not found');
    const returnEnd = fnTail.indexOf('};', returnStart);
    const returnBody = fnTail.slice(returnStart, returnEnd);
    assert.match(returnBody, /content:\s*extracted\.content/, 'the actual returned value must carry the real extracted content, not be omitted');
  });
});

describeIfPremium('ModesSettings.tsx render site is defensive even if a future backend regression omits content again', () => {
  test('file.content.length is accessed with optional chaining + a numeric fallback, not a bare unguarded access', () => {
    assert.doesNotMatch(modesSettingsSrc, /\(file\.content\.length \/ 1000\)/, 'the old unguarded access must be gone');
    assert.match(modesSettingsSrc, /\(\(file\.content\?\.length \?\? 0\) \/ 1000\)/, 'must guard with optional chaining + a numeric fallback so a missing content field can never crash the render');
  });
});
