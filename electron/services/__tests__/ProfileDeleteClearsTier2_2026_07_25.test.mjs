// electron/services/__tests__/ProfileDeleteClearsTier2_2026_07_25.test.mjs
//
// This suite source-pinned the premium profile-delete IPC handlers
// (`profile:delete` / `profile:delete-jd`) to assert they delegated to
// `deleteProfileTransactional()` so both tiers (orchestrator context_nodes +
// knowledge_cards) cleared in one transaction.
//
// The premium knowledge subsystem (orchestrator, DocType, deleteProfileTransactional's
// premium Tier-1 path) has been REMOVED, so those handlers are now graceful no-op
// stubs returning `{ success: false, error: 'Feature not available.' }`. The
// cross-tier transactional coverage they guarded lived in the premium module and is
// gone with it. This file is updated to assert the stubs' new contract so the suite
// keeps compiling and passing without a premium module.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ipcSrc = readFileSync(path.resolve(__dirname, '../../ipcHandlers.ts'), 'utf8');

describe('profile:delete stub (premium removed)', () => {
  const handlerStart = ipcSrc.indexOf("safeHandle('profile:delete', async () => {");
  const handlerEnd = ipcSrc.indexOf("safeHandle('profile:get-profile'", handlerStart);
  const handlerSrc = ipcSrc.slice(handlerStart, handlerEnd);

  test('the handler exists and is isolated correctly', () => {
    assert.ok(handlerStart >= 0, "profile:delete handler should exist");
    assert.ok(handlerEnd > handlerStart, 'handler source should be isolated');
  });

  test('the handler is a graceful no-op (feature unavailable without premium)', () => {
    assert.match(handlerSrc, /success:\s*false/);
    assert.match(handlerSrc, /Feature not available/);
  });
});

describe('profile:delete-jd stub (premium removed)', () => {
  const handlerStart = ipcSrc.indexOf("safeHandle('profile:delete-jd', async () => {");
  const handlerEnd = ipcSrc.indexOf('});', handlerStart) + 3;
  const handlerSrc = ipcSrc.slice(handlerStart, handlerEnd);

  test('the handler exists and is isolated correctly', () => {
    assert.ok(handlerStart >= 0, "profile:delete-jd handler should exist");
    assert.ok(handlerEnd > handlerStart, 'handler source should be isolated');
  });

  test('the handler is a graceful no-op (feature unavailable without premium)', () => {
    assert.match(handlerSrc, /success:\s*false/);
    assert.match(handlerSrc, /Feature not available/);
  });
});
