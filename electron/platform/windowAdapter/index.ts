import type { WindowAdapter } from './types';
import { createDarwinWindowAdapter } from './darwin';
import { createWin32WindowAdapter } from './win32';

export type {
  WindowAdapter,
  ApplyStealthOptions,
  RevealOptions,
  TimerSlot,
  LauncherDisguise,
} from './types';

/**
 * Exhaustive platform factory (CLAUDE.md contract): injectable platform so
 * contract tests can exercise both branches on any host without mutating
 * `process.platform`.
 */
export function createWindowAdapter(platform: NodeJS.Platform = process.platform): WindowAdapter {
  switch (platform) {
    case 'darwin':
      return createDarwinWindowAdapter();
    case 'win32':
      return createWin32WindowAdapter();
    default:
      throw new Error(`Unsupported platform: ${platform}`);
  }
}
