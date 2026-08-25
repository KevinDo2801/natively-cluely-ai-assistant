// electron/services/__tests__/ProfileIntelligenceGate.test.mjs
//
// Verifies the Profile Intelligence IPC handlers enforce the Pro/trial gate.
// We test this at the source level (matching the existing ModeBleeding.test
// pattern) because the IPC handlers themselves require an Electron app
// runtime to instantiate.
//
// The contract is: every premium handler that ingests user data must call
// isProOrTrialActive() before doing any work, and short-circuit to the
// "Pro license required" error message otherwise.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { findSafeHandle, sliceSafeHandleBlock } from './ipcTestUtils.mjs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = path.resolve(__dirname, '../../ipcHandlers.ts');

// The premium knowledge subsystem was removed, so the upload handlers are
// now graceful no-op stubs (they no longer gate on isProOrTrialActive — there
// is no premium orchestrator to gate). The remaining profile handlers
// (set-mode, research-company, generate-negotiation) still enforce the gate.
const GATED_HANDLERS = [
  'profile:set-mode',
  'profile:research-company',
  'profile:generate-negotiation',
];
const STUB_HANDLERS = [
  'profile:upload-resume',
  'profile:upload-jd',
];

describe('Profile Intelligence IPC: Pro/trial gate', () => {
  const source = fs.readFileSync(SOURCE, 'utf8');

  for (const handler of GATED_HANDLERS) {
    test(`handler "${handler}" calls isProOrTrialActive() before doing work`, () => {
      // Find the handler body — start at safeHandle("name", and run until the
      // matching });
      const idx = findSafeHandle(source, handler);
      assert.ok(idx >= 0, `Handler ${handler} not found in ipcHandlers.ts`);

      const slice = sliceSafeHandleBlock(source, handler).slice(0, 3000);

      // The gate call must appear before the orchestrator is invoked. We
      // assert presence; ordering is verified by a separate index check.
      assert.ok(
        slice.includes('isProOrTrialActive()'),
        `Handler ${handler} must invoke isProOrTrialActive() to enforce the gate`
      );
      assert.ok(
        slice.includes('Pro license required'),
        `Handler ${handler} must return the "Pro license required" error when gated out`
      );

      const gateIdx = slice.indexOf('isProOrTrialActive()');
      const ingestIdx = Math.min(
        ...['ingestDocument', 'getKnowledgeOrchestrator', 'setKnowledgeMode', 'generateNegotiation', 'getCompanyResearchEngine']
          .map(s => {
            const i = slice.indexOf(s);
            return i >= 0 ? i : Number.MAX_SAFE_INTEGER;
          })
      );
      assert.ok(
        gateIdx < ingestIdx,
        `Handler ${handler}: gate check (idx ${gateIdx}) must precede premium work (idx ${ingestIdx})`
      );
    });
  }

  for (const handler of STUB_HANDLERS) {
    test(`handler "${handler}" is a graceful no-op stub (premium removed — no gate to enforce)`, () => {
      const idx = findSafeHandle(source, handler);
      assert.ok(idx >= 0, `Handler ${handler} not found in ipcHandlers.ts`);
      const slice = sliceSafeHandleBlock(source, handler).slice(0, 1500);
      assert.match(slice, /success:\s*false/, `${handler} must return success:false`);
      assert.match(slice, /Feature not available/, `${handler} must report the feature is unavailable without premium`);
      assert.doesNotMatch(slice, /isProOrTrialActive/, `${handler} must not gate — the premium orchestrator is gone`);
    });
  }

  test('profile:get-status returns safe defaults when premium is unavailable (does not call ingest)', () => {
    const idx = findSafeHandle(source, 'profile:get-status');
    assert.ok(idx >= 0);
    const slice = sliceSafeHandleBlock(source, 'profile:get-status').slice(0, 1500);
    // get-status is intentionally NOT gated (it just reports status) — it
    // should return a falsy hasProfile when the orchestrator is missing.
    assert.ok(slice.includes('hasProfile: false'), 'profile:get-status must default to hasProfile=false when orchestrator missing');
  });
});

describe('Profile Intelligence: resume + JD storage tables exist in the schema', () => {
  const dbPath = path.resolve(__dirname, '../../db/DatabaseManager.ts');
  const dbSource = fs.readFileSync(dbPath, 'utf8');

  test('user_profile table is declared', () => {
    assert.ok(dbSource.includes('CREATE TABLE IF NOT EXISTS user_profile'));
  });

  test('resume_nodes table is declared', () => {
    assert.ok(dbSource.includes('CREATE TABLE IF NOT EXISTS resume_nodes'));
  });
});
