# Refactor Phase 0 — Completion Report

Date: 2026-08 (Phase 0 of the approved codebase refactor plan).
Scope: tooling, repo hygiene, dependency cleanup, DatabaseManager migration extraction, plus one Phase-1 head-start (platform/macosVersion).

## Change summary

### Tooling (new)
- `eslint.config.mjs` — flat config, typescript-eslint + react-hooks, all rules advisory (`warn`), 0 errors / ~800 warnings baseline. `npm run lint` / `lint:fix` scripts added. Wired into `.husky/pre-commit` (staged files, blocking on errors) and `build-smoke.yml` (advisory step).
- `.editorconfig` — LF/utf-8/2-space, mirrors `.gitattributes`.
- `scripts/count-any.mjs` + `reports/any-baseline.json` — `any`-usage ratchet (baseline **2,078 across 168 files**). `--check` fails CI when any file's count increases; wired into `build-smoke.yml` as an enforcing step.
- `.husky/commit-msg` — minimal conventional-commit enforcement (rejects "good" / "1 2 3 4 5 6 7"-style messages).

### Dependency hygiene (60 → 46 runtime deps)
- Removed with zero first-party imports (verified by grep + lockfile refresh): `keytar`+`@types/keytar`, `tap`, `three`+`@types/three`, `liquid-glass-react`, `@paper-design/shaders-react`, `@tavily/core`, `@google/stitch-sdk`, `@elevenlabs/client`, `@elevenlabs/elevenlabs-js`, `@tanstack/react-query`.
- keytar excised everywhere load-bearing, not just `dependencies`: `build.asarUnpack`, `allowScripts`, `electron/lib/nativeArch.{cjs,mjs}` TARGETS, `electron/utils/nativeModuleGuard.ts` GUARDED_MODULES (would have crashed boot), `scripts/rebuild-native-electron.js`, `scripts/rebuild-native-for-target.cjs`, `scripts/ad-hoc-sign.js`, `scripts/build-electron.js` externals, `scripts/verify-packaged-local-assets.mjs`.
- `@tanstack/react-query`: 5 dead `QueryClientProvider` wrappers removed from `src/App.tsx` (zero `useQuery` calls existed).
- `@types/marked`, `@types/qrcode` moved to devDependencies. `package-lock.json` refreshed (`npm install --package-lock-only --ignore-scripts`).

### Repo hygiene
- Deleted: `renderer/` (legacy CRA app, unreferenced), `worker-script/` (stub), `src/components/ui/card.tsx` (0 bytes), `src/UI_comp/` (asset moved next to its only consumer `UpcomingCalendarCard.tsx`).
- Moved: 6 incident-forensics files → `docs/archive/`; 3 `*Harness.html` → `dev/harness/` (comment refs updated in `src/dev/*.tsx`).
- `.gitignore`: inverted the `docs/*` blanket-ignore + per-file allowlist (new docs silently vanished before); `docs/` is now tracked by default, `docs/superpowers/` stays ignored.
- Removed the `natively-api` orphan gitlink (0-byte `.gitmodules` — it broke recursive submodule init, documented in CI comments).

### DatabaseManager migration extraction (the big one)
- `electron/db/migrations.ts` (new, ~1,686 lines): 33 ordered migration steps + `MigrationContext`/`MigrationStep` types + `KNOWN_DIMS`. Byte-identical SQL/gating verified programmatically; `up(ctx)` returns `false` to preserve R-22 chain termination.
- `electron/db/DatabaseManager.ts`: **4,015 → 2,643 lines** (−1,372). `runMigrations()` now iterates `MIGRATIONS`.
- 4 source-pin tests updated to the new module (`MigrationChainTerminatesOnFailure2026_08_20`, `ReferenceFilePageCountPersistence`, `ModesManagerPageCountForwarding`, `ContextOsAssistantClaims` v24); stamp assertions updated `this.db.pragma` → `db.pragma`.

