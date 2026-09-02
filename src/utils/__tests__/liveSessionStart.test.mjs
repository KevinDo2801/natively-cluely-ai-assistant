/**
 * liveSessionStart.test.mjs
 *
 * Unit tests for the live "Active Session" timer anchor resolver
 * (src/utils/liveSessionStart.ts).
 *
 * The resolver must NEVER produce the phantom "800–900 minutes at the start of
 * a meeting" count. That bug happened when the pill timed from a stale
 * localStorage anchor left over from an earlier meeting (started/stopped
 * through main-only paths — global hotkey, calendar auto-start — that never
 * write/clear the key), while the live meeting row had a fresh start.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolveLiveSessionStartMs, LIVE_SESSION_START_KEY } from '../liveSessionStart.ts';

const HOUR = 3600_000;
const MIN = 60_000;

// Fake storage with the given anchor (or empty).
const storageWith = (anchor) => {
  const map = new Map();
  if (anchor !== null) map.set(LIVE_SESSION_START_KEY, String(anchor));
  return { getItem: (k) => map.get(k) ?? null };
};

describe('resolveLiveSessionStartMs', () => {
  test('exposes the same localStorage key the start/stop flows write', () => {
    assert.equal(LIVE_SESSION_START_KEY, 'natively_last_meeting_start');
  });

  test('fresh meeting with a matching fresh anchor → later anchor wins (both ≈ now)', () => {
    const rowMs = Date.now() - 2000; // row created ~2s after the click
    const anchor = resolveLiveSessionStartMs(new Date(rowMs).toISOString(), storageWith(rowMs - 2));
    assert.equal(anchor, rowMs);
  });

  test('STALE anchor from an earlier meeting (older than the live row) is discarded → row start wins', () => {
    const rowMs = Date.now() - MIN; // meeting started 1 min ago
    const staleAnchor = rowMs - 14 * HOUR; // yesterday's leftover → ~840 phantom minutes
    const anchor = resolveLiveSessionStartMs(new Date(rowMs).toISOString(), storageWith(staleAnchor));
    assert.equal(anchor, rowMs, 'the timer must anchor to the live row, not the stale key');
  });

  test('resume ("Continue this session") keeps the ORIGINAL row start; the newer resume-click anchor wins', () => {
    const originalRowMs = Date.now() - 5 * HOUR; // original meeting start, 5h ago
    const resumeClickMs = Date.now() - MIN; // resumed 1 min ago
    const anchor = resolveLiveSessionStartMs(new Date(originalRowMs).toISOString(), storageWith(resumeClickMs));
    assert.equal(anchor, resumeClickMs, 'a resumed session must time from the resume click');
  });

  test('no localStorage anchor (meeting started via global hotkey/calendar) → row start wins', () => {
    const rowMs = Date.now() - MIN;
    const anchor = resolveLiveSessionStartMs(new Date(rowMs).toISOString(), storageWith(null));
    assert.equal(anchor, rowMs);
  });

  test('no row start and no anchor → falls back to now (elapsed 0)', () => {
    const before = Date.now();
    const anchor = resolveLiveSessionStartMs(null, storageWith(null));
    const after = Date.now();
    assert.ok(anchor >= before && anchor <= after, `anchor ${anchor} must be ~now`);
  });

  test('garbage localStorage value is ignored → row start wins', () => {
    const rowMs = Date.now() - MIN;
    const store = { getItem: () => 'not-a-number' };
    const anchor = resolveLiveSessionStartMs(new Date(rowMs).toISOString(), store);
    assert.equal(anchor, rowMs);
  });

  test('invalid row date falls back to a valid stored anchor', () => {
    const anchorMs = Date.now() - MIN;
    const anchor = resolveLiveSessionStartMs('not-a-date', storageWith(anchorMs));
    assert.equal(anchor, anchorMs);
  });
});
