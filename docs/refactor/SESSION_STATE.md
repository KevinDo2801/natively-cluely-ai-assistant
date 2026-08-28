# Natively Refactor — Durable Session State (Compact / Handoff)

**Purpose:** This file is the authoritative, self-contained record of the refactor session so work can continue after a context compaction with zero loss. It supersedes narration in the conversation. Repo: `D:\Code\natively-cluely-ai-assistant` (production Electron app, macOS + Windows). Refactor plan approved in `docs/refactor/` (`phase-0-report.md`, `phase-1-report.md`, `phase-2-report.md`).

---

## 1. Goal & rules of the road

- Objective: Phase 0 → 1 → 2 → 3 → 4 → 5 → 6 of the approved plan, keeping `typecheck:electron` + all test suites green on every step.
- Working style: strangler-fig (extract → delegate → verify → delete). No big-bang. No mass reformat. **Move-verbatim** for platform-divergent code.
- Baseline test reality: on a **Windows host**, the electron suite has ~30 **pre-existing failures** (advisory in CI). They are NOT caused by the refactor. Full list below (§8). The macOS CI leg enforces; Windows leg is `continue-on-error` until the 41 pre-existing failures are fixed (Phase 6).

## 2. CRITICAL gotchas (learned the hard way)

1. **NEVER use PowerShell `Set-Content`/`Get-Content` on source files.** It (a) converts LF→CRLF and (b) double-encodes UTF-8 into mojibake (`──` → `â”€`) because `Get-Content` reads UTF-8-no-BOM as cp1252. This broke ~12 tests (format-sensitive `\n` regexes + unicode-marker `indexOf`). **Fixed** by: CRLF→LF normalize + mojibake reversal (encode as cp1252 → decode as UTF-8) via `[System.IO.File]::ReadAllText/WriteAllText` with UTF8-no-BOM. For line-range surgery use the **edit/write tools** (UTF-8 + LF safe) or `.NET File` APIs, never `Set-Content`.
2. **Subagents stall on multi-file source-extraction tasks** (4 stalled: window-helper conversions ×3, main.ts crash/permission ×1). They produced NO edits after many rounds. Small/self-contained tasks (DB migrations, package.json hygiene) succeeded. **Decision: do complex extractions myself; subagents only for self-contained work.**
3. `ipcHandlers.ts` must keep `import './nativeArchGate';` as the FIRST import (boot-order gate). The crash/permission extraction was deferred partly because of this fragility.
4. The `premium` private submodule is absent locally; keep its lazy-`require('../premium/…')` pattern intact. Local typecheck passes without it.

## 3. Completed & VERIFIED (3 phases)

### Phase 0 — Tooling & hygiene (DONE)
- `eslint.config.mjs` (flat, typescript-eslint + react-hooks; all advisory `warn`; **0 errors / ~800 warnings**), `"lint"`/`"lint:fix"` scripts, `.editorconfig`, `.husky/commit-msg` (conventional commits), husky pre-commit now lints staged TS.
- `scripts/count-any.mjs` + `reports/any-baseline.json` — `any`-usage ratchet (**baseline 2,077 / 167 files**), `--check` in CI.
- `package.json`: **60 → 46 runtime deps**. Removed `keytar` (excised everywhere incl. asarUnpack/allowScripts/nativeArch/nativeModuleGuard/rebuild/verify scripts — would have crashed boot otherwise), `three`, `tap`, `liquid-glass-react`, `@paper-design/shaders-react`, `@tavily/core`, `@google/stitch-sdk`, `@elevenlabs/*`, `@tanstack/react-query` (5 dead providers removed from `src/App.tsx`). `@types/marked`,`@types/qrcode` → devDeps. Lockfile refreshed.
- Deleted `renderer/` (legacy CRA), `worker-script/`, `src/components/ui/card.tsx` (0-byte), `src/UI_comp/`. Moved forensics → `docs/archive/`, harnesses → `dev/harness/`. `.gitignore` docs inverted (tracked by default). Removed `natively-api` orphan gitlink.
- **DB migrations extraction**: `DatabaseManager.ts` 4,015 → 2,643 lines; `electron/db/migrations.ts` (33 steps, byte-identical SQL, `up(ctx): boolean` for chain-abort). Fixed 4 source-pin tests + 2 keytar-arch tests.

