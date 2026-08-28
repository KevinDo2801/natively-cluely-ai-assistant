# Refactor Phase 1 — WindowAdapter (Completion Report)

Date: 2026-08 (Phase 1 of the approved refactor plan). Scope: platform adapter layer + the four window helpers.

## Summary

Extracted the scattered `process.platform` window behavior into a single injectable **WindowAdapter** under `electron/platform/windowAdapter/`, converting all four window helpers to consume it. Combined with the earlier `electron/platform/macosVersion.ts` (Darwin mapping), `process.platform` reads in the window layer dropped from ~44 inline branches to 3 intentional linux-only / both-platform guards.

## New files

- `electron/platform/windowAdapter/types.ts` — `WindowAdapter` interface, `ApplyStealthOptions`, `RevealOptions`, `TimerSlot`, `LauncherDisguise`.
- `electron/platform/windowAdapter/shared.ts` — disguise-icon name map.
- `electron/platform/windowAdapter/darwin.ts` — macOS impl (NSPanel flags, Spaces/Mission Control, native `applyStealthToWindow`, vibrancy).
- `electron/platform/windowAdapter/win32.ts` — Windows impl (screen-saver topmost, DWM opacity shield, skipTaskbar, multi-monitor span, activation-policy sync).
- `electron/platform/windowAdapter/index.ts` — exhaustive `createWindowAdapter(platform)` factory (throws on linux per CLAUDE.md contract).
- `electron/platform/__tests__/windowAdapter.test.mjs` — contract test (both branches on any host, mock windows), **11/11 pass**.

## Files converted (41 of 44 branches moved)

| File | Branches | Notes |
|---|---|---|
| `electron/SettingsWindowHelper.ts` | 6 | canonical forms — panel, stealth, native stealth, stop-tap, shield, activation-policy |
| `electron/ModelSelectorWindowHelper.ts` | 7 | adds `applyPopupReveal` (per-show darwin re-sync) |
| `electron/CropperWindowHelper.ts` | 8 | `forceShield`, `'screen-saver'` level (no MC), env `delayMs`, multi-monitor span; linux close branch kept |
| `electron/WindowHelper.ts` | 23 | launcher/overlay/aux/popover-catcher stealth, group shield, vibrancy, taskbar, focus-steal gate |

Kept in helpers (3): `WindowHelper.ts` both-platform StealthKeyboardManager sink (test-pinned), `WindowHelper.ts` linux-only `forwardSupported`, `CropperWindowHelper.ts` linux close path.

## Behavior-preservation detail (the design's divergence findings)

- **Cropper shield CP value**: cropper's original shield set `setContentProtection(isUndetectable)` (not hardcoded true). The adapter's win32 shield now uses the passed `contentProtection` value, so Settings/Model/WindowHelper (which enter the shield only when their CP is already true) are unaffected and cropper's exact value is preserved.
- **Popover-catcher relativeLevel −1**: darwin-only, no `win32ReassertTopmost` (kept darwin-only).
- **Group vs single-window shield**: `windows[]` + per-helper `TimerSlot` preserve "a second shield can't cancel the first helper's pending restore".
- **applyNativeStealth ordering**: registered immediately after `new BrowserWindow`, before each helper's own `ready-to-show`, so stealth precedes show (matches the earlier consolidated-ordering intent).

## Test changes

- **`WindowsPlatformParity.test.mjs`**: taskbar assertions updated to the adapter delegation; the pre-existing `chat:focusInput` HEAD failure (regex demanded `showMainWindow` adjacency; HEAD legitimately routes launcher mode to `revealOverlayForGlobalShortcut`) fixed to accept either call. **22/22 pass** (was 21/22 + 1 pre-existing at HEAD).
- **`OverlayAuxVisibilityOrdering.test.mjs`**: switchToLauncher/switchToOverlay ordering assertions updated to the adapter reveal call; the win32 shield-timing and aux-show-in-same-block guarantees now covered by the adapter contract test.
- **`StopMeetingActivationReclaim.test.mjs`**: darwin gate assertion → `this.adapter.mayStealFocusOnLauncherShow()`.
- **`UndetectableDockLeakOnLauncherShow.test.mjs`**: darwin gate → `this.adapter.isMac()`; reassert-after-show order updated to the adapter reveal call.

## Validation (Phase 1 closure)

| Gate | Result |
|---|---|
| `typecheck:electron` (TS7) | **0 errors** |
| `npm run lint` | 0 errors (~802 warnings, advisory) |
| windowAdapter contract test | 11/11 |
| platform + window batch (OverlayAuxVisibilityOrdering, StopMeetingActivationReclaim, UndetectableDockLeak, WindowsPlatformParity, SettingsAnchor, SetContentProtectionDedupe, Cropper.bounds) | 66/66 |
| Full `npm test` (Windows) | see run in `docs/refactor/phase-0-report.md` §full-suite triage (same pre-existing Windows-host failures; no new regressions) |

## Cross-platform

- macOS behavior: preserved exactly (all darwin branches moved verbatim; NSPanel/native-stealth path unchanged, lazy-requires re-based for the deeper module dir).
- Windows behavior: preserved exactly (screen-saver topmost, DWM shield timing, taskbar, activation-policy).
- `Covered by automated darwin-branch tests` + `Covered by automated Windows-branch tests` (windowAdapter.test.mjs runs both branches on any host).
- `Reviewed but not executed on macOS` — native `applyStealthToWindow` call path (requires rebuilt native module; physical macOS smoke pending for shield timing + dock behavior).
- `Requires physical macOS verification` — before release.

## Remaining Phase 1 items (next)

- P1.2 `main.ts` extractions: crash/log subsystem → `utils/crashReporting.ts`, `dns.lookup` monkey-patch → `utils/dnsPatch.ts`, macOS permission subsystem → `platform/darwin/permissions.ts`.

## P1.3 (done) — Hindsight Windows launcher path

`HindsightManager.autoStartCommand()` zero-config fallback (`bash scripts/hindsight-start.sh`) is now gated off-win32: on Windows the bash-based fallback no longer auto-applies (no guaranteed bash there); auto-start on Windows requires an EXPLICIT `hindsightServerCommand` (a Windows-native launcher the user configures). macOS/Linux behavior unchanged. Hindsight test suite: 38 pass / 0 fail. typecheck 0 errors.
