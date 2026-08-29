
import Database from 'better-sqlite3';
import path from 'path';
import os from 'os';
import { app } from 'electron';
import fs from 'fs';
import * as sqliteVec from 'sqlite-vec';
import { MIGRATIONS, KNOWN_DIMS, type MigrationContext } from './migrations';
import type { ActionItem, DecisionItem, FollowUpDraft, MeetingSummaryGenerationMeta, MeetingSummaryModeMeta, MeetingSummarySectionV3, NoteBlock, PersonMention, QuestionItem, RiskItem, SourceQualityMeta, SpeakerLabelMap, SummaryStatus, TimelineItem } from '../services/meeting/types';

// Interfaces for our data objects
export interface Meeting {
    id: string;
    title: string;
    date: string; // ISO string
    duration: string;
    summary: string;
    detailedSummary?: {
        overview?: string;
        actionItems: string[];
        keyPoints: string[];
        actionItemsTitle?: string;
        keyPointsTitle?: string;
        sections?: Array<{ title: string; bullets: string[] }>;
        schemaVersion?: number;
        tldr?: string[];
        whatChanged?: string[];
        decisions?: DecisionItem[];
        openQuestions?: QuestionItem[];
        risks?: RiskItem[];
        sourceQuality?: SourceQualityMeta;
        timeline?: TimelineItem[];
        people?: PersonMention[];
        topics?: string[];
        recipes?: Record<string, string>;
        noteBlocks?: NoteBlock[];
        sectionsV3?: MeetingSummarySectionV3[];
        mode?: MeetingSummaryModeMeta;
        generation?: MeetingSummaryGenerationMeta;
        actionItemsStructured?: Array<{ id: string; text: string; owner?: string; deadline?: string; sourceTimestamp?: number }>;
        actionItemsV3?: ActionItem[];
        // V3 follow-up is a structured FollowUpDraft object; legacy rows stored a plain string.
        followUpDraft?: FollowUpDraft | string;
        speakerLabels?: SpeakerLabelMap;
        crossMeeting?: { carriedOpenQuestions?: Array<{ text: string; fromMeetingId: string; fromTitle: string }>; recurringRisks?: Array<{ text: string; fromMeetingId: string; fromTitle: string }>; stillOpen?: string[] };
        coachingInsights?: Array<{ id: string; type: string; title: string; detail: string; severity: 'info' | 'opportunity' | 'warning'; evidence?: string }>;
    };
    transcript?: Array<{
        speaker: string;
        text: string;
        timestamp: number;
    }>;
    usage?: Array<{
        type: 'assist' | 'followup' | 'chat' | 'followup_questions';
        timestamp: number;
        question?: string;
        answer?: string;
        items?: string[];
    }>;
    calendarEventId?: string;
    source?: 'manual' | 'calendar';
    isProcessed?: boolean;
    summaryStatus?: SummaryStatus;
    /** Live meeting note: row created at meeting Start (is_live=1), finalized (0) at Stop. */
    isLive?: boolean;
    /** Folder this meeting belongs to (folders feature v32). null/undefined = root (launcher main list). */
    folderId?: string | null;
}

/** Meeting folder (folders feature v32). Single-level: every folder lives at root. */
export interface Folder {
    id: string;
    name: string;
    createdAt: string;
    /** Number of meetings currently assigned to this folder (listFolders only). */
    meetingCount?: number;
}


/**
 * JIT live-indexing scaffold meeting id (RAGManager.startLiveIndexing). A
 * transient meetings row kept only so live RAG chunks satisfy the meetings
 * foreign key while a meeting runs; it is deleted at meeting end
 * (deleteMeetingData('live-meeting-current')) and must never surface in the
 * history list or recovery as if it were a real meeting. This is the SAME
 * constant every caller uses (electron/main.ts, ipcHandlers.ts, RAGManager) —
 * see the F-411 audit for why it is a fixed literal.
 */
const JIT_LIVE_MEETING_ID = 'live-meeting-current';

export class DatabaseManager {
    private static instance: DatabaseManager;
    private db: Database.Database | null = null;
    private dbPath: string;
    private resolvedExtPath: string = '';
    private initError: Error | null = null;

    private constructor() {
        // Resolve the userData directory. Normally this is Electron's real
        // per-user app-data path. But under `ELECTRON_RUN_AS_NODE=1` (the
        // `test:electron` runner) or before `app` is ready, `app` may be
        // undefined or `app.getPath` may throw — in those contexts fall back
        // to an explicit override (NATIVELY_TEST_USERDATA) or an OS-temp dir
        // so importing a module that lazily constructs DatabaseManager (e.g.
        // ModesManager.getInstance() inside a unit test) degrades gracefully
        // instead of crashing with "Cannot read properties of undefined
        // (reading 'getPath')". Production (real Electron main process) is
        // unaffected — app.getPath succeeds and this fallback never runs.
        let userDataPath: string;
        try {
            const fromEnv = process.env.NATIVELY_TEST_USERDATA;
            if (fromEnv) {
                userDataPath = fromEnv;
            } else if (app && typeof app.getPath === 'function') {
                userDataPath = app.getPath('userData');
            } else {
                userDataPath = path.join(os.tmpdir(), 'natively-no-electron-app');
            }
        } catch {
            userDataPath = path.join(os.tmpdir(), 'natively-no-electron-app');
        }
        try { fs.mkdirSync(userDataPath, { recursive: true }); } catch { /* best effort */ }
        this.dbPath = path.join(userDataPath, 'natively.db');
        // IMPORTANT: never throw out of the constructor. If init() throws and
        // escapes, `DatabaseManager.instance` is never assigned — so every
        // subsequent getInstance() call re-enters the constructor and re-emits
        // the identical failure (this is why a single dlopen error used to print
        // as a wall of ~dozens of identical stack traces across seed-demo,
        // get-recent-meetings, modes:get-active, etc.). Instead we capture the
        // error once and degrade to db: null; every public method already guards
        // with `if (!this.db)`, so callers get empty/null results, not throws.
        try {
            this.init();
        } catch (error) {
            this.initError = error as Error;
            this.reportInitFailure(error);
        }
    }

    public static getInstance(): DatabaseManager {
        if (!DatabaseManager.instance) {
            DatabaseManager.instance = new DatabaseManager();
        }
        return DatabaseManager.instance;
    }

    /** True when the underlying SQLite database opened successfully. */
    public isAvailable(): boolean {
        return this.db !== null;
    }

    /**
     * Truncate the WAL file by running a `PRAGMA wal_checkpoint(TRUNCATE)`.
     * On a force-quit or a crash mid-write, the `-wal` file is left in an
     * inconsistent state and the next launch's `new Database(dbPath)` may
     * either hang on a kernel lock the OS thinks is held, or read partial
     * committed data. This call is best-effort: if it fails (db is null or
     * the connection is closed) it does nothing. Should be called from
     * `before-quit` AND from any force-quit-handler path so a SIGKILL of
     * the Electron main process is the ONLY way the WAL stays dirty.
     *
     * This is the missing piece for the "fresh-profile crash, never opens
     * again" bug: a half-written .db-wal on a brand-new install would lock
     * the next launch's `new Database(dbPath)` against a phantom lock.
     */
    public checkpoint(): void {
        if (!this.db) return;
        try {
            this.db.pragma('wal_checkpoint(TRUNCATE)');
        } catch (e: any) {
            // best-effort: a checkpoint failure should not block shutdown.
            console.warn('[DatabaseManager] wal_checkpoint(TRUNCATE) failed:', e?.message || e);
        }
    }

    /**
     * Close the better-sqlite3 connection cleanly. After this, all public
     * methods are no-ops (db is null). Idempotent. Safe to call from
     * `before-quit` AND from the `window-all-closed` handler so the
     * launcher hides-to-tray path also releases the connection.
     *
     * This path DOES checkpoint (TRUNCATE) because it runs from a HEALTHY
     * process (clean quit). Do NOT call this from a crash handler — use
     * `closeWithoutCheckpoint()` there instead (see below).
     */
    public close(): void {
        if (!this.db) return;
        try {
            this.db.pragma('wal_checkpoint(TRUNCATE)');
        } catch { /* best-effort */ }
        try {
            this.db.close();
        } catch (e: any) {
            console.warn('[DatabaseManager] close failed:', e?.message || e);
        }
        this.db = null;
    }

    /**
     * Crash-safe close: release the connection WITHOUT running a
     * wal_checkpoint(TRUNCATE).
     *
     * REGRESSION FIX (2026-07-10): v2.8.1 wired an emergency
     * checkpoint+close into every crash handler (uncaughtException,
     * unhandledRejection, SIGTERM/SIGINT, render-process-gone, …). But a
     * TRUNCATE checkpoint run from a CRASHING or half-initialized process
     * — or interrupted by the macOS SIGTERM→SIGKILL race — can leave
     * `natively.db-wal` / `natively.db-shm` half-truncated, which then
     * BLOCKS the next `new Database()` open (SQLITE_BUSY on Windows'
     * mandatory locks, or an unreconcilable WAL on macOS). That converted a
     * one-time crash into a permanent "app never boots again" brick on both
     * platforms. v2.7.0 never checkpointed on crash — it let SQLite's own
     * automatic WAL recovery replay the log safely on the next open, which
     * is exactly what we restore here.
     *
     * So on a crash we ONLY close the handle (to drop the OS lock) and let
     * SQLite auto-recover the WAL next launch. `better_sqlite3`'s `close()`
     * itself does NOT checkpoint (only our `close()` wrapper above does), so
     * calling the raw handle close is checkpoint-free.
     */
    public closeWithoutCheckpoint(): void {
        if (!this.db) return;
        try {
            this.db.close();
        } catch (e: any) {
            console.warn('[DatabaseManager] closeWithoutCheckpoint failed:', e?.message || e);
        }
        this.db = null;
    }

    /**
     * The error that caused initialization to fail, if any. Lets the app surface
     * a single user-facing banner (e.g. "Local database unavailable — meeting
     * history disabled") instead of relying on log scraping.
     */
    public getInitError(): Error | null {
        return this.initError;
    }

    /**
     * Translate an init failure into a single, actionable log line. The most
     * common fatal cause is a native-module architecture mismatch (an x86_64
     * better-sqlite3 binary loaded under the arm64 Electron runtime, typically
     * produced by an `npm install` that ran under a Rosetta shell).
     */
    private reportInitFailure(error: unknown): void {
        const err = error as NodeJS.ErrnoException;
        const msg = err?.message || String(error);
        const isArchMismatch =
            err?.code === 'ERR_DLOPEN_FAILED' ||
            /incompatible architecture|ERR_DLOPEN_FAILED|mach-o/i.test(msg);

        if (isArchMismatch) {
            console.error(
                '[DatabaseManager] FATAL: native module (better-sqlite3) failed to load — the compiled ' +
                'binary architecture does not match the Electron runtime. Local database is DISABLED ' +
                '(meeting history, modes, and notes will not persist this session).\n' +
                '  Fix: run `npm run rebuild:native` from a native (non-Rosetta) terminal, then restart the app.'
            );
        } else {
            console.error(
                '[DatabaseManager] FATAL: database initialization failed. Local database is DISABLED ' +
                '(meeting history, modes, and notes will not persist this session).',
                error
            );
        }
    }

    /**
     * Open the better-sqlite3 connection, self-healing a poisoned WAL sidecar
     * left by an unclean prior exit / interrupted crash-time checkpoint.
     *
     * On the first open failure whose code indicates lock contention or a torn
     * WAL (SQLITE_BUSY / SQLITE_IOERR / SQLITE_CORRUPT / SQLITE_NOTADB /
     * SQLITE_CANTOPEN / SQLITE_PROTOCOL), delete the `-wal` and `-shm` sidecars
     * (NOT the main `.db`, which holds the last committed state) and retry the
     * open exactly once. If the retry also fails, the original error propagates
     * so the ctor's catch degrades to `db: null` (meeting history/modes
     * disabled) instead of hanging — same as before, but only as a last resort.
     *
     * See the REGRESSION FIX note on closeWithoutCheckpoint() for the root cause.
     */
    private openWithWalSelfHeal(): Database.Database {
        try {
            return new Database(this.dbPath);
        } catch (openErr: any) {
            const code = String(openErr?.code || '');
            const healable =
                /SQLITE_BUSY|SQLITE_IOERR|SQLITE_CORRUPT|SQLITE_NOTADB|SQLITE_CANTOPEN|SQLITE_PROTOCOL/.test(code) ||
                /database is locked|disk I\/O error|file is not a database|malformed/i.test(String(openErr?.message || ''));
            if (!healable) throw openErr;

            console.warn(
                `[DB-RECOVERY] initial open failed (${code || openErr?.message}); ` +
                `clearing stale WAL sidecars (-wal/-shm) and retrying once. ` +
                `This recovers an install bricked by an interrupted crash-time checkpoint.`
            );
            for (const suffix of ['-wal', '-shm'] as const) {
                const sidecar = `${this.dbPath}${suffix}`;
                try {
                    if (fs.existsSync(sidecar)) {
                        fs.unlinkSync(sidecar);
                        console.warn(`[DB-RECOVERY] removed stale ${suffix} sidecar at ${sidecar}`);
                    }
                } catch (rmErr: any) {
                    // If we cannot remove the sidecar (permissions, or a zombie
                    // process still holds the handle on Windows), the retry will
                    // fail and the original error propagates. Log and continue.
                    console.warn(`[DB-RECOVERY] could not remove ${suffix} sidecar: ${rmErr?.message || rmErr}`);
                }
            }
            // Retry ONCE. Let any error here propagate to the ctor catch.
            const db = new Database(this.dbPath);
            console.warn('[DB-RECOVERY] reopened successfully after clearing WAL sidecars ✅');
            return db;
        }
    }

