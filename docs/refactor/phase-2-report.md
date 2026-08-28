# Refactor Phase 2 — IPC Decomposition (Progress Report)

Date: 2026-08 (Phase 2 of the approved refactor plan). Status: IN PROGRESS — foundation + 4 domain modules extracted; ~32 groups remain.

## Pattern established

Every IPC domain module in `electron/ipc/` follows the same shape:

```ts
// electron/ipc/<domain>.ts
import { safeHandle, safeOn } from './safeIpc';

export interface <Domain>Deps {   // NARROW interface — only the methods used
  getX(): Y;
  ...
}
export function register<Domain>Handlers(deps: <Domain>Deps): void { ... }
```

`initializeIpcHandlers()` (ipcHandlers.ts) calls `register<Domain>Handlers(appState)` — passing AppState only where it structurally satisfies the narrow interface, never coupling the module to the whole god object.

## Extracted modules

| Module | Channels | Deps |
|---|---|---|
| `electron/ipc/safeIpc.ts` | — (helpers) | `safeHandle` / `safeOn` (idempotent registration) |
| `electron/ipc/theme.ts` | `theme:get-mode`, `theme:set-mode` | `getThemeManager()` |
| `electron/ipc/windowControl.ts` | `move-window-*`, `center-and-show-window`, `window-minimize/maximize/close/is-maximized` | `moveWindow*()`, `getWindowHelper()` |
| `electron/ipc/languages.ts` | `get/set-ai-response-language`, `get-stt-language`, `get-recognition-languages`, `get-ai-response-languages` | `processingHelper` |
| `electron/ipc/settingsFlags.ts` | open-at-login, verbose-logging, ambient-chat, pill-always-visible, hide-overlay-on-start, auto-answer, code-verification, meeting-retention, provider-data-scopes, screen-understanding-mode, technical-interview-vision-first | AppState getters/setters + SettingsManager singleton |

`ipcHandlers.ts` reduced from 13,790 → ~12,760 lines (−1,030) so far.

## Test updates (source-pin tests that asserted handlers inline in ipcHandlers.ts)

Updated to read `electron/ipc/settingsFlags.ts` in addition (robust regardless of which file owns a handler today):
- `PillAlwaysVisible.test.mjs` (pill-always-visible handler + regex now accepts `deps.`)
- `ProviderDataScopeKeyIntegrity2026_08_01.test.mjs` (scope-key + handler assertions)
- `ProviderGatewayPolicy.test.mjs` (provider-data-scopes handler)
- `RetentionUiReachability.test.mjs` (meeting-retention handler)
- `RefusedSettingWriteReported2026_08_21.test.mjs` (degraded-store handlers)
- `IpcOnIdempotency.test.mjs` (safeOn definition now in safeIpc.ts)

## INCIDENT — PowerShell UTF-8 corruption (important lesson)

While removing the settings-flags block with PowerShell `Get-Content`/`Set-Content -Encoding UTF8`, the file's non-ASCII characters (box-drawing `──`, arrows, em-dashes) were DOUBLE-ENCODED into mojibake (`─` → `â”€`), because `Get-Content` read the UTF-8 file using the system ANSI codepage (cp1252). This silently broke several source-reading tests (format-sensitive `\n` patterns AND unicode-marker `indexOf` lookups), e.g. `TruncatedAnswerNotStored`, `OverlayAuxVisibilityOrdering`, `PillAlwaysVisible`, the group-drag test.

**Root cause:** PowerShell 5.1 `Get-Content`/`Set-Content` are not encoding-safe for UTF-8-without-BOM source files, and `Set-Content` also forces CRLF.

**Fix applied:** (1) convert CRLF→LF, (2) reverse the mojibake by encoding the mangled string as cp1252 then decoding as UTF-8. Verified `U+2500` present again + LF line endings.

**Lesson (repo rule):** NEVER use PowerShell `Set-Content`/`Get-Content` on source files. Use the edit/write tools (which preserve UTF-8 + LF) or, for line-range surgery, a .NET `[System.IO.File]::ReadAllText`/`WriteAllText` with UTF8-no-BOM and explicit CRLF→LF normalization.

## Validation (so far)

| Gate | Result |
|---|---|
| `typecheck:electron` (TS7) | 0 errors |
| Targeted batch (OverlayAuxVisibilityOrdering, PillAlwaysVisible, ProviderDataScopeKeyIntegrity, ProviderGatewayPolicy, RetentionUiReachability, RefusedSettingWriteReported, IpcOnIdempotency, TruncatedAnswerNotStored, windowAdapter, macosVersion) | 86/86 |
| Full `npm test` (Windows) | pending final confirmation |

## Next

- Extract more domain groups (calendar, skills, logging/context-debug, model selection, update/app control, intelligence flags, credential STT region, ...).
- The largest (gemini-chat-stream ~4,600 lines + phone-mirror subscription) requires extracting `ChatStreamService` first — deferred to a dedicated step.
