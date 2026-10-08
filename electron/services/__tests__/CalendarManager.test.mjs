// electron/services/__tests__/CalendarManager.test.mjs
//
// Source-level guards for CalendarManager's Google OAuth token lifecycle.
// The class imports `electron` (safeStorage, shell, net), so these tests pin
// the critical behaviour via the source rather than importing it. The two
// behaviours that matter for "my calendar link keeps expiring":
//
//   1. The auth URL asks for offline access + forced consent, so Google
//      actually returns a refresh_token that can outlive a single launch.
//   2. A refresh failure is classified: permanent (invalid_grant etc.) clears
//      the saved token, but a TRANSIENT failure (network blip, proxy down,
//      401 auth_required, 5xx) KEEPS the refresh token so the next launch
//      retries instead of forcing the user to re-link.
//   3. A proactive timer refreshes the access token before it expires.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../../..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

const source = () => read('electron/services/CalendarManager.ts');

test('CalendarManager auth URL requests offline access + forced consent (refresh_token)', () => {
  const src = source();
  // Without access_type=offline Google returns only an access token, and the
  // user would have to re-consent on every launch. Pin both.
  assert.match(src, /access_type:\s*'offline'/);
  assert.match(src, /prompt:\s*'consent'/);
  // Readonly scope — the app never needs write access to the calendar.
  assert.match(src, /https:\/\/www\.googleapis\.com\/auth\/calendar\.readonly/);
});

test('CalendarManager refresh only disconnects on permanent Google OAuth errors', () => {
  const src = source();
  // The permanent classification list.
  assert.match(src, /PERMANENT_REFRESH_ERROR_CODES\s*=\s*\[[^\]]*'invalid_grant'[^\]]*'invalid_client'[^\]]*'unauthorized_client'[^\]]*\]/);
  // Permanent branch clears credentials via disconnect().
  assert.match(src, /failed permanently[^\n]*disconnecting[\s\S]*?this\.disconnect\(\)/);
});

test('CalendarManager keeps the refresh token on transient refresh failures', () => {
  const src = source();
  // The transient branch must NOT call disconnect(). It logs a marker and
  // returns false, leaving the persisted refresh token in place.
  assert.match(src, /failed transiently — keeping stored refresh token for retry/);
  // The catch must return false so callers know the token was not refreshed.
  assert.match(src, /return false;\s*\n\s*}\s*\n\s*}\s*\n/);
});

test('CalendarManager schedules a proactive pre-expiry refresh', () => {
  const src = source();
  assert.match(src, /scheduleRefresh\(\)/);
  assert.match(src, /REFRESH_LEAD_MS\s*=\s*5 \* 60 \* 1000/);
  assert.match(src, /setTimeout\(\(\) => \{\s*\n\s*void this\.refreshAccessToken\(\);\s*\n\s*\}, delay\)/);
});

test('CalendarManager defaults expires_in defensively to avoid NaN expiry', () => {
  const src = source();
  // A malformed/absent expires_in must fall back to 3600s, not poison expiryDate.
  assert.match(src, /Number\.isFinite\(data\.expires_in\)/);
  assert.match(src, /: 3600;/);
});