    private init() {
        try {
            console.log(`[DatabaseManager] Initializing database at ${this.dbPath}`);
            // Ensure directory exists (though userData usually does)
            const dir = path.dirname(this.dbPath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
                console.log(`[DatabaseManager] Created directory: ${dir}`);
            } else {
                console.log(`[DatabaseManager] Directory exists: ${dir}`);
                try {
                    const files = fs.readdirSync(dir);
                    console.log(`[DatabaseManager] Directory contents:`, files);
                    const dbExists = fs.existsSync(this.dbPath);
                    if (dbExists) {
                        const stats = fs.statSync(this.dbPath);
                        console.log(`[DatabaseManager] Found existing DB. Size: ${stats.size} bytes`);
                    } else {
                        console.log(`[DatabaseManager] No existing DB found at ${this.dbPath}. Creating new one.`);
                    }
                } catch (e) {
                    console.error('[DatabaseManager] Error checking directory/file:', e);
                }
            }

            // SELF-HEAL (2026-07-10): open the DB, and if the open fails
            // because a prior crash left a poisoned WAL sidecar, clear the
            // stale -wal/-shm and retry ONCE. Background: v2.8.1 ran a
            // wal_checkpoint(TRUNCATE) from crash handlers; if that was
            // interrupted it left natively.db-wal/-shm in a state that made
            // this very open throw (SQLITE_BUSY on Windows' mandatory locks,
            // SQLITE_IOERR/CORRUPT/NOTADB on a torn WAL) — permanently bricking
            // every subsequent launch. The main .db holds the last COMMITTED
            // state; a dirty/uncheckpointed WAL only contains not-yet-merged
            // frames, so deleting the sidecars and reopening recovers the DB to
            // its last consistent commit rather than leaving the app unbootable.
            // Any user already bricked by a shipped v2.8.x build self-heals on
            // the next launch with this — they do NOT need to hand-delete files.
            this.db = this.openWithWalSelfHeal();
            this.db.pragma('journal_mode = WAL');
            // Hotfix 2026-07-09: with WAL enabled, background indexing workers
            // and foreground chat reads/writes can briefly contend. Waiting is
            // safer than throwing SQLITE_BUSY during startup or active sessions.
            this.db.pragma('busy_timeout = 5000');
            // Enforce foreign keys on the shared connection. Several delete paths
            // (deleteMeeting, deleteMode, deleteKnowledgePack) do a bare parent-row
            // DELETE and rely ENTIRELY on `ON DELETE CASCADE` to reap child rows
            // (transcripts, ai_interactions, chunks, chunk_summaries). SQLite ships
            // with foreign_keys OFF per-connection, so those cascades are inert
            // unless something enables the pragma. Historically the ONLY place that
            // did was the premium KnowledgeDatabaseManager's constructor (the
            // premium submodule has since been removed from this repo) — meaning
            // FK enforcement used to silently depend on that module loading. If it
            // failed to load (source-available build, packaging regression),
            // every meeting/mode/pack delete would orphan its children. Enable it
            // here, unconditionally, on the one shared connection all writes use.
            // Must run OUTSIDE any transaction (SQLite no-ops `foreign_keys` if set
            // mid-transaction) and BEFORE migrations — both hold here.
            this.db.pragma('foreign_keys = ON');
            // Leave synchronous = FULL (the WAL default). NORMAL trades crash
            // durability for throughput — a power loss between commit and
            // fsync loses the transaction. The emergency-close path added in
            // electron/main.ts (uncaughtException / SIGTERM / process-gone)
            // checkpoint+closes the DB so the next launch never sees a stale
            // WAL holding a kernel lock from a dead writer.

            // 2026-07-09: detect crash-recovery conditions on startup. If we
            // see a WAL file > 50MB or a `-wal` left over from a hard kill,
            // log it so the user can correlate a slow/stuck launch with the
            // previous session's crash. Anything >5MB after a clean previous
            // session is unusual and worth surfacing; >50MB is "the previous
            // session probably wrote a lot without checkpointing".
            try {
                const walPath = `${this.dbPath}-wal`;
                const shmPath = `${this.dbPath}-shm`;
                const walBytes = fs.existsSync(walPath) ? fs.statSync(walPath).size : 0;
                const shmExists = fs.existsSync(shmPath);
                if (walBytes >= 50 * 1024 * 1024) {
                    console.warn(`[DB-RECOVERY] large WAL on open: ${walBytes} bytes at ${walPath} (previous session likely died mid-transaction). SQLite will auto-recover it on this open; a manual TRUNCATE checkpoint runs only on the next clean quit.`);
                } else if (walBytes >= 5 * 1024 * 1024) {
                    console.log(`[DB-RECOVERY] non-trivial WAL on open: ${walBytes} bytes at ${walPath}`);
                }
                if (shmExists) {
                    console.log(`[DB-RECOVERY] -shm index file present (typical after WAL-mode open; SQLite manages it).`);
                }
            } catch (recovErr: any) {
                // Recovery detection is best-effort — never block startup.
                console.warn('[DB-RECOVERY] detection check failed (non-fatal):', recovErr?.message || recovErr);
            }

            // Load sqlite-vec extension for native vector search
            try {
                // 1. sqlite-vec's getLoadablePath() returns a path inside app.asar
                //    (e.g. .../app.asar/node_modules/sqlite-vec-darwin-arm64/vec0.dylib)
                //    but dlopen() needs real files on disk, not files inside the asar archive.
                //    electron-builder's asarUnpack puts them in app.asar.unpacked instead.
                // 2. better-sqlite3's loadExtension() auto-appends the platform extension
                //    (.dylib/.so/.dll), so we strip it to avoid vec0.dylib.dylib.
                let extPath = sqliteVec.getLoadablePath();
                extPath = extPath.replace('app.asar', 'app.asar.unpacked');
                extPath = extPath.replace(/\.(dylib|so|dll)$/, '');
                this.db.loadExtension(extPath);
                this.resolvedExtPath = extPath; // Store for worker thread access
                console.log('[DatabaseManager] sqlite-vec extension loaded successfully');
            } catch (extErr) {
                console.error('[DatabaseManager] Failed to load sqlite-vec extension:', extErr);
                console.warn('[DatabaseManager] Vector search will fall back to JS cosine similarity');
            }

            this.runMigrations();
        } catch (error) {
            console.error('[DatabaseManager] Failed to initialize database:', error);
            throw error;
        }
    }

    // ============================================
    // PRAGMA user_version Migration System
    // ============================================
    // Each version is applied exactly once, in order.
    // The migration steps themselves live in electron/db/migrations.ts
    // (MIGRATIONS); new migrations append a new step there.

    private runMigrations() {
        if (!this.db) return;

        const version = (this.db.pragma('user_version', { simple: true }) as number) || 0;
        console.log(`[DatabaseManager] Current schema version: ${version}`);

        // The migration chain itself now lives in electron/db/migrations.ts
        // (Phase 0: extracted from this class). Every step preserves the exact
        // version-gating, SQL, logging and error semantics of the original
        // monolithic block, including the snapshot semantics R-05 depends on:
        // `version` above is read ONCE and every gate compares against this
        // snapshot, even after an earlier step advanced the pragma mid-chain.
        // A step returning false aborts the chain exactly like the old
        // `return;` statements (R-22 chain termination) â€” the remaining steps
        // and the final log below are skipped, matching the original flow.
        const ctx: MigrationContext = { db: this.db, version, manager: this };
        for (const step of MIGRATIONS) {
            if (!step.up(ctx)) return;
        }

        console.log('[DatabaseManager] Migrations completed.');
    }

    // ============================================
    // Usage outbox (v27) — durable queue for client-reported usage events
    // ============================================
    //
    // Every method here is guarded and returns a neutral value when the database
    // is unavailable. This queue must never be able to break the feature it is
    // observing: a customer whose disk is full still gets to run a meeting.