### Phase 1 head-start: `electron/platform/macosVersion.ts`
- Single Darwin→macOS mapping replacing 5 copy-pasted `parseInt(os.release()…)` sites (`main.ts` Fontations gate, `ipcHandlers.ts` get-os-version + local-whisper-preload, `LocalModelDownloadService.preflightCheck`, `whisper/modelManager.getAvailableModels`).
- Injectable `platform`/`release` per the cross-platform contract; contract test `electron/platform/__tests__/macosVersion.test.mjs` exercises darwin branches on any host. Test glob added to `npm test`.

### Test fixes required by the above
- `nativeArchPe.test.mjs` + `nativeArchGate.packaged.test.mjs`: updated for the single-target (better-sqlite3-only) arch guard.

## Validation

| Gate | Result |
|---|---|
| `typecheck:electron` (TS7) | **0 errors** |
| Renderer typecheck (TS7, root tsconfig) | **0 errors** |
| `npm run lint` | 0 errors, ~800 warnings (advisory by design) |
| `count-any --check` | OK (2,078 baseline, delta 0) |
| `test:scripts` | 20/20 |
| `test:lib` | 358 pass, 0 fail |
| native-arch suites (PE + packaged gate + parity) | 19/19 + 4 pass/2 skip (arm64-only fixtures skip on Windows) |
| `electron/db/**` + migration-scoped suites | green after source-pin test updates |
| Full `npm test` (Windows host) | see below |

**Full-suite triage (final):** full `npm test` on this Windows host = 8,022 tests, 36 fail. Classification of all 36:
- **6 were caused by this phase and are FIXED** (all source-regex pins on moved code): 3 Ventura-gate pins in `Issue301SttFriendlyError.test.mjs` (now pin the shared `isMacOS13VenturaOrLater` contract), 2 schema pins in `ProfileIntelligenceGate.test.mjs` (now read `migrations.ts`), 1 pending-count pin — re-run: **16/16 green**.
- **~30 pre-existing Windows-host failures** (untouched files, fail identically at HEAD — matches the CI-documented advisory baseline of 41 as of 2026-08-17, some since fixed on main): the `await import(abs-path)` ESM-scheme cluster (MeetingLifecycleDbLiveness, LexicalTokensNumerals, LitellmModelLabel, Cropper×2, …), the `D:\D:\` double-drive-letter path bug in `CredentialDegradedStoreGuard2026_08_05` (8 cases) + related degraded-store suites, renderer source-drift pins (Profile gate ×5, WindowsPlatformParity ×2 — both regex-proven failing at unmodified HEAD), and environmental cases (packaged-layout simulation, symlink privileges).

## Cross-platform analysis

- Expected macOS behavior: unchanged (no behavior edits; pure moves + deletions of never-executed code).
- Expected Windows behavior: unchanged; keytar removal is safe because it was never `require`d at runtime (CredentialsManager uses safeStorage).
- Platform implementations reviewed: nativeArch guard (both), esbuild externals (both), verify-packaged-assets (both), rebuild scripts (both), NSIS/dmg config untouched.
- `Reviewed but not executed on macOS` — macOS-only code paths were not physically run (Windows host).
- `Requires physical macOS verification` — packaged build (`app:build`) before release, per existing release-gate process.

## Commands executed

`npm run lint` · `node scripts/count-any.mjs[--check]` · `npm install --package-lock-only --ignore-scripts` · `node node_modules/typescript7/lib/tsc.js -p tsconfig.json --noEmit` · same with `-p electron/tsconfig.json` · `npm run build:electron` · `npm test` · `npm run test:lib` · `npm run test:scripts` · targeted `electron --test` runs for db/platform/native-arch suites.

## Remaining risks

- `WindowsPlatformParity.test.mjs` pre-existing failures remain (owned by Phase 1, which rewrites the ~12 source-regex parity tests into adapter contract tests).
- `premium` private submodule absent locally — lazy-require pattern preserved; not exercised.
- Physical macOS smoke pending (meeting start/stop, overlay) — required before `dist`.