### Phase 1 — Platform adapters (DONE except crash/permission)
- `electron/platform/macosVersion.ts` — single Darwin mapping (5 sites: main.ts Fontations, ipcHandlers get-os-version + local-whisper-preload, LocalModelDownloadService, whisper/modelManager). Contract test `electron/platform/__tests__/macosVersion.test.mjs`.
- `electron/platform/windowAdapter/{types,shared,darwin,win32,index}.ts` — `createWindowAdapter(platform)` factory (throws on linux per CLAUDE.md). Methods: launcherWindowOptions, panelWindowOptions, cropperWindowOptions, launcherIconPath, applyStealth, applyNativeStealth, stopStealthTapOnShow, reassertAlwaysOnTop, zeroOpacityForHide, setLauncherVibrancy, syncLauncherTaskbarPresence, syncActivationPolicy, applyPopupReveal, applyMultiMonitorSpan, showWithOpacityShield (accepts nullable windows), predicates.
- Converted 4 helpers: `SettingsWindowHelper`, `ModelSelectorWindowHelper`, `CropperWindowHelper`, `WindowHelper` (41/44 branches). 3 intentional inline reads kept: WindowHelper both-platform StealthKeyboardManager sink, linux `forwardSupported`, cropper linux close.
- **Design doc**: `docs/refactor/phase-1-window-adapter-design.md` (branch catalog + divergence findings). **IMPORTANT:** the win32 shield `setContentProtection(contentProtection)` uses the passed value (cropper preserves exact CP), not hardcoded true.
- P1.3: `HindsightManager.autoStartCommand` bash fallback gated off-win32. P1.2: `dnsPatch` → `electron/utils/dnsPatch.ts`.
- Tests: windowAdapter 11/11; batch 66/66; `WindowsPlatformParity` 22/22 (fixed taskbar + chat:focusInput regex).

### Phase 2 — IPC decomposition (IN PROGRESS, foundation done)
- `electron/ipc/safeIpc.ts` — `safeHandle`/`safeOn` (idempotent). `ipcMain` import removed from ipcHandlers.ts.
- 4 domain modules (pattern: `register<Domain>Handlers(deps)` with narrow `Deps` interface):
  - `theme.ts` (`theme:get-mode/set-mode`, deps: getThemeManager)
  - `windowControl.ts` (move-window-*, window-minimize/maximize/close/is-maximized, center-and-show, deps: AppState methods + getWindowHelper)
  - `languages.ts` (get/set-ai-response-language, get-stt-language, get-recognition-languages; deps: processingHelper)
  - `settingsFlags.ts` (open-at-login, verbose-logging, ambient-chat, pill-always-visible, hide-overlay-on-start, auto-answer, code-verification, meeting-retention, provider-data-scopes, screen-understanding-mode, technical-interview-vision-first; deps: AppState getters/setters + SettingsManager + mergeProviderDataScopes)
- `ipcHandlers.ts`: 13,790 → **~12,760 lines**. Removed unused imports (ipcMain, AI_RESPONSE_LANGUAGES/RECOGNITION_LANGUAGES, mergeProviderDataScopes).
- Updated 6 source-pin tests to read `electron/ipc/settingsFlags.ts` too (PillAlwaysVisible, ProviderDataScopeKeyIntegrity, ProviderGatewayPolicy, RetentionUiReachability, RefusedSettingWriteReported, IpcOnIdempotency).

## 4. Verification status (CURRENT)

| Gate | Result |
|---|---|
| `typecheck:electron` (TS7, `node node_modules/typescript7/lib/tsc.js -p electron/tsconfig.json --noEmit`) | **0 errors** |
| Renderer typecheck (root tsconfig) | 0 errors |
| `npm run lint` | 0 errors |
| `count-any --check` | OK |
| Full `npm test` (Windows host) | **8,033 tests / 7,891 pass / 31 fail — ALL 31 pre-existing** (see §8) |
| Targeted Phase-1/2 batches | 66/66 + 86/86 |

## 5. Git status (89 entries — ALL UNCOMMITTED)