    /**
     * Queue one event for delivery.
     *
     * INSERT OR IGNORE, not INSERT: enqueuing the same event_id twice is a
     * no-op, so a retry loop in a caller cannot produce two rows for one logical
     * event. That is the local half of the replay protection the server enforces
     * with UNIQUE(event_id).
     *
     * Returns 'queued' | 'duplicate' | 'dropped' | 'unavailable'.
     */
    public enqueueUsageEvent(eventId: string, layer: 'ledger' | 'telemetry', payload: unknown, opts?: { maxRows?: number }): string {
        if (!this.db) return 'unavailable';
        try {
            // Hard cap. An app that has been offline for a month, or whose
            // licence has lapsed so every delivery 401s, must not grow this
            // table without bound. Dropping the OLDEST undelivered event is the
            // least-bad choice: recent activity is what a dispute is usually
            // about, and the drop is counted so the loss is visible rather than
            // silent.
            const maxRows = opts?.maxRows ?? 10_000;
            const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM usage_outbox`).get() as any)?.n ?? 0;
            if (total >= maxRows) {
                // Make room for exactly one new row.
                //
                // ORDER MATTERS. `total` counts EVERY row, but delivered rows are
                // deliberately retained for a 7-day support window and compaction
                // only runs on a 6-hour timer — so in a normal desktop session the
                // table fills with delivered rows. Evicting only `status != 'delivered'`
                // (the previous behaviour) meant a table of 9,999 delivered rows
                // destroyed the one live event on every insert, and once EVERY row
                // was delivered there was no victim at all and the incoming event was
                // dropped before the INSERT — permanently, for every later event.
                // Both are the exact loss this file's header forbids.
                //
                // Delivered rows are already safely upstream, so reclaiming them
                // costs nothing. An undelivered event is sacrificed only when no
                // delivered row remains to give up.
                const surplus = total - maxRows + 1;
                const freed = this.db.prepare(`
                    DELETE FROM usage_outbox WHERE event_id IN (
                        SELECT event_id FROM usage_outbox
                         WHERE status = 'delivered'
                         ORDER BY created_at ASC LIMIT ?
                    )
                `).run(surplus).changes ?? 0;
                if (freed < surplus) {
                    const sacrificed = this.db.prepare(`
                        DELETE FROM usage_outbox WHERE event_id IN (
                            SELECT event_id FROM usage_outbox
                             WHERE status != 'delivered'
                             ORDER BY created_at ASC LIMIT ?
                        )
                    `).run(surplus - freed).changes ?? 0;
                    // Losing an undelivered event IS the loss this queue exists to
                    // prevent. It must never be silent — the previous code evicted
                    // one and still returned 'queued', so nothing counted it.
                    if (sacrificed > 0) {
                        console.warn(`[DatabaseManager] usage_outbox at cap (${maxRows}) — discarded ${sacrificed} UNDELIVERED event(s) to enqueue a new one`);
                    }
                }
                // Deliberately fall through to the INSERT even if nothing could be
                // freed: bounding the table is worth less than the incoming event.
            }
            const res = this.db.prepare(`
                INSERT OR IGNORE INTO usage_outbox (event_id, layer, payload_json, status, created_at, next_retry_at)
                VALUES (?, ?, ?, 'pending', ?, 0)
            `).run(eventId, layer, JSON.stringify(payload), Date.now());
            return res.changes > 0 ? 'queued' : 'duplicate';
        } catch (e: any) {
            console.warn('[DatabaseManager] enqueueUsageEvent failed:', e?.message || e);
            return 'unavailable';
        }
    }

    /** Events due for delivery now, oldest first. */
    public claimUsageOutboxBatch(limit = 100, now = Date.now()): Array<{ event_id: string; layer: string; payload: any; attempt_count: number }> {
        if (!this.db) return [];
        try {
            const rows = this.db.prepare(`
                SELECT event_id, layer, payload_json, attempt_count
                  FROM usage_outbox
                 WHERE status = 'pending' AND next_retry_at <= ?
                 ORDER BY created_at ASC
                 LIMIT ?
            `).all(now, limit) as any[];
            return rows.map((r) => ({
                event_id: r.event_id,
                layer: r.layer,
                attempt_count: r.attempt_count,
                payload: JSON.parse(r.payload_json),
            }));
        } catch (e: any) {
            console.warn('[DatabaseManager] claimUsageOutboxBatch failed:', e?.message || e);
            return [];
        }
    }

    /** Mark delivered. Rows linger until compaction so a duplicate enqueue is caught. */
    public markUsageEventsDelivered(eventIds: string[], now = Date.now()): void {
        if (!this.db || eventIds.length === 0) return;
        try {
            const stmt = this.db.prepare(`UPDATE usage_outbox SET status = 'delivered', delivered_at = ?, last_error = NULL WHERE event_id = ?`);
            const tx = this.db.transaction((ids: string[]) => { for (const id of ids) stmt.run(now, id); });
            tx(eventIds);
        } catch (e: any) {
            console.warn('[DatabaseManager] markUsageEventsDelivered failed:', e?.message || e);
        }
    }

    /**
     * Server said these are permanently unacceptable (schema rejection).
     * Deleted rather than retried: a payload this server build refuses will be
     * refused identically forever, and retrying it is how a queue wedges.
     */
    public dropUsageEvents(eventIds: string[]): void {
        if (!this.db || eventIds.length === 0) return;
        try {
            const stmt = this.db.prepare(`DELETE FROM usage_outbox WHERE event_id = ?`);
            const tx = this.db.transaction((ids: string[]) => { for (const id of ids) stmt.run(id); });
            tx(eventIds);
        } catch (e: any) {
            console.warn('[DatabaseManager] dropUsageEvents failed:', e?.message || e);
        }
    }

    /** Record a failed attempt and schedule the next one. */
    public markUsageEventsFailed(eventIds: string[], nextRetryAt: number, error: string): void {
        if (!this.db || eventIds.length === 0) return;
        try {
            const msg = String(error || '').slice(0, 200);
            const stmt = this.db.prepare(`
                UPDATE usage_outbox
                   SET attempt_count = attempt_count + 1, next_retry_at = ?, last_error = ?
                 WHERE event_id = ?
            `);
            const tx = this.db.transaction((ids: string[]) => { for (const id of ids) stmt.run(nextRetryAt, msg, id); });
            tx(eventIds);
        } catch (e: any) {
            console.warn('[DatabaseManager] markUsageEventsFailed failed:', e?.message || e);
        }
    }

    /** Remove delivered rows older than the retention window (default 7 days). */
    public compactUsageOutbox(olderThanMs = 7 * 24 * 60 * 60 * 1000, now = Date.now()): number {
        if (!this.db) return 0;
        try {
            const res = this.db.prepare(
                `DELETE FROM usage_outbox WHERE status = 'delivered' AND delivered_at IS NOT NULL AND delivered_at < ?`
            ).run(now - olderThanMs);
            return res.changes ?? 0;
        } catch (e: any) {
            console.warn('[DatabaseManager] compactUsageOutbox failed:', e?.message || e);
            return 0;
        }
    }

    /** Queue depth by status — the §20 `event_queue_depth` health metric. */
    public getUsageOutboxStats(): { pending: number; delivered: number; total: number; oldestPendingAgeMs: number | null } {
        if (!this.db) return { pending: 0, delivered: 0, total: 0, oldestPendingAgeMs: null };
        try {
            const rows = this.db.prepare(`SELECT status, COUNT(*) AS n FROM usage_outbox GROUP BY status`).all() as any[];
            const byStatus = Object.fromEntries(rows.map((r) => [r.status, r.n]));
            const oldest = this.db.prepare(
                `SELECT MIN(created_at) AS t FROM usage_outbox WHERE status = 'pending'`
            ).get() as any;
            return {
                pending: byStatus.pending ?? 0,
                delivered: byStatus.delivered ?? 0,
                total: rows.reduce((s, r) => s + r.n, 0),
                oldestPendingAgeMs: oldest?.t ? Date.now() - oldest.t : null,
            };
        } catch {
            return { pending: 0, delivered: 0, total: 0, oldestPendingAgeMs: null };
        }
    }

    // ============================================
    // Context OS — assistant claims + turn contracts (v24, Phase 9)
    // ============================================

    /** Insert an extracted assistant claim (default validation_status='unverified'). */
    public saveAssistantClaim(claim: {
        claimId: string;
        turnId: string;
        claimText: string;
        sourceOwner: string;
        requestedProperty?: string | null;
        validationStatus?: 'unverified' | 'verified' | 'contradicted';
        evidenceIds?: string[];
    }): void {
        if (!this.db) return;
        // Context OS invariant (Phase 7): a VERIFIED claim MUST carry evidence
        // IDs — a verified claim with no provenance is exactly the contamination
        // trap the claims table exists to prevent. Enforce fail-closed at the DAO
        // boundary: downgrade rather than store an unprovable "verified" row.
        let status = claim.validationStatus ?? 'unverified';
        const evidenceIds = claim.evidenceIds ?? [];
        if (status === 'verified' && evidenceIds.length === 0) {
            console.warn('[DatabaseManager] refusing to store verified claim without evidence IDs — downgrading to unverified');
            status = 'unverified';
        }
        try {
            this.db.prepare(`
                INSERT OR REPLACE INTO assistant_claims
                    (claim_id, turn_id, claim_text, source_owner, requested_property, validation_status, evidence_ids_json)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `).run(
                claim.claimId,
                claim.turnId,
                claim.claimText,
                claim.sourceOwner,
                claim.requestedProperty ?? null,
                status,
                JSON.stringify(evidenceIds),
            );
        } catch (e) {
            console.error('[DatabaseManager] saveAssistantClaim failed:', e);
        }
    }

    /** Only VERIFIED claims may be re-used as evidence (memory-safety invariant). */
    public getVerifiedAssistantClaims(limit = 50): any[] {
        if (!this.db) return [];
        try {
            return this.db.prepare(`
                SELECT * FROM assistant_claims
                WHERE validation_status = 'verified'
                ORDER BY created_at DESC LIMIT ?
            `).all(limit);
        } catch (e) {
            console.error('[DatabaseManager] getVerifiedAssistantClaims failed:', e);
            return [];
        }
    }

    /**
     * Phase 6 Slice 7 (context-rebuild, 2026-07-25, RC8 precedence
     * enforcement): the read-side counterpart to getVerifiedAssistantClaims
     * needed to check whether a draft answer restates a claim already
     * marked contradicted from an earlier turn.
     */
    public getContradictedAssistantClaims(limit = 50): any[] {
        if (!this.db) return [];
        try {
            return this.db.prepare(`
                SELECT * FROM assistant_claims
                WHERE validation_status = 'contradicted'
                ORDER BY created_at DESC LIMIT ?
            `).all(limit);
        } catch (e) {
            console.error('[DatabaseManager] getContradictedAssistantClaims failed:', e);
            return [];
        }
    }

    /** Mark a stored claim contradicted by newer evidence (never deleted — audit trail). */
    public markAssistantClaimContradicted(claimId: string, contradictedByClaimId?: string | null): void {
        if (!this.db) return;
        try {
            this.db.prepare(`
                UPDATE assistant_claims
                SET validation_status = 'contradicted', contradicted_by_claim_id = ?
                WHERE claim_id = ?
            `).run(contradictedByClaimId ?? null, claimId);
        } catch (e) {
            console.error('[DatabaseManager] markAssistantClaimContradicted failed:', e);
        }
    }

    /** Persist the privacy-safe per-turn contract snapshot (no content, source kinds only). */
    public saveTurnContextContract(row: {
        turnId: string;
        surface: string;
        activeModeId?: string | null;
        answerShape: string;
        sourceOwner: string;
        requestedProperty?: string | null;
        allowedSources: string[];
        forbiddenSources: string[];
        memoryWritePolicy: Record<string, boolean>;
    }): void {
        if (!this.db) return;
        try {
            this.db.prepare(`
                INSERT OR REPLACE INTO turn_context_contracts
                    (turn_id, surface, active_mode_id, answer_shape, source_owner, requested_property,
                     allowed_sources_json, forbidden_sources_json, memory_write_policy_json)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
                row.turnId,
                row.surface,
                row.activeModeId ?? null,
                row.answerShape,
                row.sourceOwner,
                row.requestedProperty ?? null,
                JSON.stringify(row.allowedSources),
                JSON.stringify(row.forbiddenSources),
                JSON.stringify(row.memoryWritePolicy),
            );
        } catch (e) {
            console.error('[DatabaseManager] saveTurnContextContract failed:', e);
        }
    }


    // ============================================
    // Modes CRUD
    // ============================================

    public getModes(): any[] {
        if (!this.db) return [];
        try {
            return this.db.prepare('SELECT * FROM modes ORDER BY created_at ASC').all();
        } catch (e) {
            console.error('[DatabaseManager] getModes failed:', e);
            return [];
        }
    }

    public getActiveMode(): any | null {
        if (!this.db) return null;
        try {
            return this.db.prepare('SELECT * FROM modes WHERE is_active = 1 LIMIT 1').get() ?? null;
        } catch (e) {
            console.error('[DatabaseManager] getActiveMode failed:', e);
            return null;
        }
    }

    public createMode(mode: { id: string; name: string; templateType: string; customContext: string; sourceContractJson?: string }): void {
        if (!this.db) return;
        try {
            this.db.prepare(`
                INSERT INTO modes (id, name, template_type, custom_context, is_active, source_contract_json)
                VALUES (?, ?, ?, ?, 0, ?)
            `).run(mode.id, mode.name, mode.templateType, mode.customContext, mode.sourceContractJson ?? null);
        } catch (e) {
            console.error('[DatabaseManager] createMode failed:', e);
        }
    }

    /** Mark/unmark a mode as an app default (migration v26). */
    public setModeBuiltin(id: string, isBuiltin: boolean): void {
        if (!this.db) return;
        try {
            this.db.prepare('UPDATE modes SET is_builtin = ? WHERE id = ?').run(isBuiltin ? 1 : 0, id);
        } catch (e) {
            console.error('[DatabaseManager] setModeBuiltin failed:', e);
        }
    }

    public updateMode(id: string, updates: { name?: string; templateType?: string; customContext?: string; sourceContractJson?: string | null }): void {
        if (!this.db) return;
        try {
            if (updates.name !== undefined) {
                this.db.prepare('UPDATE modes SET name = ? WHERE id = ?').run(updates.name, id);
            }
            if (updates.templateType !== undefined) {
                this.db.prepare('UPDATE modes SET template_type = ? WHERE id = ?').run(updates.templateType, id);
            }
            if (updates.customContext !== undefined) {
                this.db.prepare('UPDATE modes SET custom_context = ? WHERE id = ?').run(updates.customContext, id);
            }
            if (updates.sourceContractJson !== undefined) {
                this.db.prepare('UPDATE modes SET source_contract_json = ? WHERE id = ?').run(updates.sourceContractJson, id);
            }
        } catch (e) {
            console.error('[DatabaseManager] updateMode failed:', e);
        }
    }

    public deleteMode(id: string): void {
        if (!this.db) return;
        try {
            this.db.prepare('DELETE FROM modes WHERE id = ?').run(id);
        } catch (e) {
            console.error('[DatabaseManager] deleteMode failed:', e);
        }
    }

    public setActiveMode(id: string | null): void {
        if (!this.db) return;
        try {
            const txn = this.db.transaction(() => {
                this.db!.prepare('UPDATE modes SET is_active = 0').run();
                if (id) {
                    const result = this.db!.prepare('UPDATE modes SET is_active = 1 WHERE id = ?').run(id);
                    if (result.changes === 0) {
                        console.warn(`[DatabaseManager] setActiveMode: no mode found with id "${id}" — active mode cleared`);
                    }
                }
            });
            txn();
        } catch (e) {
            console.error('[DatabaseManager] setActiveMode failed:', e);
        }
    }

    public getReferenceFiles(modeId: string): any[] {
        if (!this.db) return [];
        try {
            return this.db.prepare('SELECT * FROM mode_reference_files WHERE mode_id = ? ORDER BY created_at ASC').all(modeId);
        } catch (e) {
            console.error('[DatabaseManager] getReferenceFiles failed:', e);
            return [];
        }
    }

    public addReferenceFile(file: {
        id: string;
        modeId: string;
        fileName: string;
        content: string;
        pageCount?: number;
        extractedPageCount?: number;
    }): void {
        if (!this.db) throw new Error('Database not initialized');
        try {
            this.db.prepare(`
                INSERT INTO mode_reference_files (id, mode_id, file_name, content, page_count, extracted_page_count)
                VALUES (?, ?, ?, ?, ?, ?)
            `).run(
                file.id,
                file.modeId,
                file.fileName,
                file.content,
                file.pageCount ?? null,
                file.extractedPageCount ?? null,
            );
        } catch (e) {
            console.error('[DatabaseManager] addReferenceFile failed:', e);
            throw e;
        }
    }

    public deleteReferenceFile(id: string): void {
        if (!this.db) return;
        try {
            this.db.prepare('DELETE FROM mode_reference_files WHERE id = ?').run(id);
        } catch (e) {
            console.error('[DatabaseManager] deleteReferenceFile failed:', e);
        }
    }

    // ── OKF Knowledge Packs (Phase 2) ───────────────────────────────
    // CRUD for knowledge_sources/knowledge_packs/knowledge_cards/knowledge_entities/
    // knowledge_relations/knowledge_index_versions. All rows cascade-delete via FK
    // when the owning mode_reference_files / modes row is deleted — see migration
    // v19→v20. Row shapes are intentionally untyped (`any`) at this layer; typed
    // mapping happens in electron/services/knowledge/KnowledgePackStore.ts.

    public upsertKnowledgeSource(source: {
        id: string; type: string; fileId?: string; modeId?: string; fileName?: string;
        sourceChecksum: string; contentHash: string; indexedAt?: string;
        pageCount?: number; extractedPageCount?: number; indexVersion?: string; embeddingSpace?: string;
    }): void {
        if (!this.db) throw new Error('Database not initialized');
        this.db.prepare(`
            INSERT INTO knowledge_sources (id, type, file_id, mode_id, file_name, source_checksum, content_hash, indexed_at, page_count, extracted_page_count, index_version, embedding_space)
            VALUES (@id, @type, @fileId, @modeId, @fileName, @sourceChecksum, @contentHash, @indexedAt, @pageCount, @extractedPageCount, @indexVersion, @embeddingSpace)
            ON CONFLICT(id) DO UPDATE SET
                source_checksum = excluded.source_checksum,
                content_hash = excluded.content_hash,
                indexed_at = excluded.indexed_at,
                page_count = excluded.page_count,
                extracted_page_count = excluded.extracted_page_count,
                index_version = excluded.index_version,
                embedding_space = excluded.embedding_space
        `).run({
            id: source.id, type: source.type, fileId: source.fileId ?? null, modeId: source.modeId ?? null,
            fileName: source.fileName ?? null, sourceChecksum: source.sourceChecksum, contentHash: source.contentHash,
            indexedAt: source.indexedAt ?? null, pageCount: source.pageCount ?? null, extractedPageCount: source.extractedPageCount ?? null,
            indexVersion: source.indexVersion ?? 'knowledge_pack_v1', embeddingSpace: source.embeddingSpace ?? null,
        });
    }

    public getKnowledgeSourceByFileId(fileId: string): any | null {
        if (!this.db) return null;
        return this.db.prepare('SELECT * FROM knowledge_sources WHERE file_id = ? ORDER BY created_at DESC LIMIT 1').get(fileId) || null;
    }

    public getKnowledgeSourceById(id: string): any | null {
        if (!this.db) return null;
        return this.db.prepare('SELECT * FROM knowledge_sources WHERE id = ?').get(id) || null;
    }

    public getKnowledgeSourcesByModeId(modeId: string): any[] {
        if (!this.db) return [];
        return this.db.prepare('SELECT * FROM knowledge_sources WHERE mode_id = ?').all(modeId);
    }

    /**
     * Explicit cascade delete for a knowledge_sources row and everything
     * hanging off it (packs, cards, entities, relations, index versions).
     *
     * NOTE (2026-07-10): `PRAGMA foreign_keys = ON` is now enabled directly in
     * initialize() on the shared connection, so the `ON DELETE CASCADE` clauses
     * on these tables ARE enforced at runtime and a bare parent delete would
     * cascade. This method's manual, dependency-ordered delete is kept as
     * belt-and-suspenders: it is harmless with FK enforcement on, and it keeps
     * this path correct (and self-documenting about the reap order) regardless of
     * pragma state. Deletes children before the pack, pack before the source,
     * inside one transaction so a mid-delete failure can't leave a partial pack.
     */
    public deleteKnowledgeSource(id: string): void {
        if (!this.db) return;
        const txn = this.db.transaction(() => {
            const packs = this.db!.prepare('SELECT id FROM knowledge_packs WHERE source_id = ?').all(id) as Array<{ id: string }>;
            for (const { id: packId } of packs) {
                this.db!.prepare('DELETE FROM knowledge_relations WHERE pack_id = ?').run(packId);
                this.db!.prepare('DELETE FROM knowledge_entities WHERE pack_id = ?').run(packId);
                // knowledge_card_versions cascades off knowledge_cards.id, not pack_id directly.
                this.db!.prepare(`
                    DELETE FROM knowledge_card_versions
                    WHERE card_id IN (SELECT id FROM knowledge_cards WHERE pack_id = ?)
                `).run(packId);
                this.db!.prepare('DELETE FROM knowledge_cards WHERE pack_id = ?').run(packId);
            }
            this.db!.prepare('DELETE FROM knowledge_packs WHERE source_id = ?').run(id);
            this.db!.prepare('DELETE FROM knowledge_index_versions WHERE source_id = ?').run(id);
            this.db!.prepare('DELETE FROM knowledge_sources WHERE id = ?').run(id);
        });
        txn();
    }

    public upsertKnowledgePack(pack: {
        id: string; sourceId: string; modeId: string; fileName: string;
        indexMd: string; statsJson: string; packVersion: number; generatedBy: string;
    }): void {
        if (!this.db) throw new Error('Database not initialized');
        this.db.prepare(`
            INSERT INTO knowledge_packs (id, source_id, mode_id, file_name, index_md, stats_json, pack_version, generated_by, updated_at)
            VALUES (@id, @sourceId, @modeId, @fileName, @indexMd, @statsJson, @packVersion, @generatedBy, CURRENT_TIMESTAMP)
            ON CONFLICT(id) DO UPDATE SET
                index_md = excluded.index_md,
                stats_json = excluded.stats_json,
                pack_version = excluded.pack_version,
                updated_at = CURRENT_TIMESTAMP
        `).run(pack);
    }

    public getKnowledgePackBySourceId(sourceId: string): any | null {
        if (!this.db) return null;
        return this.db.prepare('SELECT * FROM knowledge_packs WHERE source_id = ? ORDER BY updated_at DESC LIMIT 1').get(sourceId) || null;
    }

    public getKnowledgePacksByModeId(modeId: string): any[] {
        if (!this.db) return [];
        return this.db.prepare('SELECT * FROM knowledge_packs WHERE mode_id = ? ORDER BY updated_at DESC').all(modeId);
    }

    public deleteKnowledgePack(id: string): void {
        if (!this.db) return;
        this.db.prepare('DELETE FROM knowledge_packs WHERE id = ?').run(id);
    }

    public replaceKnowledgeCards(packId: string, sourceId: string, cards: Array<{
        id: string; type: string; title: string; slug: string; conceptId: string;
        body: string; bodyMarkdown?: string; sourcePagesJson: string; sourceSectionsJson: string;
        sourceQuotesJson: string; entitiesJson: string; tagsJson: string; relatedCardIdsJson: string;
        confidence: string; generatedFrom: string; sourceChecksum: string; cardVersion: number;
        pii?: boolean;
    }>, newSourceChecksum?: string): void {
        if (!this.db) throw new Error('Database not initialized');
        const txn = this.db.transaction(() => {
            // OKF Phase 6: a user-edited card whose source_checksum no longer
            // matches the freshly-extracted content (the underlying document
            // changed since the edit) is flagged needs_review instead of being
            // silently kept stale or silently overwritten. The card body
            // itself is left untouched — only the review flag changes.
            //
            // BUG FIX (2026-07-01, senior review): this used to derive the new
            // checksum from `cards[0]?.sourceChecksum` — if a regeneration
            // produces ZERO cards (content too short/unparseable to extract
            // any section, or every candidate rejected by OkfVerifier),
            // `cards[0]` is undefined, the checksum falls through to
            // `undefined`, the `if (newChecksum)` guard is falsy, and this
            // UPDATE never runs — a user-edited card whose source became
            // degenerate silently keeps its stale approval_status forever,
            // exactly the "silently kept stale" outcome this mechanism exists
            // to prevent. Callers now pass the checksum explicitly (always
            // known — it's the content hash of what was JUST extracted,
            // regardless of how many cards came out of it).
            if (newSourceChecksum) {
                this.db!.prepare(`
                    UPDATE knowledge_cards SET approval_status = 'needs_review'
                    WHERE pack_id = ? AND user_edited = 1 AND source_checksum != ? AND approval_status != 'needs_review'
                `).run(packId, newSourceChecksum);
            }
            this.db!.prepare('DELETE FROM knowledge_cards WHERE pack_id = ? AND user_edited = 0').run(packId);
            const ins = this.db!.prepare(`
                INSERT INTO knowledge_cards (id, pack_id, source_id, type, title, slug, concept_id, body, body_markdown,
                    source_pages_json, source_sections_json, source_quotes_json, entities_json, tags_json, related_card_ids_json,
                    confidence, generated_from, source_checksum, updated_at, card_version, pii)
                VALUES (@id, @packId, @sourceId, @type, @title, @slug, @conceptId, @body, @bodyMarkdown,
                    @sourcePagesJson, @sourceSectionsJson, @sourceQuotesJson, @entitiesJson, @tagsJson, @relatedCardIdsJson,
                    @confidence, @generatedFrom, @sourceChecksum, CURRENT_TIMESTAMP, @cardVersion, @pii)
                ON CONFLICT(id) DO UPDATE SET
                    body = excluded.body, body_markdown = excluded.body_markdown,
                    source_pages_json = excluded.source_pages_json, source_sections_json = excluded.source_sections_json,
                    source_quotes_json = excluded.source_quotes_json, entities_json = excluded.entities_json,
                    tags_json = excluded.tags_json, related_card_ids_json = excluded.related_card_ids_json,
                    confidence = excluded.confidence, source_checksum = excluded.source_checksum,
                    updated_at = CURRENT_TIMESTAMP, card_version = excluded.card_version, pii = excluded.pii
                WHERE knowledge_cards.user_edited = 0
            `);
            for (const c of cards) {
                ins.run({ ...c, packId, sourceId, bodyMarkdown: c.bodyMarkdown ?? null, pii: c.pii ? 1 : 0 });
            }
        });
        txn();
    }

    public getKnowledgeCardsByPackId(packId: string): any[] {
        if (!this.db) return [];
        return this.db.prepare('SELECT * FROM knowledge_cards WHERE pack_id = ? ORDER BY rowid ASC').all(packId);
    }

    public replaceKnowledgeEntities(packId: string, entities: Array<{
        id: string; slug: string; name: string; type: string; aliasesJson: string;
        description: string; sourceCardIdsJson: string; sourcePagesJson: string;
    }>): void {
        if (!this.db) throw new Error('Database not initialized');
        const txn = this.db.transaction(() => {
            this.db!.prepare('DELETE FROM knowledge_entities WHERE pack_id = ?').run(packId);
            // Defense-in-depth: OkfExtractor.extractEntityCards is the
            // primary dedup boundary (keys by slugify(name), matching this
            // row's id derivation), but a bare INSERT here would abort the
            // WHOLE transaction — including the entities inserted before
            // the colliding row — on any future extraction-side regression
            // that reintroduces a duplicate slug. ON CONFLICT DO UPDATE
            // makes a same-id collision within one pack a harmless
            // last-write-wins merge instead of a thrown exception that
            // silently drops every entity (see the 2026-07-01 "Mercury
            // X1"/"The Mercury X1" incident this fixed at the source).
            const ins = this.db!.prepare(`
                INSERT INTO knowledge_entities (id, pack_id, slug, name, type, aliases_json, description, source_card_ids_json, source_pages_json)
                VALUES (@id, @packId, @slug, @name, @type, @aliasesJson, @description, @sourceCardIdsJson, @sourcePagesJson)
                ON CONFLICT(id) DO UPDATE SET
                    slug = excluded.slug, name = excluded.name, type = excluded.type,
                    aliases_json = excluded.aliases_json, description = excluded.description,
                    source_card_ids_json = excluded.source_card_ids_json, source_pages_json = excluded.source_pages_json
            `);
            for (const e of entities) ins.run({ ...e, packId });
        });
        txn();
    }

    public getKnowledgeEntitiesByPackId(packId: string): any[] {
        if (!this.db) return [];
        return this.db.prepare('SELECT * FROM knowledge_entities WHERE pack_id = ? ORDER BY rowid ASC').all(packId);
    }

    public replaceKnowledgeRelations(packId: string, relations: Array<{
        id: string; subjectId: string; subjectType: string; predicate: string; objectId: string; objectType: string;
        sourceCardIdsJson: string; sourcePagesJson: string; confidence: string;
    }>): void {
        if (!this.db) throw new Error('Database not initialized');
        const txn = this.db.transaction(() => {
            this.db!.prepare('DELETE FROM knowledge_relations WHERE pack_id = ?').run(packId);
            // Defense-in-depth: same reasoning as replaceKnowledgeEntities
            // above — GraphExtractor already dedupes relations by
            // `${subjectId}|${predicate}|${objectId}` before emitting, but a
            // bare INSERT here would still abort the whole transaction (and
            // drop every relation already inserted) on any future
            // extraction-side regression. ON CONFLICT DO UPDATE degrades a
            // same-id collision to a harmless merge instead.
            const ins = this.db!.prepare(`
                INSERT INTO knowledge_relations (id, pack_id, subject_id, subject_type, predicate, object_id, object_type, source_card_ids_json, source_pages_json, confidence)
                VALUES (@id, @packId, @subjectId, @subjectType, @predicate, @objectId, @objectType, @sourceCardIdsJson, @sourcePagesJson, @confidence)
                ON CONFLICT(id) DO UPDATE SET
                    subject_id = excluded.subject_id, subject_type = excluded.subject_type,
                    predicate = excluded.predicate, object_id = excluded.object_id, object_type = excluded.object_type,
                    source_card_ids_json = excluded.source_card_ids_json, source_pages_json = excluded.source_pages_json,
                    confidence = excluded.confidence
            `);
            for (const r of relations) ins.run({ ...r, packId });
        });
        txn();
    }

    public getKnowledgeRelationsByPackId(packId: string): any[] {
        if (!this.db) return [];
        return this.db.prepare('SELECT * FROM knowledge_relations WHERE pack_id = ? ORDER BY rowid ASC').all(packId);
    }

    public upsertKnowledgeIndexVersion(v: {
        id: string; sourceId: string; packId?: string; packVersion: number; contentHash: string;
        embeddingSpace?: string; status: string; errorMessage?: string;
    }): void {
        if (!this.db) throw new Error('Database not initialized');
        this.db.prepare(`
            INSERT INTO knowledge_index_versions (id, source_id, pack_id, pack_version, content_hash, embedding_space, status, error_message, updated_at)
            VALUES (@id, @sourceId, @packId, @packVersion, @contentHash, @embeddingSpace, @status, @errorMessage, CURRENT_TIMESTAMP)
            ON CONFLICT(id) DO UPDATE SET
                pack_id = excluded.pack_id, pack_version = excluded.pack_version, content_hash = excluded.content_hash,
                embedding_space = excluded.embedding_space, status = excluded.status, error_message = excluded.error_message,
                updated_at = CURRENT_TIMESTAMP
        `).run({
            id: v.id, sourceId: v.sourceId, packId: v.packId ?? null, packVersion: v.packVersion,
            contentHash: v.contentHash, embeddingSpace: v.embeddingSpace ?? null, status: v.status,
            errorMessage: v.errorMessage ?? null,
        });
    }

    public getKnowledgeIndexVersionBySourceId(sourceId: string): any | null {
        if (!this.db) return null;
        return this.db.prepare('SELECT * FROM knowledge_index_versions WHERE source_id = ? ORDER BY updated_at DESC LIMIT 1').get(sourceId) || null;
    }

    // ── OKF Knowledge Card edit/approval (Phase 6) ──────────────────

    public getKnowledgeCardById(id: string): any | null {
        if (!this.db) return null;
        return this.db.prepare('SELECT * FROM knowledge_cards WHERE id = ?').get(id) || null;
    }

    /**
     * Snapshots the card's CURRENT row into knowledge_card_versions, then
     * applies the edit and marks the card user_edited=1 (so it survives the
     * next regenerate() call's `WHERE user_edited = 0` guard). Called before
     * every edit/approve/reject so the prior state is never lost.
     */
    public snapshotKnowledgeCardVersion(cardId: string, editedBy: string, editReason?: string): void {
        if (!this.db) return;
        const card = this.getKnowledgeCardById(cardId);
        if (!card) return;
        this.db.prepare(`
            INSERT INTO knowledge_card_versions (id, card_id, card_version, title, body, entities_json, tags_json, confidence, edited_by, edit_reason)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            `kcv_${cardId}_v${card.card_version}_${Date.now()}`,
            cardId, card.card_version, card.title, card.body, card.entities_json, card.tags_json, card.confidence,
            editedBy, editReason ?? null,
        );
    }

    public getKnowledgeCardVersions(cardId: string): any[] {
        if (!this.db) return [];
        return this.db.prepare('SELECT * FROM knowledge_card_versions WHERE card_id = ? ORDER BY created_at DESC').all(cardId);
    }

    public updateKnowledgeCard(id: string, updates: {
        title?: string; body?: string; entitiesJson?: string; tagsJson?: string; confidence?: string;
        userEdited?: boolean; approvalStatus?: string;
    }): void {
        if (!this.db) return;
        const sets: string[] = [];
        const values: any[] = [];
        if (updates.title !== undefined) { sets.push('title = ?'); values.push(updates.title); }
        if (updates.body !== undefined) { sets.push('body = ?'); values.push(updates.body); }
        if (updates.entitiesJson !== undefined) { sets.push('entities_json = ?'); values.push(updates.entitiesJson); }
        if (updates.tagsJson !== undefined) { sets.push('tags_json = ?'); values.push(updates.tagsJson); }
        if (updates.confidence !== undefined) { sets.push('confidence = ?'); values.push(updates.confidence); }
        if (updates.userEdited !== undefined) { sets.push('user_edited = ?'); values.push(updates.userEdited ? 1 : 0); }
        if (updates.approvalStatus !== undefined) { sets.push('approval_status = ?'); values.push(updates.approvalStatus); }
        if (sets.length === 0) return;
        sets.push('card_version = card_version + 1', 'updated_at = CURRENT_TIMESTAMP');
        values.push(id);
        this.db.prepare(`UPDATE knowledge_cards SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    }

    // ── Note Sections ─────────────────────────────────────────────

    public getNoteSections(modeId: string): any[] {
        if (!this.db) return [];
        try {
            return this.db.prepare(
                'SELECT * FROM mode_note_sections WHERE mode_id = ? ORDER BY sort_order ASC, created_at ASC'
            ).all(modeId);
        } catch (e) {
            console.error('[DatabaseManager] getNoteSections failed:', e);
            return [];
        }
    }

    public addNoteSection(section: { id: string; modeId: string; title: string; description: string; sortOrder: number }): void {
        if (!this.db) return;
        try {
            this.db.prepare(`
                INSERT INTO mode_note_sections (id, mode_id, title, description, sort_order)
                VALUES (?, ?, ?, ?, ?)
            `).run(section.id, section.modeId, section.title, section.description, section.sortOrder);
        } catch (e) {
            console.error('[DatabaseManager] addNoteSection failed:', e);
        }
    }

    public updateNoteSection(id: string, updates: { title?: string; description?: string; sortOrder?: number; compiledPrompt?: string }): void {
        if (!this.db) return;
        try {
            if (updates.title !== undefined) {
                this.db.prepare('UPDATE mode_note_sections SET title = ? WHERE id = ?').run(updates.title, id);
            }
            if (updates.description !== undefined) {
                this.db.prepare('UPDATE mode_note_sections SET description = ? WHERE id = ?').run(updates.description, id);
            }
            if (updates.sortOrder !== undefined) {
                this.db.prepare('UPDATE mode_note_sections SET sort_order = ? WHERE id = ?').run(updates.sortOrder, id);
            }
            if (updates.compiledPrompt !== undefined) {
                try { this.db.prepare('UPDATE mode_note_sections SET compiled_prompt = ? WHERE id = ?').run(updates.compiledPrompt, id); } catch { /* column may not exist on very old DB */ }
            }
        } catch (e) {
            console.error('[DatabaseManager] updateNoteSection failed:', e);
        }
    }

    /** Look up the mode that owns a given note-section id (used by the prompt compiler). */
    public getNoteSectionOwnerMode(sectionId: string): { sectionId: string; modeId: string; title: string; description: string; templateType?: string } | null {
        if (!this.db) return null;
        try {
            const row = this.db.prepare(`
                SELECT s.id as section_id, s.mode_id, s.title, s.description, m.template_type
                FROM mode_note_sections s JOIN modes m ON m.id = s.mode_id
                WHERE s.id = ?
            `).get(sectionId) as any;
            if (!row) return null;
            return { sectionId: row.section_id, modeId: row.mode_id, title: row.title, description: row.description, templateType: row.template_type };
        } catch (e) {
            console.error('[DatabaseManager] getNoteSectionOwnerMode failed:', e);
            return null;
        }
    }

    public deleteNoteSection(id: string): void {
        if (!this.db) return;
        try {
            this.db.prepare('DELETE FROM mode_note_sections WHERE id = ?').run(id);
        } catch (e) {
            console.error('[DatabaseManager] deleteNoteSection failed:', e);
        }
    }

    public deleteAllNoteSections(modeId: string): void {
        if (!this.db) return;
        try {
            this.db.prepare('DELETE FROM mode_note_sections WHERE mode_id = ?').run(modeId);
        } catch (e) {
            console.error('[DatabaseManager] deleteAllNoteSections failed:', e);
        }
    }

    // ============================================
    // System KV Store (app_state)
    // ============================================

    public getAppState(key: string): string | null {
        if (!this.db) return null;
        try {
            const stmt = this.db.prepare('SELECT value FROM app_state WHERE key = ?');
            const row = stmt.get(key) as { value: string } | undefined;
            return row ? row.value : null;
        } catch (error) {
            console.error(`[DatabaseManager] Failed to get app_state for key: ${key}`, error);
            return null;
        }
    }

    public setAppState(key: string, value: string): void {
        if (!this.db) return;
        try {
            const stmt = this.db.prepare('INSERT OR REPLACE INTO app_state (key, value) VALUES (?, ?)');
            stmt.run(key, value);
        } catch (error) {
            console.error(`[DatabaseManager] Failed to set app_state for key: ${key}`, error);
        }
    }

    public deleteAppState(key: string): void {
        if (!this.db) return;
        try {
            const stmt = this.db.prepare('DELETE FROM app_state WHERE key = ?');
            stmt.run(key);
        } catch (error) {
            console.error(`[DatabaseManager] Failed to delete app_state for key: ${key}`, error);
        }
    }

    /**
     * One-time migration: Copy existing BLOB embeddings into vec0 virtual tables.
     */
    private migrateExistingEmbeddings(): void {
        if (!this.db) return;

        // Migrate chunk embeddings
        try {
            const chunkRows = this.db.prepare(
                'SELECT id, embedding FROM chunks WHERE embedding IS NOT NULL'
            ).all() as any[];

            if (chunkRows.length > 0) {
                const insert = this.db.prepare(
                    'INSERT OR IGNORE INTO vec_chunks(chunk_id, embedding) VALUES (?, ?)'
                );
                const migrateAll = this.db.transaction(() => {
                    for (const row of chunkRows) {
                        try {
                            insert.run(row.id, row.embedding);
                        } catch (err) {
                            // On mismatch (e.g. mixed 768 and 3072 dims), nullify to re-embed later
                            this.db!.prepare('UPDATE chunks SET embedding = NULL WHERE id = ?').run(row.id);  // guarded at method entry; narrowing lost in catch
                        }
                    }
                });
                migrateAll();
                console.log(`[DatabaseManager] Migrated ${chunkRows.length} chunk embeddings to vec_chunks`);
            }
        } catch (e) {
            console.error('[DatabaseManager] Failed to migrate chunk embeddings:', e);
        }

        // Migrate summary embeddings
        try {
            const summaryRows = this.db.prepare(
                'SELECT id, embedding FROM chunk_summaries WHERE embedding IS NOT NULL'
            ).all() as any[];

            if (summaryRows.length > 0) {
                const insert = this.db.prepare(
                    'INSERT OR IGNORE INTO vec_summaries(summary_id, embedding) VALUES (?, ?)'
                );
                const migrateAll = this.db.transaction(() => {
                    for (const row of summaryRows) {
                        try {
                            insert.run(row.id, row.embedding);
                        } catch (err) {
                            this.db!.prepare('UPDATE chunk_summaries SET embedding = NULL WHERE id = ?').run(row.id);  // guarded at method entry; narrowing lost in catch
                        }
                    }
                });
                migrateAll();
                console.log(`[DatabaseManager] Migrated ${summaryRows.length} summary embeddings to vec_summaries`);
            }
        } catch (e) {
            console.error('[DatabaseManager] Failed to migrate summary embeddings:', e);
        }
    }

    /**
     * Known embedding dimension tiers.
     * Used by the v8 migration, delete operations, and table provisioning.
     * When a new provider dimension is encountered at runtime, ensureVecTableForDim() handles it.
     */
    public static readonly KNOWN_DIMS: readonly number[] = KNOWN_DIMS;

    /** Cache: dimensions for which vec0 tables have already been verified/created this session. */
    public ensuredDims = new Set<number>();

    /**
     * Lazily create a per-dimension vec0 table pair if not already present.
     * Called by v8 migration and at runtime when a new embedding dimension is first seen.
     * Uses an in-memory cache to avoid redundant CREATE TABLE IF NOT EXISTS on every insert.
     */
    public ensureVecTableForDim(dim: number): void {
        if (this.ensuredDims.has(dim)) return; // Already verified this session
        if (!this.db) return;
        // Guard against SQL injection: dim must be a positive integer
        if (!Number.isInteger(dim) || dim <= 0 || dim > 100_000) {
            console.error(`[DatabaseManager] Invalid dimension for vec0 table: ${dim}`);
            return;
        }
        try {
            this.db.exec(`
                CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks_${dim} USING vec0(
                    chunk_id INTEGER PRIMARY KEY,
                    embedding float[${dim}] distance_metric=cosine
                );
            `);
            this.db.exec(`
                CREATE VIRTUAL TABLE IF NOT EXISTS vec_summaries_${dim} USING vec0(
                    summary_id INTEGER PRIMARY KEY,
                    embedding float[${dim}] distance_metric=cosine
                );
            `);
            this.ensuredDims.add(dim);
            console.log(`[DatabaseManager] Ensured vec0 tables for dim=${dim}`);
        } catch (e) {
            console.error(`[DatabaseManager] Failed to create vec0 tables for dim=${dim}:`, e);
        }
    }


    /**
     * Enumerate every embedding dimension that actually has a vec0 table, unioned
     * with KNOWN_DIMS. Used by delete/clear paths so they cover dims provisioned
     * at runtime via ensureVecTableForDim() — not just the static KNOWN_DIMS list.
     *
     * Without this, a provider that introduced a dimension outside KNOWN_DIMS (e.g.
     * a future model at 1024d) would have its rows created on insert but NEVER
     * deleted, orphaning vec0 rows on re-index/fallback.
     */
    public getExistingVecDims(): number[] {
        const dims = new Set<number>(DatabaseManager.KNOWN_DIMS);
        if (!this.db) return [...dims];
        try {
            const rows = this.db.prepare(
                `SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'vec_chunks_%'`
            ).all() as { name: string }[];
            for (const r of rows) {
                const m = r.name.match(/^vec_chunks_(\d+)$/);
                if (m) dims.add(Number(m[1]));
            }
        } catch (e) {
            console.warn('[DatabaseManager] getExistingVecDims failed; falling back to KNOWN_DIMS:', e);
        }
        return [...dims];
    }

    /**
     * Check if sqlite-vec is available (any per-dimension vec0 table must exist)
     */
    public hasVecExtension(): boolean {
        if (!this.db) return false;
        try {
            // Check the most common dimension (Ollama 768); any may suffice
            this.db.prepare("SELECT count(*) FROM vec_chunks_768 LIMIT 1").get();
            return true;
        } catch (e) {
            return false;
        }
    }

    // ============================================
    // Public API
    // ============================================

    /**
     * Expose the raw database instance for external managers (e.g. ProfileDatabaseManager).
     */
    public getDb(): Database.Database | null {
        return this.db;
    }

    /**
     * Run `fn` inside a single better-sqlite3 transaction (BEGIN/COMMIT, with
     * automatic ROLLBACK if `fn` throws). Use this to make a multi-statement
     * write sequence atomic ACROSS several DatabaseManager methods that each
     * do their own internal `this.db.transaction(...)` — nested better-sqlite3
     * transactions are savepoint-based, so an inner method's transaction
     * commits to the OUTER one, and a throw anywhere rolls the whole thing
     * back. Without this, e.g. KnowledgePackStore.savePack's four separate
     * writes (pack/cards/entities/relations) + the source-row write can leave
     * a half-written, permanently-stuck pack if one fails mid-sequence (the
     * source's contentHash gate would then skip regeneration forever).
     */
    public runInTransaction<T>(fn: () => T): T {
        if (!this.db) throw new Error('DatabaseManager.runInTransaction: database not initialized');
        return this.db.transaction(fn)();
    }

    /** Path to the SQLite database file on disk. Used by worker threads. */
    public getDbPath(): string {
        return this.dbPath;
    }

    /**
     * Resolved sqlite-vec extension path (without platform file suffix).
     * Used by worker threads that open their own DB connection.
     */
    public getExtPath(): string {
        return this.resolvedExtPath;
    }

    public saveMeeting(meeting: Meeting, startTimeMs: number, durationMs: number) {
        if (!this.db) {
            console.error('[DatabaseManager] DB not initialized');
            return;
        }

        const insertMeeting = this.db.prepare(`
            INSERT OR REPLACE INTO meetings (id, title, start_time, duration_ms, summary_json, created_at, calendar_event_id, source, is_processed, summary_status, user_titled, is_live, folder_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        // RC-7 (2026-08-21): INSERT OR REPLACE rewrites the whole row, so a
        // user rename made while the row still said "Processing…" (the
        // placeholder → final-save window can span a slow summary generation)
        // was clobbered by the final save's generated title AND lost its
        // user_titled stamp. Pre-read the flag and let the user's title win.
        // Folders (v32) follow the same rule: every later save of a row that
        // was created inside a folder (live-note flush, final save, RAG
        // re-save) must NOT drop the folder assignment — the folder_id of the
        // existing row wins unless the caller explicitly supplies one.
        const readUserTitle = this.db.prepare(`SELECT title, COALESCE(user_titled, 0) AS user_titled, folder_id FROM meetings WHERE id = ?`);

        const insertTranscript = this.db.prepare(`
            INSERT INTO transcripts (meeting_id, speaker, content, timestamp_ms)
            VALUES (?, ?, ?, ?)
        `);

        const insertInteraction = this.db.prepare(`
            INSERT INTO ai_interactions (meeting_id, type, timestamp, user_query, ai_response, metadata_json)
            VALUES (?, ?, ?, ?, ?, ?)
        `);

        // Idempotency: the meetings row uses INSERT OR REPLACE, but transcripts
        // and ai_interactions are append-only with autoincrement ids, so a second
        // saveMeeting() for the same id (the normal flow: stopMeeting writes a
        // placeholder snapshot, then processAndSaveMeeting writes the final one —
        // see MeetingPersistence) would APPEND a duplicate copy of every child
        // row. Recovery re-saves and RAG reprocessing would then read doubled
        // transcripts. Clearing the existing children inside the same transaction
        // before re-inserting makes saveMeeting idempotent for a given meeting id.
        const deleteTranscripts = this.db.prepare(`DELETE FROM transcripts WHERE meeting_id = ?`);
        const deleteInteractions = this.db.prepare(`DELETE FROM ai_interactions WHERE meeting_id = ?`);

        const summaryJson = JSON.stringify({
            legacySummary: meeting.summary,
            detailedSummary: meeting.detailedSummary
        });

        const runTransaction = this.db.transaction(() => {
            // 1. Insert Meeting (a user-renamed row keeps its title — RC-7)
            const existing = readUserTitle.get(meeting.id) as { title: string; user_titled: number; folder_id: string | null } | undefined;
            const userTitled = existing?.user_titled === 1;
            // Folders (v32): an explicit folderId on the incoming Meeting wins;
            // otherwise preserve the row's existing assignment so idempotent
            // re-saves (live-note flush → final save → RAG re-save) never orphan
            // a meeting out of its folder.
            const folderId = meeting.folderId !== undefined ? meeting.folderId : (existing?.folder_id ?? null);
            insertMeeting.run(
                meeting.id,
                userTitled && existing?.title ? existing.title : meeting.title,
                startTimeMs,
                durationMs,
                summaryJson,
                meeting.date, // Using the ISO string as created_at for sorting simply
                meeting.calendarEventId || null,
                meeting.source || 'manual',
                meeting.isProcessed ? 1 : 0,
                meeting.summaryStatus || (meeting.isProcessed ? 'completed' : 'queued'),
                userTitled ? 1 : 0,
                meeting.isLive ? 1 : 0,
                folderId
            );

            // 2. Insert Transcript
            // Clear any prior child rows for this meeting first so re-saving the
            // same meeting id (placeholder → final) does not duplicate them.
            deleteTranscripts.run(meeting.id);
            if (meeting.transcript) {
                for (const segment of meeting.transcript) {
                    insertTranscript.run(
                        meeting.id,
                        segment.speaker,
                        segment.text,
                        segment.timestamp
                    );
                }
            }

            // 3. Insert Interactions
            deleteInteractions.run(meeting.id);
            if (meeting.usage) {
                for (const usage of meeting.usage) {
                    let metadata = null;
                    if (usage.items) {
                        metadata = JSON.stringify(usage.items);
                    } else if (usage.type === 'followup_questions' && usage.answer) {
                        // Sometimes answer is the array for questions, or we store it in metadata
                        // In intelligence manager we pushed: { type: 'followup_questions', answer: fullQuestions }
                        // Let's store that 'answer' (array) in metadata for this type
                        if (Array.isArray(usage.answer)) {
                            metadata = JSON.stringify(usage.answer);
                        }
                    }

                    // Normalization
                    const answerText = Array.isArray(usage.answer) ? null : usage.answer || null;
                    const queryText = usage.question || null;

                    insertInteraction.run(
                        meeting.id,
                        usage.type,
                        usage.timestamp,
                        queryText,
                        answerText,
                        metadata
                    );
                }
            }
        });

        try {
            runTransaction();
            console.log(`[DatabaseManager] Successfully saved meeting ${meeting.id}`);
        } catch (err) {
            console.error(`[DatabaseManager] Failed to save meeting ${meeting.id}`, err);
            throw err;
        }
    }

    public updateMeetingTitle(id: string, title: string): boolean {
        if (!this.db) return false;
        try {
            // RC-7: a rename is the USER's title. Stamp user_titled so the
            // generated-title writers (saveMeeting's final write, the deferred
            // replaceDetailedSummary) yield to it from now on.
            const stmt = this.db.prepare('UPDATE meetings SET title = ?, user_titled = 1 WHERE id = ?');
            const info = stmt.run(title, id);
            return info.changes > 0;
        } catch (error) {
            console.error(`[DatabaseManager] Failed to update title for meeting ${id}:`, error);
            return false;
        }
    }

    public updateSummaryStatus(id: string, status: SummaryStatus): boolean {
        if (!this.db) return false;
        try {
            const allowed = new Set(['queued', 'chunking', 'summarizing_chunks', 'reducing', 'validating', 'completed', 'failed']);
            if (!allowed.has(status)) return false;
            const info = this.db.prepare('UPDATE meetings SET summary_status = ? WHERE id = ?').run(status, id);
            return info.changes > 0;
        } catch (error) {
            console.error(`[DatabaseManager] Failed to update summary status for meeting ${id}:`, error);
            return false;
        }
    }

    public getMeetingsWithSummaryStatus(status: SummaryStatus): Array<{ id: string; title: string; summaryStatus: SummaryStatus; date: string }> {
        if (!this.db) return [];
        try {
            const rows = this.db.prepare('SELECT id, title, created_at, summary_status FROM meetings WHERE summary_status = ? ORDER BY created_at DESC').all(status) as Array<{ id: string; title: string; created_at: string; summary_status: SummaryStatus }>;
            return rows.map(row => ({ id: row.id, title: row.title, date: row.created_at, summaryStatus: row.summary_status }));
        } catch (error) {
            console.error(`[DatabaseManager] Failed to get meetings with summary status ${status}:`, error);
            return [];
        }
    }

    public updateMeetingSummary(id: string, updates: { overview?: string, actionItems?: string[], keyPoints?: string[], actionItemsTitle?: string, keyPointsTitle?: string }): boolean {
        if (!this.db) return false;

        try {
            // 1. Get current summary_json
            const row = this.db.prepare('SELECT summary_json FROM meetings WHERE id = ?').get(id) as any;
            if (!row) return false;

            const existingData = JSON.parse(row.summary_json || '{}');
            const currentDetailed = existingData.detailedSummary || {};

            // 2. Merge updates
            const newDetailed = {
                ...currentDetailed,
                ...updates
            };

            // Should likely filter out undefined updates if spread doesn't handle them how we want,
            // but spread over undefined is fine. We want to overwrite if provided.
            // If updates.overview is empty string, it overwrites.
            // If updates.overview is undefined, we use ...updates trick:
            // Actually spread only includes own enumerable properties. If I pass { overview: "new" }, it works.

            // However, we need to be careful not to wipe legacySummary if it exists
            const newData = {
                ...existingData,
                detailedSummary: newDetailed
            };

            const jsonStr = JSON.stringify(newData);

            // 3. Write back
            const stmt = this.db.prepare('UPDATE meetings SET summary_json = ? WHERE id = ?');
            const info = stmt.run(jsonStr, id);
            return info.changes > 0;

        } catch (error) {
            console.error(`[DatabaseManager] Failed to update summary for meeting ${id}:`, error);
            return false;
        }
    }

    /**
     * Replace the entire detailedSummary blob (used by regenerate-notes). Preserves any
     * sibling keys in summary_json (e.g. legacy fields). Also updates the title column when
     * the new summary carries one. summary_status is set to the provided value.
     */
    public replaceDetailedSummary(id: string, detailedSummary: Meeting['detailedSummary'], opts?: { title?: string; summaryStatus?: SummaryStatus }): boolean {
        if (!this.db) return false;
        try {
            const row = this.db.prepare('SELECT summary_json FROM meetings WHERE id = ?').get(id) as any;
            if (!row) return false;
            const existingData = JSON.parse(row.summary_json || '{}');
            const newData = { ...existingData, detailedSummary };
            const jsonStr = JSON.stringify(newData);
            if (opts?.title && opts?.summaryStatus) {
                // RC-7 (2026-08-21): the deferred V3 summary used to overwrite
                // the title UNCONDITIONALLY — a user rename made even after the
                // meeting ended was silently reverted whenever the detailed
                // summary landed. A generated title never beats a user one.
                const info = this.db.prepare(
                    'UPDATE meetings SET summary_json = ?, title = CASE WHEN COALESCE(user_titled, 0) = 1 THEN title ELSE ? END, summary_status = ? WHERE id = ?',
                ).run(jsonStr, opts.title, opts.summaryStatus, id);
                return info.changes > 0;
            }
            if (opts?.summaryStatus) {
                const info = this.db.prepare('UPDATE meetings SET summary_json = ?, summary_status = ? WHERE id = ?').run(jsonStr, opts.summaryStatus, id);
                return info.changes > 0;
            }
            const info = this.db.prepare('UPDATE meetings SET summary_json = ? WHERE id = ?').run(jsonStr, id);
            return info.changes > 0;
        } catch (error) {
            console.error(`[DatabaseManager] Failed to replace detailed summary for meeting ${id}:`, error);
            return false;
        }
    }

    /**
     * Persist the per-meeting speaker rename map into detailedSummary.speakerLabels.
     * Additive: never touches transcript rows or other summary fields.
     */
    public updateSpeakerLabels(id: string, speakerLabels: Record<string, string>): boolean {
        if (!this.db) return false;
        try {
            const row = this.db.prepare('SELECT summary_json FROM meetings WHERE id = ?').get(id) as any;
            if (!row) return false;
            const existingData = JSON.parse(row.summary_json || '{}');
            // Preserve whatever detailedSummary shape exists (V3, legacy, or none). When it is
            // absent we attach labels to a minimal object WITHOUT inventing empty
            // actionItems/keyPoints arrays that the renderer would treat as "processed but
            // empty" — labels alone is a safe additive blob a later summarize will merge into.
            const currentDetailed = existingData.detailedSummary;
            const newDetailed = currentDetailed && typeof currentDetailed === 'object'
                ? { ...currentDetailed, speakerLabels }
                : { speakerLabels };
            const newData = { ...existingData, detailedSummary: newDetailed };
            const info = this.db.prepare('UPDATE meetings SET summary_json = ? WHERE id = ?').run(JSON.stringify(newData), id);
            return info.changes > 0;
        } catch (error) {
            console.error(`[DatabaseManager] Failed to update speaker labels for meeting ${id}:`, error);
            return false;
        }
    }

    /**
     * Recent meetings list. Folders (v32):
     *  - folderId === undefined → ALL meetings (used by global search and other
     *    cross-folder consumers; legacy behavior).
     *  - folderId === null → root only (folder_id IS NULL): the main launcher
     *    list when no folder is open.
     *  - folderId === '<id>' → only that folder's meetings.
     */
    public getRecentMeetings(limit: number = 50, folderId?: string | null): Meeting[] {
        if (!this.db) return [];

        // Exclude the transient JIT live-indexing scaffold (v31: the live-note
        // row is the user-facing "Live" entry; the JIT row is internal FK
        // scaffolding deleted at meeting end and must not appear in history).
        let sql = `
            SELECT * FROM meetings
            WHERE id != ?
        `;
        const params: any[] = [JIT_LIVE_MEETING_ID];
        if (folderId === null) {
            sql += ` AND folder_id IS NULL`;
        } else if (typeof folderId === 'string') {
            sql += ` AND folder_id = ?`;
            params.push(folderId);
        }
        sql += `
            ORDER BY created_at DESC
            LIMIT ?
        `;
        params.push(limit);

        const stmt = this.db.prepare(sql);

        const rows = stmt.all(...params) as any[];

        return rows.map(row => {
            const summaryData = JSON.parse(row.summary_json || '{}');

            // Format duration string if needed, but we typically store ms
            // Let's recreate the 'duration' string "MM:SS" from duration_ms
            const minutes = Math.floor(row.duration_ms / 60000);
            const seconds = Math.floor((row.duration_ms % 60000) / 1000);
            const durationStr = `${minutes}:${seconds.toString().padStart(2, '0')}`;

            return {
                id: row.id,
                title: row.title,
                date: row.created_at, // Use the stored ISO string
                duration: durationStr,
                summary: summaryData.legacySummary || '',
                detailedSummary: summaryData.detailedSummary,
                calendarEventId: row.calendar_event_id,
                source: row.source as any,
                summaryStatus: row.summary_status as SummaryStatus | undefined,
                isLive: (row.is_live ?? 0) === 1,
                folderId: row.folder_id ?? null,
                // We don't load full transcript/usage for list view to keep it light
                transcript: [] as any[],
                usage: [] as any[]
            };
        });
    }

    public getMeetingDetails(id: string): Meeting | null {
        if (!this.db) return null;

        // The transient JIT scaffold is internal — never render it as a meeting.
        if (id === JIT_LIVE_MEETING_ID) return null;

        const meetingStmt = this.db.prepare('SELECT * FROM meetings WHERE id = ?');
        const meetingRow = meetingStmt.get(id) as any;

        if (!meetingRow) return null;

        // Get Transcript
        const transcriptStmt = this.db.prepare('SELECT * FROM transcripts WHERE meeting_id = ? ORDER BY timestamp_ms ASC');
        const transcriptRows = transcriptStmt.all(id) as any[];

        // Get Usage
        const usageStmt = this.db.prepare('SELECT * FROM ai_interactions WHERE meeting_id = ? ORDER BY timestamp ASC');
        const usageRows = usageStmt.all(id) as any[];

        // Reconstruct
        const summaryData = JSON.parse(meetingRow.summary_json || '{}');
        const minutes = Math.floor(meetingRow.duration_ms / 60000);
        const seconds = Math.floor((meetingRow.duration_ms % 60000) / 1000);
        const durationStr = `${minutes}:${seconds.toString().padStart(2, '0')}`;

        const transcript = transcriptRows.map(row => ({
            speaker: row.speaker,
            text: row.content,
            timestamp: row.timestamp_ms
        }));

        const usage = usageRows.map(row => {
            let items: string[] | undefined;
            let answer = row.ai_response;

            if (row.metadata_json) {
                try {
                    const parsed = JSON.parse(row.metadata_json);
                    if (Array.isArray(parsed)) {
                        items = parsed;
                        // Special case: for 'followup_questions', earlier we treated 'answer' as the array in memory
                        // UI expects appropriate field. If type is 'followup_questions', usually answer is null and items has the questions.
                    }
                } catch (e) { console.warn('[DatabaseManager] Failed to parse metadata_json for interaction:', row?.id, e); }
            }

            return {
                type: row.type,
                timestamp: row.timestamp,
                question: row.user_query,
                answer: answer,
                items: items
            };
        });

        return {
            id: meetingRow.id,
            title: meetingRow.title,
            date: meetingRow.created_at,
            duration: durationStr,
            summary: summaryData.legacySummary || '',
            detailedSummary: summaryData.detailedSummary,
            calendarEventId: meetingRow.calendar_event_id,
            source: meetingRow.source,
            summaryStatus: meetingRow.summary_status as SummaryStatus | undefined,
            isLive: (meetingRow.is_live ?? 0) === 1,
            folderId: meetingRow.folder_id ?? null,
            transcript: transcript,
            usage: usage
        };
    }

    public deleteMeeting(id: string): boolean {
        if (!this.db) return false;

        try {
            // F-705: reap the vec0 rows FIRST. `vec_chunks_*`/`vec_summaries_*`
            // are USING vec0 VIRTUAL tables, and SQLite virtual tables carry no
            // foreign keys — an ON DELETE CASCADE from `meetings` can never
            // reach them. VectorStore's own delete paths already issue explicit
            // DELETEs for exactly this reason, but deleteMeeting/clearAllData
            // never call into it, so every deleted meeting left its vectors
            // behind. Orphans then consume slots in the KNN top-K
            // (searchSimilarNative silently drops ids it cannot resolve back to
            // `chunks`), degrading recall monotonically with every deletion.
            // Must run BEFORE the parent DELETE, while the chunk ids are still
            // resolvable.
            // R-12: the vector reap and the parent DELETE must be one unit. Ordering
            // the reap first is required (the chunk ids must still resolve), but with
            // no transaction a failure of the parent DELETE left the vectors gone and
            // the meeting present. This was inert only while R-01 meant nothing was
            // ever deleted; fixing R-01 makes it reachable.
            const info = this.db.transaction((meetingId: string) => {
                this.deleteVectorsForMeeting(meetingId);
                return this.db!.prepare('DELETE FROM meetings WHERE id = ?').run(meetingId);
            })(id);
            console.log(`[DatabaseManager] Deleted meeting ${id}. Changes: ${info.changes}`);
            return info.changes > 0;
        } catch (error) {
            console.error(`[DatabaseManager] Failed to delete meeting ${id}:`, error);
            return false;
        }
    }

    /**
     * Delete the vec0 index rows belonging to a meeting (F-705).
     *
     * vec0 virtual tables cannot participate in foreign-key cascades, so this
     * has to be explicit. Resolves chunk/summary ids through the ordinary
     * tables, so it MUST be called before the parent row is removed. Best-effort
     * per dimension: a dimension table may legitimately not exist.
     */
    public deleteVectorsForMeeting(meetingId: string): void {
        if (!this.db) return;
        try {
            const dims = this.getExistingVecDims();
            if (!dims.length) return;
            const chunkIds = (this.db.prepare('SELECT id FROM chunks WHERE meeting_id = ?')
                .all(meetingId) as any[]).map((r) => r.id);
            // R-01: chunk_summaries is keyed per-MEETING — (id, meeting_id UNIQUE,
            // summary_text, embedding, created_at). There is no `chunk_id` column and
            // no migration adds one, so the previous `JOIN chunks c ON c.id = cs.chunk_id`
            // threw at prepare() time. That prepare sits outside the per-dim loop and
            // inside the outer try, so the throw unwound past the per-dim catches into
            // the outer catch — which only warns. The chunk deletes below were never
            // reached and this function reaped nothing. Matches VectorStore.ts:676/725.
            const summaryIds = (this.db.prepare('SELECT id FROM chunk_summaries WHERE meeting_id = ?')
                .all(meetingId) as any[]).map((r) => r.id);
            // SQLite caps bound parameters (measured 32766 in this build), so delete in
            // batches rather than building one placeholder per chunk.
            const BATCH = 500;
            const deleteIn = (table: string, column: string, ids: number[]) => {
                for (let i = 0; i < ids.length; i += BATCH) {
                    const slice = ids.slice(i, i + BATCH);
                    const ph = slice.map(() => '?').join(',');
                    try {
                        this.db!.prepare(`DELETE FROM ${table} WHERE ${column} IN (${ph})`).run(...slice);
                    } catch (e: any) {
                        // R-20: getExistingVecDims() returns KNOWN_DIMS ∪ discovered, so on a
                        // normal install most dims have no table and "no such table" is the
                        // expected, harmless outcome. Swallowing EVERYTHING else too meant a
                        // real reap failure was indistinguishable from that — the same silence
                        // that let R-01 hide for a full campaign. Narrow it.
                        if (!/no such table/i.test(String(e?.message ?? e))) throw e;
                    }
                }
            };
            for (const dim of dims) {
                if (chunkIds.length) deleteIn(`vec_chunks_${dim}`, 'chunk_id', chunkIds);
                if (summaryIds.length) deleteIn(`vec_summaries_${dim}`, 'summary_id', summaryIds);
            }
        } catch (e) {
            // R-20: R-12 wrapped this and the parent DELETE in one transaction so the
            // meeting could not survive a failed reap. Swallowing here defeated that
            // in the only direction that matters: the transaction saw no error and
            // committed the DELETE anyway, leaving the meeting gone and its vectors
            // orphaned in the vec0 tables — where they keep consuming KNN top-K slots
            // that searchSimilarNative can no longer resolve back to `chunks`.
            console.error(`[DatabaseManager] deleteVectorsForMeeting(${meetingId}) failed; aborting the delete:`, e);
            throw e;
        }
    }

    public getUnprocessedMeetings(): Meeting[] {
        if (!this.db) return [];

        // is_processed = 0 means false
        const stmt = this.db.prepare(`
            SELECT * FROM meetings
            WHERE is_processed = 0 AND id != ?
            ORDER BY created_at DESC
        `);

        const rows = stmt.all(JIT_LIVE_MEETING_ID) as any[];

        return rows.map(row => {
            // Reconstruct minimal meeting object for processing
            // We mainly need ID to fetch transcripts later
            const summaryData = JSON.parse(row.summary_json || '{}');
            const minutes = Math.floor(row.duration_ms / 60000);
            const seconds = Math.floor((row.duration_ms % 60000) / 1000);
            const durationStr = `${minutes}:${seconds.toString().padStart(2, '0')}`;

            return {
                id: row.id,
                title: row.title,
                date: row.created_at,
                duration: durationStr,
                summary: summaryData.legacySummary || '',
                detailedSummary: summaryData.detailedSummary,
                calendarEventId: row.calendar_event_id,
                source: row.source,
                isProcessed: false,
                summaryStatus: row.summary_status as SummaryStatus | undefined,
                isLive: (row.is_live ?? 0) === 1,
                transcript: [] as any[], // Fetched separately via getMeetingDetails or manually if needed
                usage: [] as any[]
            };
        });
    }

    // ─── Live meeting notes (v31) ───────────────────────────────────────────
    // A meetings row is created at meeting Start (is_live=1) so the note exists
    // immediately and survives a crash/quit mid-meeting. Every method here is
    // guarded and returns a neutral value when the database is unavailable —
    // live-note persistence must never be able to break the meeting itself.

    /**
     * Mark an existing (already finalized) meeting note live again so a
     * "Continue this session" resume adopts the SAME row instead of minting a
     * new id. Touches ONLY the is_live flag — summary_json, transcript, and
     * usage children are left intact (they are re-written on the live flush and
     * the stop-time final save).
     */
    public markMeetingLive(id: string): boolean {
        if (!this.db) return false;
        try {
            const info = this.db.prepare(`UPDATE meetings SET is_live = 1, is_processed = 0, summary_status = 'queued' WHERE id = ?`).run(id);
            return (info.changes ?? 0) > 0;
        } catch (e) {
            console.error('[DatabaseManager] markMeetingLive failed:', e);
            return false;
        }
    }

    /** Raw start_time + duration_ms for a meeting (meeting "continue" timing). */
    public getMeetingTiming(id: string): { startTime: number; durationMs: number } | null {
        if (!this.db) return null;
        try {
            const row = this.db.prepare('SELECT start_time, duration_ms FROM meetings WHERE id = ?').get(id) as any;
            if (!row) return null;
            return { startTime: row.start_time as number, durationMs: row.duration_ms as number };
        } catch (e) {
            console.error('[DatabaseManager] getMeetingTiming failed:', e);
            return null;
        }
    }

    /** All meetings currently marked live (rows created at Start, not yet finalized). */
    public getLiveMeetings(): Meeting[] {
        if (!this.db) return [];
        try {
            const rows = this.db.prepare('SELECT * FROM meetings WHERE is_live = 1 ORDER BY created_at DESC').all() as any[];
            return rows.map((row) => {
                const summaryData = JSON.parse(row.summary_json || '{}');
                const minutes = Math.floor(row.duration_ms / 60000);
                const seconds = Math.floor((row.duration_ms % 60000) / 1000);
                return {
                    id: row.id,
                    title: row.title,
                    date: row.created_at,
                    duration: `${minutes}:${seconds.toString().padStart(2, '0')}`,
                    summary: summaryData.legacySummary || '',
                    detailedSummary: summaryData.detailedSummary,
                    calendarEventId: row.calendar_event_id,
                    source: row.source as any,
                    isProcessed: (row.is_processed ?? 0) === 1,
                    summaryStatus: row.summary_status as SummaryStatus | undefined,
                    isLive: true,
                    transcript: [] as any[],
                    usage: [] as any[]
                };
            });
        } catch (e) {
            console.error('[DatabaseManager] getLiveMeetings failed:', e);
            return [];
        }
    }

    /**
     * Flush the current in-memory transcript + usage into a live meeting row.
     * Idempotent: children are cleared then re-inserted inside one transaction,
     * exactly like saveMeeting's placeholder → final pattern, so re-running with
     * the same meeting id never duplicates rows. FINAL transcript segments and
     * usage entries only — the same persistence semantics as a stopped meeting.
     */
    public upsertLiveMeetingSnapshot(meetingId: string, transcript: Array<{ speaker: string; text: string; timestamp: number }>, usage: any[]): boolean {
        if (!this.db) return false;
        try {
            const deleteTranscripts = this.db.prepare(`DELETE FROM transcripts WHERE meeting_id = ?`);
            const deleteInteractions = this.db.prepare(`DELETE FROM ai_interactions WHERE meeting_id = ?`);
            const insertTranscript = this.db.prepare(`
                INSERT INTO transcripts (meeting_id, speaker, content, timestamp_ms)
                VALUES (?, ?, ?, ?)
            `);
            const insertInteraction = this.db.prepare(`
                INSERT INTO ai_interactions (meeting_id, type, timestamp, user_query, ai_response, metadata_json)
                VALUES (?, ?, ?, ?, ?, ?)
            `);
            this.db.transaction(() => {
                deleteTranscripts.run(meetingId);
                if (transcript) {
                    for (const segment of transcript) {
                        insertTranscript.run(meetingId, segment.speaker, segment.text, segment.timestamp);
                    }
                }
                deleteInteractions.run(meetingId);
                if (usage) {
                    for (const entry of usage) {
                        let metadata = null;
                        if (Array.isArray(entry.items)) {
                            metadata = JSON.stringify(entry.items);
                        } else if (entry.type === 'followup_questions' && Array.isArray(entry.answer)) {
                            metadata = JSON.stringify(entry.answer);
                        }
                        const answerText = Array.isArray(entry.answer) ? null : (entry.answer || null);
                        const queryText = entry.question || null;
                        insertInteraction.run(meetingId, entry.type || 'chat', entry.timestamp || Date.now(), queryText, answerText, metadata);
                    }
                }
            })();
            return true;
        } catch (e) {
            console.error(`[DatabaseManager] upsertLiveMeetingSnapshot failed for ${meetingId}:`, e);
            return false;
        }
    }

    /**
     * Adopt orphaned live rows left behind by an app quit/crash mid-meeting:
     * the meeting is over (no live capture anymore), so the row becomes a
     * normal unprocessed meeting that the existing recovery pipeline finalizes
     * (title/summary generation). Duration is recomputed from start_time since
     * duration_ms was never updated while live. Returns the number of rows
     * adopted. Idempotent — a second call finds no is_live=1 rows.
     */
    public adoptOrphanedLiveMeetings(now: number = Date.now()): number {
        if (!this.db) return 0;
        try {
            const info = this.db.prepare(`
                UPDATE meetings
                SET is_live = 0,
                    is_processed = 0,
                    summary_status = 'queued',
                    duration_ms = MAX(1, ? - start_time)
                WHERE is_live = 1
            `).run(now);
            return info.changes ?? 0;
        } catch (e) {
            console.error('[DatabaseManager] adoptOrphanedLiveMeetings failed:', e);
            return 0;
        }
    }

    // ============================================
    // Meeting folders (v32) — single-level, Google-Drive style
    // ============================================
    //
    // Every method is guarded and returns a neutral value when the database is
    // unavailable. Folder operations never touch meeting content; deleting a
    // folder moves its meetings back to root (folder_id = NULL) inside the same
    // transaction — meetings are never deleted with their folder.

    /** Create a folder. Returns null when the name is blank or the DB is unavailable. */
    public createFolder(name: string): Folder | null {
        if (!this.db) return null;
        const trimmed = (name || '').trim();
        if (!trimmed) return null;
        try {
            const id = crypto.randomUUID();
            const createdAt = new Date().toISOString();
            this.db.prepare('INSERT INTO folders (id, name, created_at) VALUES (?, ?, ?)').run(id, trimmed, createdAt);
            console.log(`[DatabaseManager] Created folder ${id} ("${trimmed}")`);
            return { id, name: trimmed, createdAt };
        } catch (error) {
            console.error('[DatabaseManager] Failed to create folder:', error);
            return null;
        }
    }

    /** All folders with their current meeting counts, name-sorted (case-insensitive). */
    public listFolders(): Folder[] {
        if (!this.db) return [];
        try {
            const rows = this.db.prepare(`
                SELECT f.id, f.name, f.created_at AS createdAt, COUNT(m.id) AS meetingCount
                FROM folders f
                LEFT JOIN meetings m ON m.folder_id = f.id
                GROUP BY f.id, f.name, f.created_at
                ORDER BY f.name COLLATE NOCASE ASC
            `).all() as Array<{ id: string; name: string; createdAt: string; meetingCount: number }>;
            return rows.map(r => ({ id: r.id, name: r.name, createdAt: r.createdAt, meetingCount: r.meetingCount }));
        } catch (error) {
            console.error('[DatabaseManager] Failed to list folders:', error);
            return [];
        }
    }

    /** Rename a folder. Returns false for blank names, missing folders, or DB failures. */
    public renameFolder(id: string, name: string): boolean {
        if (!this.db) return false;
        const trimmed = (name || '').trim();
        if (!trimmed) return false;
        try {
            const info = this.db.prepare('UPDATE folders SET name = ? WHERE id = ?').run(trimmed, id);
            if (info.changes > 0) console.log(`[DatabaseManager] Renamed folder ${id} → "${trimmed}"`);
            return info.changes > 0;
        } catch (error) {
            console.error(`[DatabaseManager] Failed to rename folder ${id}:`, error);
            return false;
        }
    }

    /**
     * Delete a folder.
     *
     * Default (opts.deleteMeetings === false): meetings inside it are moved
     * back to root (folder_id → NULL) in the SAME transaction — contained
     * meetings are never deleted.
     *
     * opts.deleteMeetings === true: contained meetings are deleted PERMANENTLY
     * first (each through deleteMeeting, so vector rows are reaped and child
     * transcript/usage/chunk rows cascade), then the folder row — all one
     * transaction, so a failure halfway rolls the whole thing back.
     *
     * Returns false when the folder does not exist or the DB is unavailable.
     */
    public deleteFolder(id: string, opts?: { deleteMeetings?: boolean }): boolean {
        if (!this.db) return false;
        const deleteMeetings = opts?.deleteMeetings === true;
        try {
            const result = this.db.transaction(() => {
                if (deleteMeetings) {
                    const rows = this.db!.prepare('SELECT id FROM meetings WHERE folder_id = ?').all(id) as Array<{ id: string }>;
                    for (const row of rows) {
                        // deleteMeeting = vector reap (F-705) + parent DELETE
                        // with FK cascade to transcripts/usage/chunks. Nested
                        // transaction → savepoint, commits to the outer one.
                        this.deleteMeeting(row.id);
                    }
                } else {
                    this.db!.prepare('UPDATE meetings SET folder_id = NULL WHERE folder_id = ?').run(id);
                }
                return this.db!.prepare('DELETE FROM folders WHERE id = ?').run(id);
            })();
            if (result.changes > 0) {
                console.log(`[DatabaseManager] Deleted folder ${id} (${deleteMeetings ? 'contained meetings deleted' : 'contained meetings moved to root'})`);
            }
            return result.changes > 0;
        } catch (error) {
            console.error(`[DatabaseManager] Failed to delete folder ${id}:`, error);
            return false;
        }
    }

    /**
     * Move a meeting to a folder (folderId) or back to root (null).
     * A non-null folderId must reference an existing folder — the FK would
     * reject a dangling id anyway, but we fail cleanly with false instead.
     */
    public moveMeeting(meetingId: string, folderId: string | null): boolean {
        if (!this.db) return false;
        try {
            if (folderId !== null) {
                const folder = this.db.prepare('SELECT id FROM folders WHERE id = ?').get(folderId);
                if (!folder) return false;
            }
            const info = this.db.prepare('UPDATE meetings SET folder_id = ? WHERE id = ?').run(folderId, meetingId);
            if (info.changes > 0) console.log(`[DatabaseManager] Moved meeting ${meetingId} → folder ${folderId ?? 'root'}`);
            return info.changes > 0;
        } catch (error) {
            console.error(`[DatabaseManager] Failed to move meeting ${meetingId}:`, error);
            return false;
        }
    }

    /**
     * Bulk-delete meetings (launcher multi-select, v32). Runs inside ONE
     * transaction so a failure midway rolls the whole batch back — no partial
     * deletion. Each meeting is reaped the same way deleteMeeting does it:
     * vec0 rows first (F-705: virtual tables ignore FK cascades), then the
     * parent DELETE which cascades to transcripts/usage/chunks. Unlike
     * deleteMeeting this path does NOT swallow per-row errors — a real DB
     * failure propagates and aborts the batch.
     *
     * Returns the number of meetings actually deleted (0 on failure/invalid
     * input). Unknown ids are skipped (changes === 0 for them).
     */
    public deleteMeetings(ids: string[]): number {
        if (!this.db) return 0;
        const cleanIds = (Array.isArray(ids) ? ids : []).filter((id) => typeof id === 'string' && id.length > 0);
        if (cleanIds.length === 0) return 0;
        try {
            const deleted = this.db.transaction(() => {
                let count = 0;
                for (const id of cleanIds) {
                    this.deleteVectorsForMeeting(id);
                    const info = this.db!.prepare('DELETE FROM meetings WHERE id = ?').run(id);
                    if (info.changes > 0) count++;
                }
                return count;
            })();
            if (deleted > 0) console.log(`[DatabaseManager] Bulk-deleted ${deleted} meeting(s) (${cleanIds.length} requested)`);
            return deleted;
        } catch (error) {
            console.error('[DatabaseManager] Failed to bulk-delete meetings:', error);
            return 0;
        }
    }

    public clearAllData(): boolean {
        if (!this.db) return false;

        try {
            // Clear all tables atomically (order matters due to foreign keys,
            // but SQLite handles cascades). Using a transaction ensures we never
            // end up in a half-cleared state if one statement fails.
            this.db.transaction(() => {
                // F-705: vec0 virtual tables take no part in FK cascades, so a
                // full wipe has to clear them explicitly too — otherwise
                // "clear all data" left every embedding vector on disk.
                for (const dim of this.getExistingVecDims()) {
                    try { this.db!.exec(`DELETE FROM vec_chunks_${dim}`); } catch (_) { /* table may not exist */ }
                    try { this.db!.exec(`DELETE FROM vec_summaries_${dim}`); } catch (_) { /* table may not exist */ }
                }
                this.db!.exec('DELETE FROM embedding_queue');
                this.db!.exec('DELETE FROM chunk_summaries');
                this.db!.exec('DELETE FROM chunks');
                this.db!.exec('DELETE FROM ai_interactions');
                this.db!.exec('DELETE FROM transcripts');
                this.db!.exec('DELETE FROM meetings');
                this.db!.exec('DELETE FROM folders');
            })();

            console.log('[DatabaseManager] All data cleared from database.');
            return true;
        } catch (error) {
            console.error('[DatabaseManager] Failed to clear all data:', error);
            return false;
        }
    }

    public seedDemoMeeting() {
        if (!this.db) return;

        const demoId = 'demo-meeting';

        // If a demo meeting already exists, only re-seed when it's the older
        // legacy shape. A demo already carrying the V3 detailedSummary
        // (schemaVersion === 3) is left untouched so we don't clobber it on
        // every launch. Older legacy demos are deleted + re-seeded so users
        // pick up the richer V3 cards without a manual reset.
        const existing = this.db.prepare('SELECT summary_json FROM meetings WHERE id = ?').get(demoId) as { summary_json?: string } | undefined;
        if (existing) {
            let isV3Demo = false;
            try {
                const parsed = existing.summary_json ? JSON.parse(existing.summary_json) : null;
                isV3Demo = parsed?.detailedSummary?.schemaVersion === 3;
            } catch { /* corrupt row → treat as legacy, re-seed */ }
            if (isV3Demo) {
                console.log('[DatabaseManager] V3 demo meeting already exists, skipping seed.');
                return;
            }
            console.log('[DatabaseManager] Upgrading legacy demo meeting to V3.');
            this.deleteMeeting(demoId);
        }

        // Set date to today 9:30 AM
        const today = new Date();
        today.setHours(9, 30, 0, 0);

        const durationMs = 300000; // 5 min

        const summaryMarkdown = `# Overview

Natively is a real-time AI meeting assistant designed to help you stay focused, informed, and fast-moving during calls. Get live insights while you speak, instant answers to questions, and structured notes after every meeting.

# Getting Started

### Start a Session
Click **Start Session** from the dashboard.
Join a scheduled meeting and start directly from the meeting notification.

### During a Meeting
- Use the **five quick action buttons** for real-time assistance
- Show or hide Natively at any time:
  - **Mac**: Cmd + B
  - **Windows**: Ctrl + B
- Move the widget anywhere on your screen by hovering over the top pill and dragging

# Main Features

## Five Quick Action Buttons
- **What to answer**: Instantly generates a context-aware response to the current topic.
- **Clarify**: Asks a targeted, senior-level clarifying question to establish constraints.
- **Recap**: Generates a comprehensive summary of the conversation so far.
- **Follow Up Question**: Suggests strategic questions you can ask to drive the conversation.
- **Answer**: Manually trigger a response or use voice input to ask specific questions.

## Meeting Insights (Launcher)
- **Smart Note Taking**: Automatically captures key points, action items, and structured summaries.
- **Summary**: A concise high-level brief of the entire meeting.
- **Transcript**: Full real-time speech-to-text transcript, available during and after the call.
- **Usage**: Track your interaction history and see how Natively assisted you.

## Live Insights
Click **Live Insights** during a call to view:
- Real-time questions and prompts
- Detected keywords and topics
- Context-aware suggestions based on the conversation
- Click any insight to get an instant response.

## AI Chat
- Type your question and press **Enter** or click **Submit**
- Enable **Smart Mode** for advanced reasoning and coding assistance

## Screenshots
- **Full Screen Screenshot**: Cmd + H
- **Selective Screenshot**: Cmd + Shift + H

# Making the Most of Natively

### Custom Context
Upload resumes, project briefs, sales scripts, or other documents to tailor responses to your workflow. (coming soon).

### Language Preferences
Go to **Settings → Language Preferences** to:
- Change input and output language
- Enable real-time translation during calls

### Undetectability
Unlock the **Undetectability** add-on to keep Natively invisible during screen sharing.

# Interface Basics

- **Dashboard**: Start meetings and view recent activity
- **Start Session**: Begin a new meeting instantly
- **Settings**: Configure API keys, language, and visibility
- **History**: Review past meetings, notes, and transcripts

# API Setup

1. Open **Settings**
2. Scroll to **Credentials**
3. Add your API keys:
   - **Gemini**
   - **Groq**
4. To enable real-time transcription, select the location of your **Google Cloud service account JSON file**.

If you don’t already have one, follow the steps below to create it.

# Creating a Google Speech-to-Text Service Account

## 1. Create or Select a Project
- Open **Google Cloud Console**
- Create a new project or select an existing one
- Ensure billing is enabled

## 2. Enable Speech-to-Text API
- Go to **APIs & Services → Library**
- Enable **Speech-to-Text API**

## 3. Create a Service Account
- Navigate to **IAM & Admin → Service Accounts**
- Click **Create Service Account**
- **Name**: natively-stt
- **Description**: optional

## 4. Assign Permissions
- Grant the following role: **Speech-to-Text User** (\`roles/speech.client\`)

## 5. Create a JSON Key
- Open the service account
- Go to **Keys → Add Key → Create new key**
- Select **JSON**
- Download the file

**Once downloaded, return to Settings → Credentials in Natively and select this file to complete setup.**

# Free Google Cloud Credit (New Users)

New Google Cloud accounts receive **$300 in free credits**, valid for 90 days.

To activate:
1. Visit [cloud.google.com](https://cloud.google.com)
2. Click **Get started for free**
3. Sign in with a Google account
4. Add billing details (card required)
5. Activate the free trial

The credit can be used for Speech-to-Text and is sufficient for extended testing and regular usage.

# Support

If you need help with setup or usage, contact us anytime at:
natively.contact@gmail.com`;

        const demoMeeting: Meeting = {
            id: demoId,
            title: "Natively Demo & Guide",
            date: today.toISOString(),
            duration: "5:00",
            summary: "Complete guide to using Natively - your real-time AI meeting assistant.",
            detailedSummary: {
                // schemaVersion: 3 unlocks the full V3 notes layout + all four cards.
                schemaVersion: 3,
                overview: summaryMarkdown,
                actionItems: [],
                keyPoints: [],

                // Summary bullets (blue-dot list at the top of the notes).
                tldr: [
                    "Natively runs live during calls — real-time answers plus structured notes after.",
                    "Five quick actions: What to answer, Clarify, Recap, Follow-up, and Answer.",
                    "Cmd/Ctrl + B hides the widget instantly; screenshots via Cmd + H.",
                ],

                // The mode's note-section template — primary notes layout.
                sectionsV3: [
                    {
                        id: 'sec_getting_started',
                        title: 'Getting started',
                        order: 0,
                        bullets: [
                            { id: 'b1', text: "Click Start Session from the dashboard to begin a call.", confidence: 'high' },
                            { id: 'b2', text: "Show or hide Natively anytime with Cmd + B (Mac) or Ctrl + B (Windows).", confidence: 'high' },
                        ],
                    },
                    {
                        id: 'sec_features',
                        title: 'Key features',
                        order: 1,
                        bullets: [
                            { id: 'b3', text: "Five quick-action buttons give real-time, context-aware assistance.", confidence: 'high' },
                            { id: 'b4', text: "Smart note-taking captures key points, action items, and a structured summary.", confidence: 'medium' },
                        ],
                    },
                    {
                        id: 'sec_setup',
                        title: 'Setup',
                        order: 2,
                        bullets: [
                            { id: 'b5', text: "Add Gemini and Groq API keys under Settings → Credentials.", confidence: 'high' },
                            { id: 'b6', text: "Select a Google Cloud service-account JSON to enable live transcription.", confidence: 'medium' },
                        ],
                    },
                ],

                // CARD 1 — source quality warning (non-benign warnings render).
                sourceQuality: {
                    transcriptCoverage: 0.82,
                    speakerQuality: 'mixed' as const,
                    actionItemConfidence: 'medium' as const,
                    warnings: [
                        "Speaker labels are low quality; verify owners and quotes before sharing.",
                    ],
                },

                // CARD 2 — mode auto-detect suggestion (detected differs from selected, conf ≥ 0.5).
                mode: {
                    selectedModeId: 'mode_general_default',
                    selectedModeName: 'General',
                    selectedTemplateType: 'general',
                    detectedModeId: 'mode_product_demo',
                    detectedModeName: 'Product Demo',
                    detectedConfidence: 0.78,
                    summaryModeUsed: 'general',
                },

                // CARD 3 — cross-meeting recall (stillOpen non-empty).
                crossMeeting: {
                    stillOpen: [
                        "Finish uploading your resume / project brief for tailored answers (from Onboarding).",
                        "Enable Undetectability before your next screen-shared call (from Setup walkthrough).",
                    ],
                },

                // Follow-up draft — exercises the copy / regenerate / tone dropdown row.
                followUpDraft: {
                    type: 'email',
                    subject: "Getting started with Natively",
                    body: "Hi there,\n\nThanks for trying Natively! A quick recap: start a session from the dashboard, use the five quick actions during your call, and press Cmd + B to hide the widget anytime. Notes, transcript, and follow-ups are waiting for you after every meeting.\n\nBest,\nThe Natively team",
                    tone: 'professional',
                },
            },
            transcript: [
                { speaker: 'interviewer', text: "Welcome to Natively! Let me show you how it works.", timestamp: 0 },
                { speaker: 'user', text: "Thanks! I'm excited to try it out.", timestamp: 5000 },
                { speaker: 'interviewer', text: "You have 5 quick action buttons. 'What to answer' listens to the conversation and suggests what you should say.", timestamp: 10000 },
                { speaker: 'user', text: "That sounds helpful for interviews.", timestamp: 18000 },
                { speaker: 'interviewer', text: "Check out the 'How to Use' section in the notes for API setup instructions.", timestamp: 20000 },
                { speaker: 'interviewer', text: "'Clarify' asks a targeted question to get missing constraints. 'Recap' summarizes the entire conversation so far.", timestamp: 22000 },
                { speaker: 'user', text: "What about the other buttons?", timestamp: 30000 },
                { speaker: 'interviewer', text: "'Follow Up Questions' suggests questions you can ask. 'Answer' lets you speak a question and get an instant response.", timestamp: 35000 },
                { speaker: 'user', text: "Can I take screenshots during calls?", timestamp: 45000 },
                { speaker: 'interviewer', text: "Yes! Press Cmd+H for full screen or Cmd+Shift+H to select an area. The AI will analyze it and help you.", timestamp: 50000 },
                { speaker: 'user', text: "How do I hide Natively during screen share?", timestamp: 60000 },
                { speaker: 'interviewer', text: "Press Cmd+B to toggle visibility anytime. You can also enable undetectable mode in settings.", timestamp: 65000 },
                { speaker: 'user', text: "This is amazing. What happens after the call?", timestamp: 75000 },
                { speaker: 'interviewer', text: "You get detailed meeting notes with action items, key points, full transcript, and a log of all AI interactions.", timestamp: 80000 }
            ],
            usage: [
                { type: 'assist', timestamp: 15000, question: 'What features does Natively have?', answer: 'Natively offers 5 quick action buttons, screenshot analysis, real-time transcription, and comprehensive meeting notes.' },
                { type: 'followup', timestamp: 40000, question: 'How do the action buttons work?', answer: 'Each button serves a specific purpose: suggest answers, clarify questions, recap conversations, generate follow-up questions, or get instant voice-to-answer responses.' }
            ],
            isProcessed: true
        };

        this.saveMeeting(demoMeeting, today.getTime(), durationMs);
        console.log('[DatabaseManager] Seeded demo meeting.');
    }
}

