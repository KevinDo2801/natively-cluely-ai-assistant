/**
 * LauncherLiveBadge.test.mjs
 *
 * LIVE MEETING NOTE (v31) — source-contract guard on Launcher.tsx.
 *
 * The Launcher history list must render a distinct "Live" badge for the
 * meeting row created at Start (is_live=1) instead of the usual duration/time
 * pill, so the user can spot the live note immediately.
 *
 * Source check (no DOM) — same convention as the other component guards.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.resolve(__dirname, '../Launcher.tsx');
const source = fs.readFileSync(sourcePath, 'utf8');

describe('Launcher live meeting badge (v31)', () => {
  test('list entries branch on the isLive flag', () => {
    assert.match(source, /m\.isLive \? \(/,
      'the meeting entry must branch on isLive');
  });

  test('live entries render the localized Live badge instead of duration/time', () => {
    assert.match(source, /\{t\('Live'\)\}/,
      'the badge must use the i18n key (falls back to English)');
    assert.match(source, /animate-pulse/,
      'the badge should carry a subtle live pulse');
  });

  test('the Meeting type carries isLive', () => {
    assert.match(source, /isLive\?: boolean; \/\/ Live meeting note \(v31\)/,
      'the Launcher Meeting interface must expose isLive so the badge branch typechecks');
  });
});
