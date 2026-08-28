// electron/platform/__tests__/macosVersion.test.mjs
//
// Contract test for the single Darwin→macOS mapping module (Phase 1 of the
// refactor). Before electron/platform/macosVersion.ts existed, the parse was
// copy-pasted across five call sites with three different fallback behaviors;
// the point of the module is that this mapping can never drift again.
//
// Platform + release are injected (repo cross-platform contract: no
// process.platform mutation in tests), so every darwin branch runs on any
// host — including this Windows CI leg.
//
// Run: `npm run build:electron` then ELECTRON_RUN_AS_NODE=1 electron --test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COMPILED = path.resolve(__dirname, '../../../dist-electron/electron/platform/macosVersion.js');

// createRequire, not await import(): the compiled bundle is CJS, and a bare
// absolute path is not a valid ESM specifier on Windows (d:\ protocol).
const require = Module.createRequire(import.meta.url);
const {
  parseDarwinMajor,
  darwinMajorVersion,
  macOSMajorFromDarwin,
  isMacOS13VenturaOrLater,
  DARWIN_MAJOR_MACOS_13_VENTURA,
} = require(COMPILED);

test('parseDarwinMajor parses the kernel major and fails safe to 0', () => {
  assert.equal(parseDarwinMajor('25.1.0'), 25);
  assert.equal(parseDarwinMajor('22.6.0'), 22);
  assert.equal(parseDarwinMajor('21.0.0'), 21);
  // Unparseable → 0, which every threshold gate treats as "too old/unknown".
  assert.equal(parseDarwinMajor(''), 0);
  assert.equal(parseDarwinMajor('not-a-version'), 0);
});

test('darwinMajorVersion is 0 off-darwin so gates stay false on Windows', () => {
  assert.equal(darwinMajorVersion('darwin', '25.1.0'), 25);
  assert.equal(darwinMajorVersion('win32', '10.0.26100'), 0);
  assert.equal(darwinMajorVersion('linux', '6.8.0'), 0);
});

test('macOSMajorFromDarwin covers both numbering schemes', () => {
  // Calendar-year scheme: Darwin 25 = macOS 26.
  assert.equal(macOSMajorFromDarwin(25), 26);
  assert.equal(macOSMajorFromDarwin(26), 27);
  // Legacy scheme: Darwin 20–24 = macOS 11–15.
  assert.equal(macOSMajorFromDarwin(24), 15);
  assert.equal(macOSMajorFromDarwin(22), 13);
  assert.equal(macOSMajorFromDarwin(20), 11);
  // Anything older is unmapped (caller renders the raw release string).
  assert.equal(macOSMajorFromDarwin(19), null);
  assert.equal(macOSMajorFromDarwin(0), null);
});

test('Ventura gate: Darwin >= 22 on darwin, always true off-darwin', () => {
  assert.equal(DARWIN_MAJOR_MACOS_13_VENTURA, 22);
  assert.equal(isMacOS13VenturaOrLater('darwin', '22.6.0'), true);
  assert.equal(isMacOS13VenturaOrLater('darwin', '25.1.0'), true);
  // Monterey and earlier are rejected (onnxruntime libc++ symbol gap).
  assert.equal(isMacOS13VenturaOrLater('darwin', '21.6.0'), false);
  assert.equal(isMacOS13VenturaOrLater('darwin', '20.6.0'), false);
  // Unparseable release on a Mac fails safe → rejected.
  assert.equal(isMacOS13VenturaOrLater('darwin', 'garbage'), false);
  // Windows/Linux are not subject to the macOS dylib constraint at all.
  assert.equal(isMacOS13VenturaOrLater('win32', '10.0.19045'), true);
  assert.equal(isMacOS13VenturaOrLater('linux', '6.8.0'), true);
});