47 modified, 10 renamed, 22 deleted, 10 untracked.
- **Untracked (new):** `.editorconfig`, `.husky/commit-msg`, `docs/refactor/`, `electron/db/migrations.ts`, `electron/ipc/`, `electron/platform/`, `electron/utils/dnsPatch.ts`, `eslint.config.mjs`, `reports/any-baseline.json`, `scripts/count-any.mjs`.
- Deleted: `renderer/*`, `worker-script/*`, `src/components/ui/card.tsx`, `src/UI_comp/*`, `natively-api` (gitlink), legacy files.
- Renamed: `docs/archive/*`, `dev/harness/*`, `src/components/ui/calender.png`.
- Not yet committed because the user may want to review. When committing, use conventional commits (hook enforces), e.g. `refactor(ipc): extract theme/windowControl/languages/settingsFlags handlers`.

## 6. Remaining work (next steps)

1. **Phase 2 — continue IPC extraction** (~32 groups left). Easiest next: calendar, skills, logging/context-debug, model selection, update/app control, intelligence-flags/Hindsight, donation. Hardest last: credentials/STT region (~50 CredentialsManager touches), **gemini-chat-stream (~4,600 lines) + phone-mirror subscription** — extract `ChatStreamService` first, then thin-register.
2. **preload.ts split** (2,866 lines) into `electron/preload/<domain>.ts` composed by index; keep channel names.
3. **Phase 3 — LLM core**: LLMHelper (9.7k) → OllamaService, ProviderDispatchService, ScreenshotSolutionService, AppBootstrapService, ModelMetadata→llm/modelCapabilities; IntelligenceEngine `runWhatShouldISay` (4k) → llm/WhatToAnswerPipeline.
4. **Phase 4 — main.ts/AppState** decomposition (crash/permission extraction deferred from P1.2 lives here).
5. **Phase 5 — renderer**: NativelyInterface.tsx (9.4k) leaf-component/hook extraction; electron-api wrapper; delete dead react-query.
6. **Phase 6 — CI/quality**: coverage, fix 31 Windows failures → enforce, Windows release workflow, logger.

## 7. Suggested commit order (when user approves)

1. `build(lint): add flat eslint config + any ratchet + commit-msg hook`
2. `chore(deps): remove 14 unused packages, keytar fully excised`
3. `refactor(repo): archive forensics, delete legacy renderer/worker-script, fix gitignore`
4. `refactor(db): extract migrations into electron/db/migrations.ts`
5. `refactor(platform): add macosVersion + windowAdapter; convert 4 window helpers`
6. `refactor(ipc): extract safeIpc + theme/windowControl/languages/settingsFlags`

## 8. Pre-existing Windows-host failures (31 — NOT from refactor)

- **ESM-scheme** (`ERR_UNSUPPORTED_ESM_URL_SCHEME` / `D:\D:\` double-drive): MeetingLifecycleDbLiveness, CropperDisposeClosesWindow, CropperRefitsOnShow, LexicalFloorScaleF23, LexicalTokensNumerals, LitellmModelLabel, LocalEmbedBatchF22, SttReconfigureSerialization.
- **Credential degraded-store** (`CredentialDegradedStoreGuard2026_08_05` + `CredentialPersistenceBehavior`): keyring-unreadable, refused-write, Codex rotation, EVERY-method-guard, resetDegraded, fresh-install, disk-write, setSttProvider, degraded settings store, setScreenUnderstandingMode, setContextDebugLevel, memory-diverge.
- **Packaged-layout sim**: LocalReranker.isCached (packaged resourcesPath).
- **Source drift from HEAD's junk commits**: Profile Intelligence renderer (PremiumUpgradeModal/browseResume/browseJD), ModeReferenceFileIngestResult, renderer trial type defs.
- **Env**: SkillsManager.deleteSkill symlink (Windows privileges).
- Fixing these is **Phase 6** (they are the CI-documented 41-→31 Windows advisory suite).

## 9. Key files (for quick orientation)

- Plan: `docs/refactor/phase-{0,1,2}-report.md` + `phase-1-window-adapter-design.md`.
- God files: `electron/ipcHandlers.ts` (12.8k), `electron/LLMHelper.ts` (9.7k), `electron/main.ts` (9.1k), `src/components/NativelyInterface.tsx` (9.4k), `electron/IntelligenceEngine.ts` (6k), `electron/db/DatabaseManager.ts` (2.6k), `electron/preload.ts` (2.8k).
- Healthy dirs (destinations, don't refactor): `electron/services/` (122), `electron/llm/` (108), `electron/intelligence/` (63).
