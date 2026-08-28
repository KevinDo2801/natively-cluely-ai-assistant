// ============================================================================
// macOS version mapping — the SINGLE place Darwin kernel majors are parsed.
//
// Before this module existed, `parseInt(os.release().split('.')[0], 10)` was
// copy-pasted across five call sites (main.ts Fontations gate, ipcHandlers
// get-os-version, ipcHandlers local-whisper-preload, LocalModelDownloadService
// preflightCheck, whisper/modelManager getAvailableModels) with three slightly
// different fallback behaviours. Every one of them gates a macOS-version-only
// feature, so a drift in the mapping ships a real bug (e.g. Ventura users
// offered Whisper models whose onnxruntime dylib cannot load).
//
// Platform + release are injectable so tests can exercise darwin branches on
// any host without mutating `process.platform` (repo cross-platform contract).
// ============================================================================

import os from 'os';

/**
 * Parse the Darwin kernel major from an `os.release()` string.
 * Returns 0 when the release string is unparseable — callers gate on
 * thresholds (>= 22, >= 25), so 0 means "too old / unknown" and fails safe.
 */
export function parseDarwinMajor(release: string): number {
  const major = parseInt((release || '').split('.')[0] || '0', 10);
  return Number.isNaN(major) ? 0 : major;
}

/**
 * Darwin kernel major of the current machine. Always 0 off-darwin, which
 * keeps every threshold gate false on Windows/Linux without a platform
 * branch at the call site.
 */
export function darwinMajorVersion(
  platform: NodeJS.Platform = process.platform,
  release: string = os.release(),
): number {
  return platform === 'darwin' ? parseDarwinMajor(release) : 0;
}

/**
 * Map a Darwin kernel major to the macOS marketing major version.
 *   Darwin 25+  → macOS 26+ (calendar-year scheme, major = darwin + 1)
 *   Darwin 20–24 → macOS 11–15 (major = darwin − 9)
 *   anything else → null (caller decides how to render it)
 */
export function macOSMajorFromDarwin(darwinMajor: number): number | null {
  if (darwinMajor >= 25) return darwinMajor + 1;
  if (darwinMajor >= 20) return darwinMajor - 9;
  return null;
}

/**
 * The shared Ventura (macOS 13 / Darwin 22) gate used by the local-Whisper
 * surfaces. onnxruntime-node 1.22.0 links libc++ symbols (std::to_chars for
 * double) that only exist on macOS 13+; on Monterey and earlier the dylib
 * load fails with "Symbol not found: __ZNSt3__18to_charsEPcS0_d".
 */
export const DARWIN_MAJOR_MACOS_13_VENTURA = 22;

export function isMacOS13VenturaOrLater(
  platform: NodeJS.Platform = process.platform,
  release: string = os.release(),
): boolean {
  // Non-darwin hosts are not subject to the macOS dylib constraint at all.
  if (platform !== 'darwin') return true;
  return parseDarwinMajor(release) >= DARWIN_MAJOR_MACOS_13_VENTURA;
}
