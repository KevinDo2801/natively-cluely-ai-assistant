// electron/services/knowledge/__tests__/DeleteProfileTransactional2026_07_25.test.mjs
//
// Phase 6 Slice 5 (context-rebuild, 05_MIGRATION_PLAN.md Slice 5 item 4):
// "UnifiedKnowledgeStore.deleteProfile(kind) becomes the only delete
// entrypoint, calling both tiers in one transaction" — upgrading the
// 2026-07-25 RC6 two-call fix (profile:delete / profile:delete-jd), which
// warned-and-swallowed a Tier 2 failure leaving Tier 1 deleted and Tier 2
// orphaned, to a real cross-tier transaction.
//
// The premium knowledge subsystem has since been REMOVED, so the
// `profile:delete` / `profile:delete-jd` IPC handlers no longer delegate to
// deleteProfileTransactional — they are graceful no-op stubs returning
// `{ success: false, error: 'Feature not available.' }`. This file retains
// the structural tests on deleteProfileTransactional.ts (which still exists as
// a module) and updates the handler-delegation assertions to pin the stubs'
// new contract.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../../..');

const deleteModuleSrc = readFileSync(
  path.resolve(__dirname, '../deleteProfileTransactional.ts'),
  'utf8',
);
const ipcSrc = readFileSync(path.resolve(repoRoot, 'electron/ipcHandlers.ts'), 'utf8');

describe('deleteProfileTransactional.ts wraps both tiers in one real transaction', () => {
  test('both deletes are called INSIDE a single DatabaseManager.getInstance().runInTransaction(...) closure', () => {
    const fnStart = deleteModuleSrc.indexOf('export function deleteProfileTransactional');
    assert.ok(fnStart >= 0, 'deleteProfileTransactional must be exported');
    const fnBody = deleteModuleSrc.slice(fnStart);
    const txStart = fnBody.indexOf('runInTransaction(() => {');
    assert.ok(txStart >= 0, 'must call DatabaseManager.getInstance().runInTransaction with a closure');
    const txBody = fnBody.slice(txStart, fnBody.indexOf('});', txStart));
    assert.match(txBody, /orchestrator\.deleteDocumentsByType\(docType\)/, 'Tier 1 delete must be inside the transaction closure');
    assert.match(txBody, /ProfilePackBuilder\.getInstance\(\)\.deleteProfilePack\(kind\)/, 'Tier 2 delete must be inside the transaction closure');
  });

  test('imports the real DatabaseManager and ProfilePackBuilder singletons (not a mock/stub)', () => {
    assert.match(deleteModuleSrc, /import \{ DatabaseManager \} from '\.\.\/\.\.\/db\/DatabaseManager'/);
    assert.match(deleteModuleSrc, /import \{ ProfilePackBuilder \} from '\.\/ProfilePackBuilder'/);
  });
});

describe('profile:delete / profile:delete-jd IPC handlers are graceful no-op stubs (premium removed)', () => {
  function handlerBody(routeName) {
    const start = ipcSrc.indexOf(`safeHandle('${routeName}'`);
    assert.ok(start >= 0, `${routeName} handler must exist`);
    const end = ipcSrc.indexOf('\n  });', start);
    return ipcSrc.slice(start, end);
  }

  for (const routeName of ['profile:delete', 'profile:delete-jd']) {
    test(`${routeName} returns feature-unavailable without calling deleteProfileTransactional`, () => {
      const body = handlerBody(routeName);
      assert.match(body, /success:\s*false/);
      assert.match(body, /Feature not available/);
      assert.doesNotMatch(body, /deleteProfileTransactional/, 'premium transactional delete is not called in a stub');
    });
  }
});
