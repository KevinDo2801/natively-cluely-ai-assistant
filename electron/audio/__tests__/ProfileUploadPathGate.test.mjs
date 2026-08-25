import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ipcHandlersPath = path.resolve(__dirname, '../../../electron/ipcHandlers.ts');
const ipcSource = readFileSync(ipcHandlersPath, 'utf8');

function extractHandler(channel) {
  const start = ipcSource.indexOf(`safeHandle('${channel}'`);
  assert.ok(start >= 0, `could not locate ${channel}`);
  let i = ipcSource.indexOf('{', start);
  let depth = 1;
  const bodyStart = i + 1;
  i++;
  while (i < ipcSource.length && depth > 0) {
    const ch = ipcSource[i];
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    i++;
  }
  assert.equal(depth, 0, `unbalanced braces while extracting ${channel}`);
  return ipcSource.slice(bodyStart, i - 1);
}

test('profile upload handlers are graceful no-op stubs after premium removal', () => {
  // The premium knowledge subsystem (and the orchestrator ingest path these
  // handlers fed) was removed, so the upload handlers no longer consume the
  // path allowlist — they are stubs returning 'Feature not available.'.
  // The allowlist helpers themselves still exist (used by profile:select-file),
  // so assert the handlers do NOT reference the removed ingest surface.
  for (const channel of ['profile:upload-resume', 'profile:upload-jd']) {
    const body = extractHandler(channel);
    assert.match(body, /success:\s*false/, `${channel} must return success:false`);
    assert.match(body, /Feature not available/, `${channel} must report the feature is unavailable without premium`);
    assert.doesNotMatch(body, /consumeSelectedProfilePath/, `${channel} must not consume the allowlist — the premium ingest path is gone`);
    assert.doesNotMatch(body, /ingestDocument\s*\(/, `${channel} must not call ingestDocument — the premium orchestrator is gone`);
  }
});
