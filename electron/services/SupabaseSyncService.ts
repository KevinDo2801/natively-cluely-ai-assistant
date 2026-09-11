/**
 * SupabaseSyncService — cloud-first sync between the local SQLite database and
 * the Supabase project for the signed-in user.
 *
 * Design notes (v4 — incremental, skew-proof):
 *   - Every reconcile is INCREMENTAL. Each table carries a `sync_watermarks`
 *     row (local migrations v35 + v36) holding the newest local and cloud marks
 *     it has already reconciled; the engine reads only the cloud rows and
 *     tombstones after the cloud watermark, considers only the keys that changed
 *     on either side plus any key the retry ledger re-offers, and writes only
 *     those. A steady-state pass therefore costs two small filtered reads per
 *     table and zero writes.
 *   - The cloud watermark is preferably a server-assigned monotonic SEQUENCE
 *     (`sync_seq`, cloud migration 0005), which is exact and cannot be delayed by
 *     a machine's clock. A timestamp watermark (`updated_at`) is the fallback for
 *     a project without 0005 and for a table that has not yet produced a
 *     sequence; it is only as good as the clocks that feed it.
 *   - A row whose push fails is recorded in `sync_retry` and re-offered on an
 *     exponential backoff instead of holding the watermark back — one unpushable
 *     row used to pin the watermark and degrade every later pass into a wide
 *     scan, i.e. straight back into the egress problem. Nothing is ever silently
 *     dropped.
 *   - Why this exists: the previous engine read EVERY row of EVERY table on
 *     every pass. Measured on this repo's dev database that was 2.35 MB of rows
 *     plus 3.44 MB of tombstones per pass — ~5.8 MB per minute, ~8 GB/day while
 *     signed in, with a SINGLE user, which exceeded the Supabase free-plan
 *     egress quota. Egress scaled with database size, never with user count.
 *   - Incremental reads are an optimisation, not the correctness argument: the
 *     engine still reads a table whole on its first pass and once every
 *     FULL_RESCAN_INTERVAL_MS (12h), so a watermark that skipped a row heals.
 *
 * Design notes (v3 — Supabase is the source of truth):
 *   - While signed in, the cloud is authoritative. Every local write to a
 *     synced table is detected by SQLite triggers (v34 — a per-table monotonic
 *     `sync_dirty` seq) and pushed to Supabase by the dirty-poll loop within
 *     ~DIRTY_POLL_MS (write-through). The local SQLite rows are a cache mirror
 *     that reads stay fast on; a periodic reconcile every PULL_INTERVAL_MS
 *     brings down changes made on other devices. When Realtime is enabled, a
 *     postgres_changes subscription also reconciles a table within
 *     ~REALTIME_DEBOUNCE_MS of another device changing it, and the periodic
 *     reconcile remains as the safety net for events missed while the socket
 *     was down.
 *   - There is no offline mode: when the cloud is unreachable, pushes keep
 *     retrying (the dirty flags survive restarts, and the local mirror keeps
 *     the app usable), and the UI shows the last error. The cloud wins on the
 *     next convergence, so nothing local can permanently fork the truth.
 *   - First sign-in after this architecture runs a one-time cutover: a safety
 *     merge (any rows created while signed out are pushed first so the wipe
 *     cannot lose data), then the local business tables are wiped with their
 *     triggers suspended (the wipe must not fake a mass deletion to the
 *     cloud), then everything is re-pulled from Supabase. After that the
 *     local cache and the cloud are identical, and only then does write-
 *     through take over. A marker in app_state makes the cutover run once.
 *   - Signed out, the app keeps working on local data exactly as before;
 *     the next sign-in merges it up through the regular LWW reconciliation.
 *   - The client uses the ANON key + the signed-in user's JWT (RLS enforces
 *     that only this user's rows can be read or written). No service_role key
 *     ever ships in the app.
 *
 * EventEmitter signals (rebroadcast over IPC by ipcHandlers.ts):
 *   'status' — fires on every state change with the SupabaseSyncStatus.
 */

import { EventEmitter } from 'events';
import {
    createClient,
    type SupabaseClient,
    type RealtimeChannel,
    type RealtimePostgresChangesPayload,
} from '@supabase/supabase-js';
import {
    syncAll,
    readDirtyTables,
    clearDirtyTableUpTo,
    clearAllDirty,
    wipeSyncedTables,
    TABLE_DEFS,
    type SyncSummary,
} from './supabaseSyncEngine.js';
import { getSupabaseAnonKey, getSupabaseUrl } from './supabaseConfig';

export type SupabaseSyncState = 'idle' | 'syncing' | 'ok' | 'error';

export interface SupabaseSyncStatus {
    state: SupabaseSyncState;
    /** Extra context for the renderer: 'cutover' while the one-time cloud-first setup runs. */
    phase?: 'cutover';
    /** Epoch ms of the last fully successful reconciliation. */
    lastSyncedAt?: number;
    /** Movement from the last reconciliation that changed something. */
    lastCounts?: { rows: number; pushed: number; pulled: number; deleted: number; failed: number };
    /** Error message from the last failed sync. */
    lastError?: string;
    /**
     * Measured local-clock offset against Supabase, in ms (positive = this
     * machine is ahead), when the probe could reach the server. Surfaced so a
     * skewed clock is visible in the UI and not only in the logs — a device whose
     * clock is far ahead wins every last-write-wins conflict it takes part in.
     */
    clockSkewMs?: number;
}

/** How often the cloud is pulled for changes from other devices while signed in. */
const PULL_INTERVAL_MS = Number(process.env.SUPABASE_SYNC_PULL_MS) || 60_000;
/** How often the local dirty flags are polled for write-through pushes. */
const DIRTY_POLL_MS = Number(process.env.SUPABASE_SYNC_DIRTY_POLL_MS) || 1_000;
/** app_state marker: set once the one-time cloud-first cutover has completed. */
const CUTOVER_APP_STATE_KEY = 'supabase_cloud_first_cutover_done';

/**
 * Upper bound for ONE full reconciliation. Supabase's edge can black-hole
 * requests (observed during outages); without a cap, a flaky network makes a
 * full sync (20 tables, each request bounded to 30s) take many minutes — and
 * the UI sits in "syncing" that whole time while write-through is blocked.
 * With this cap, a slow sync is aborted after SYNC_MAX_DURATION_MS and
 * reported as an error (retried on the next cycle) instead of spinning.
 */
const SYNC_MAX_DURATION_MS = Number(process.env.SUPABASE_SYNC_MAX_MS) || 60_000;

/**
 * Realtime change-stream (fast cross-device path). When enabled, the app
 * subscribes to Supabase postgres_changes and reconciles a table as soon as
 * another device changes it — no waiting for the 60s full reconcile. The full
 * reconcile stays as the safety net (Realtime does not replay events missed
 * while the socket is down). Default ON; set SUPABASE_REALTIME_ENABLED=0 to
 * fall back to polling only (graceful — a dead socket is never fatal).
 */
const REALTIME_ENABLED = (process.env.SUPABASE_REALTIME_ENABLED ?? '1').trim() !== '0';
/**
 * Clock-skew warning threshold. Propagation no longer depends on clocks (the
 * delta is a server-assigned sequence), but CONFLICT RESOLUTION still does:
 * `updated_at` is the last-write-wins key, and it is stamped by whichever machine
 * made the edit. A device whose clock is far ahead therefore wins every conflict
 * it takes part in until the clock is corrected — the one failure mode in this
 * design that a device can inflict on itself, and the only one that is invisible
 * from the sync logs.
 *
 * It cannot be removed without changing what "newer" means, and every candidate
 * for that change trades this risk for a worse one (see the note in
 * supabaseSyncEngine.js on why clamping a future-dated write is not viable). What
 * IS achievable — and what this probe does — is making it impossible to miss:
 * one cheap request per session compares the two clocks and says so loudly.
 */
const CLOCK_SKEW_WARN_MS = Number(process.env.SUPABASE_SYNC_CLOCK_SKEW_WARN_MS) || 5 * 60 * 1000;
const CLOCK_SKEW_PROBE_TIMEOUT_MS = 10_000;

/** Coalesce a burst of realtime events on one table into a single targeted sync. */
const REALTIME_DEBOUNCE_MS = Number(process.env.SUPABASE_REALTIME_DEBOUNCE_MS) || 2_500;

/**
 * Self-echo window. Supabase postgres_changes broadcasts EVERY committed change
 * matching the subscription, including the ones this client just pushed, and
 * offers no server-side "don't echo to the writer" filter. Without this, every
 * write-through push came straight back as an event and triggered another pass
 * over the same table — roughly doubling the sync work for our own writes.
 *
 * A table that received a successful push is therefore ignored by the realtime
 * path for this long. A change made by ANOTHER device inside the window is not
 * lost, only deferred to the next reconcile (60s poll, or the next realtime
 * event after the window), so the window must stay far below the poll interval.
 */
const REALTIME_SELF_ECHO_MS = Number(process.env.SUPABASE_REALTIME_SELF_ECHO_MS) || 5_000;

/** Table names mirrored to Supabase (the set the realtime stream filters on). */
const SYNC_TABLE_NAMES = new Set<string>(TABLE_DEFS.map((d) => d.table));

/**
 * Upper bound for auth-host network calls (session restore/refresh). Supabase's
 * /auth/v1 host can hang indefinitely while /rest/v1 stays healthy; without a
 * bound, a hung setSession/refreshSession freezes the sync loop forever.
 * PostgREST traffic keeps the default fetch — large upsert batches must not
 * be killed by a 15s wall-clock cap.
 */
const AUTH_REQUEST_TIMEOUT_MS = 15_000;

/** fetch wrapper used for auth requests only (PostgREST keeps the default). */
function authBoundedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('/auth/v1/')) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), AUTH_REQUEST_TIMEOUT_MS);
        return fetch(input, { ...(init || {}), signal: controller.signal }).finally(() =>
            clearTimeout(timer),
        );
    }
    return fetch(input, init);
}

interface DirtySnapshot {
    tables: string[];
    seqs: Map<string, number>;
}

export class SupabaseSyncService extends EventEmitter {
    private static instance: SupabaseSyncService;

    private client: SupabaseClient | null = null;
    private timer: NodeJS.Timeout | null = null;
    private dirtyTimer: NodeJS.Timeout | null = null;
    private started = false;
    private running = false;
    private status: SupabaseSyncStatus = { state: 'idle' };

    // Realtime change-stream state.
    private realtimeChannel: RealtimeChannel | null = null;
    private realtimeToken: string | null = null;
    private realtimeHadSubscribed = false;
    private realtimePending = new Map<string, NodeJS.Timeout>();
    /** Per table, epoch ms of the last pass that pushed rows to the cloud. */
    private lastPushAt = new Map<string, number>();
    /** Measured local-clock offset vs Supabase in ms; null until probed. */
    private clockSkewMs: number | null = null;
    /** False until one pass has completed; the first gets an upgrade-sized budget. */
    private hasCompletedSync = false;

    private constructor() {
        super();
    }

    public static getInstance(): SupabaseSyncService {
        if (!SupabaseSyncService.instance) {
            SupabaseSyncService.instance = new SupabaseSyncService();
        }
        return SupabaseSyncService.instance;
    }

    /** For tests: reset in-memory state without touching the database. */
    public __resetForTest(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        if (this.dirtyTimer) {
            clearInterval(this.dirtyTimer);
            this.dirtyTimer = null;
        }
        this.teardownRealtime();
        this.client = null;
        this.started = false;
        this.running = false;
        this.status = { state: 'idle' };
        this.lastPushAt.clear();
        this.clockSkewMs = null;
    }

    // ---------------------------------------------------------------------------
    // Client construction (lazy)
    // ---------------------------------------------------------------------------

    private getUrl(): string | undefined {
        return getSupabaseUrl();
    }

    private getAnonKey(): string | undefined {
        return getSupabaseAnonKey();
    }

    private ensureClient(): SupabaseClient {
        if (this.client) return this.client;
        const url = this.getUrl();
        const key = this.getAnonKey();
        if (!url || !key) {
            throw new Error(
                'Supabase is not configured. Set SUPABASE_URL and SUPABASE_ANON_KEY ' +
                    '(in .env for dev builds, or on the build machine for packaged builds).',
            );
        }
        this.client = createClient(url, key, {
            global: { fetch: authBoundedFetch },
            auth: {
                persistSession: false,
                autoRefreshToken: false,
                detectSessionInUrl: false,
            },
        });
        return this.client;
    }

    // ---------------------------------------------------------------------------
    // Realtime change-stream (targeted pull on other-device writes)
    // ---------------------------------------------------------------------------

    /**
     * Subscribe (or re-subscribe after a token change) to Supabase
     * postgres_changes for the synced tables. Fire-and-forget: the socket
     * connects in the background, and the 60s reconcile stays as the safety net
     * if it never comes up. Idempotent for the same access token.
     */
    private ensureRealtime(client: SupabaseClient, accessToken: string): void {
        if (!REALTIME_ENABLED) return;
        if (this.realtimeChannel && this.realtimeToken === accessToken) return; // already up

        this.teardownRealtime();
        this.realtimeToken = accessToken;
        this.realtimeHadSubscribed = false;

        try {
            // Pin the signed-in JWT so RLS filters the event stream to this user.
            // (supabase-js keeps the callback as the source of truth on heartbeat,
            // so this only bootstraps the first join — see realtime-js setAuth.)
            void client.realtime.setAuth(accessToken);

            const channel = client
                .channel('natively-sync')
                .on(
                    'postgres_changes',
                    { event: '*', schema: 'public' },
                    (payload: RealtimePostgresChangesPayload<Record<string, unknown>>) => {
                        const table = payload.table;
                        if (table && SYNC_TABLE_NAMES.has(table)) {
                            this.handleRealtimeEvent(table);
                        }
                    },
                )
                .subscribe((status) => {
                    if (status === 'SUBSCRIBED') {
                        if (this.realtimeHadSubscribed) {
                            // Reconnected after a drop: Realtime does not replay
                            // missed events, so reconcile now to catch up.
                            console.log('[SupabaseSyncService] realtime reconnected — reconciling to catch up');
                            void this.syncNow();
                        } else {
                            this.realtimeHadSubscribed = true;
                            console.log('[SupabaseSyncService] realtime subscribed');
                        }
                    } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
                        console.warn('[SupabaseSyncService] realtime channel', status);
                    }
                });

            this.realtimeChannel = channel;
        } catch (e) {
            console.warn(
                '[SupabaseSyncService] realtime setup failed (polling still runs):',
                (e as Error)?.message || e,
            );
            this.teardownRealtime();
        }
    }

    private teardownRealtime(): void {
        if (this.realtimeChannel && this.client) {
            try {
                void this.client.removeChannel(this.realtimeChannel);
            } catch {
                /* ignore */
            }
        }
        this.realtimeChannel = null;
        this.realtimeToken = null;
        this.realtimeHadSubscribed = false;
        for (const timer of this.realtimePending.values()) clearTimeout(timer);
        this.realtimePending.clear();
    }

    /** Coalesce a burst of events for one table into a single targeted sync. */
    private handleRealtimeEvent(table: string): void {
        // Ignore the echo of our own push (see REALTIME_SELF_ECHO_MS). The
        // pending debounce is dropped too, so a burst that started before the
        // push does not fire a pass over a table we just finished writing.
        const pushedAt = this.lastPushAt.get(table) || 0;
        if (Date.now() - pushedAt < REALTIME_SELF_ECHO_MS) {
            const queued = this.realtimePending.get(table);
            if (queued) {
                clearTimeout(queued);
                this.realtimePending.delete(table);
            }
            return;
        }
        const existing = this.realtimePending.get(table);
        if (existing) clearTimeout(existing);
        this.realtimePending.set(
            table,
            setTimeout(() => {
                this.realtimePending.delete(table);
                void this.runSync({ silent: true, tables: [table] });
            }, REALTIME_DEBOUNCE_MS),
        );
    }

    // ---------------------------------------------------------------------------
    // Status + lifecycle
    // ---------------------------------------------------------------------------

    private setStatus(status: SupabaseSyncStatus): void {
        this.status = status;
        try {
            this.emit('status', this.status);
        } catch {
            /* listener errors must not break the sync */
        }
    }

    /** Synchronous status read. Safe to call from IPC without a network round-trip. */
    public getStatus(): SupabaseSyncStatus {
        return this.clockSkewMs === null
            ? { ...this.status }
            : { ...this.status, clockSkewMs: this.clockSkewMs };
    }

    /**
     * Compare this machine's clock with Supabase's, once per session.
     *
     * Nothing about PROPAGATION depends on this any more (the cloud delta is a
     * server-assigned sequence), but CONFLICT RESOLUTION still does: `updated_at`
     * is the last-write-wins key and it is stamped by whichever machine made the
     * edit, so a device whose clock runs far ahead wins every conflict it takes
     * part in. That is the last failure mode in this design that a device can
     * inflict on itself, and the only one no sync log would ever show.
     *
     * Removed properly it cannot be — that means changing what "newer" means, and
     * every candidate for that trades this risk for a worse one. Made IMPOSSIBLE
     * TO MISS it can be, and that is what this does: one cheap request per
     * session, and a loud warning when the gap is wide enough to matter.
     *
     * Diagnostic only: any failure is swallowed and never touches sync.
     */
    private async probeClockSkew(): Promise<void> {
        const url = this.getUrl();
        const anonKey = this.getAnonKey();
        if (!url || !anonKey) return;
        try {
            // The auth health endpoint is the cheapest responder on the project
            // that still returns a dated HTTP response.
            const res = await fetch(`${url.replace(/\/+$/, '')}/auth/v1/health`, {
                headers: { apikey: anonKey },
                signal: AbortSignal.timeout(CLOCK_SKEW_PROBE_TIMEOUT_MS),
            });
            const header = res.headers.get('date');
            if (!header) return;
            const serverMs = Date.parse(header);
            if (!Number.isFinite(serverMs)) return;
            // HTTP dates have 1-second resolution — irrelevant against a 5-minute
            // threshold.
            const skewMs = Date.now() - serverMs;
            this.clockSkewMs = skewMs;
            if (Math.abs(skewMs) > CLOCK_SKEW_WARN_MS) {
                const direction = skewMs > 0 ? 'AHEAD of' : 'BEHIND';
                console.warn(
                    `[SupabaseSyncService] SYSTEM CLOCK IS ${Math.round(Math.abs(skewMs) / 1000)}s ${direction} SUPABASE. ` +
                    'Conflict resolution is last-write-wins on row timestamps, so this machine ' +
                    (skewMs > 0
                        ? 'will WIN every conflicting edit from another device until the clock is corrected.'
                        : 'will LOSE every conflicting edit from another device until the clock is corrected.') +
                    ' Sync the system clock (Windows: Settings > Time & language > Date & time > Sync now).',
                );
            } else {
                console.log(`[SupabaseSyncService] clock skew vs Supabase: ${Math.round(skewMs / 1000)}s`);
            }
        } catch (e) {
            // Never fatal, never cached as a result — the next session retries.
            console.warn('[SupabaseSyncService] clock-skew probe skipped:', (e as Error)?.message || e);
        }
    }

    /**
     * Start cloud-first sync while signed in. Idempotent: a second call while
     * running is a no-op. Kicks off an immediate full reconcile (which runs the
     * one-time cutover on the very first sign-in), then:
     *   - polls the dirty flags every DIRTY_POLL_MS so local writes are pushed
     *     to the cloud within roughly one tick (write-through), and
     *   - fully reconciles every PULL_INTERVAL_MS so changes from other
     *     devices flow down and any failed push is retried.
     */
    public start(): void {
        if (this.started) return;
        this.started = true;
        if (this.timer) clearInterval(this.timer);
        if (this.dirtyTimer) clearInterval(this.dirtyTimer);
        this.timer = setInterval(() => {
            void this.syncNow();
        }, PULL_INTERVAL_MS);
        this.dirtyTimer = setInterval(() => {
            void this.syncDirtyNow();
        }, DIRTY_POLL_MS);
        void this.probeClockSkew();
        void this.syncNow();
    }

    /** Stop the loops (e.g. on sign-out). Local writes simply accumulate dirty flags. */
    public stop(): void {
        this.started = false;
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        if (this.dirtyTimer) {
            clearInterval(this.dirtyTimer);
            this.dirtyTimer = null;
        }
        this.lastPushAt.clear();
        this.teardownRealtime();
    }

    // ---------------------------------------------------------------------------
    // Dirty tracking (SQLite triggers → write-through loop)
    // ---------------------------------------------------------------------------

    private getDirtySnapshot(): DirtySnapshot {
        try {
            const { DatabaseManager } = require('../db/DatabaseManager');
            const db = DatabaseManager.getInstance().getDb();
            if (!db) return { tables: [], seqs: new Map() };
            const rows = readDirtyTables(db) as Array<{ table_name: string; seq: number }>;
            return {
                tables: rows.map((r) => r.table_name),
                seqs: new Map(rows.map((r) => [r.table_name, Number(r.seq)])),
            };
        } catch {
            return { tables: [], seqs: new Map() };
        }
    }

    /**
     * Write-through pass: reconcile only the tables dirtied by local writes
     * (plus their FK ancestors). Silent — no 'syncing' flicker in the UI every
     * second; the status only updates when something moved or an error needs
     * surfacing.
     */
    public async syncDirtyNow(): Promise<SupabaseSyncStatus> {
        if (this.running) return this.getStatus();
        const dirty = this.getDirtySnapshot();
        if (!dirty.tables.length) return this.getStatus();
        return this.runSync({ silent: true, tables: dirty.tables, seqs: dirty.seqs });
    }

    // ---------------------------------------------------------------------------
    // Sync
    // ---------------------------------------------------------------------------

    /**
     * Full, user-visible reconcile (two-way, last-write-wins), including the
     * one-time cloud-first cutover on first sign-in. Re-entrant: a concurrent
     * call returns the in-flight status.
     */
    public async syncNow(): Promise<SupabaseSyncStatus> {
        if (this.running) return this.getStatus();
        // Capture the dirty state up-front so this pass can clear exactly the
        // flags it covers (writes that land mid-sync keep the table dirty).
        const dirty = this.getDirtySnapshot();
        return this.runSync({ silent: false, seqs: dirty.seqs });
    }

    private async runSync(opts: {
        silent: boolean;
        tables?: string[];
        seqs?: Map<string, number>;
    }): Promise<SupabaseSyncStatus> {
        if (this.running) return this.getStatus();
        this.running = true;
        if (!opts.silent) {
            const previous = this.status;
            this.setStatus({ ...previous, state: 'syncing' });
        }
        try {
            // Lazy requires so test harnesses don't pull the full Electron app in.
            const { SupabaseAuthService } = require('./SupabaseAuthService');
            const auth = SupabaseAuthService.getInstance();
            const session = await auth.ensureFreshSession();
            if (!session?.user) {
                // Signed out (or the session could not be refreshed): nothing to sync.
                this.setStatus({ state: 'idle' });
                return this.getStatus();
            }

            const client = this.ensureClient();

            // Only re-hydrate the sync client when its token actually changed.
            // setSession re-fetches the user over /auth/v1 (which can hang up to
            // the auth bound), so calling it on every write-through / realtime
            // pass would multiply those calls for no benefit once the token is
            // already current. The very first sync still hydrates it.
            const { data: currentSession } = await client.auth.getSession();
            if (currentSession.session?.access_token !== session.access_token) {
                await client.auth.setSession({
                    access_token: session.access_token,
                    refresh_token: session.refresh_token,
                });
            }

            // Keep the realtime change-stream aligned with the current session
            // (no-op when the channel is already subscribed with this token).
            this.ensureRealtime(client, session.access_token);

            const { DatabaseManager } = require('../db/DatabaseManager');
            const dm = DatabaseManager.getInstance();
            const db = dm.getDb();
            if (!db) {
                throw new Error('Local database is not available.');
            }

            let summary: SyncSummary;
            // The first pass after start is also the one that pays for an upgrade:
            // any table without a watermark yet is read WHOLE, which for this
            // database is ~5.8 MB and took just over the routine 60s cap — so the
            // tail tables were skipped and the pass was reported as "N table(s)
            // errored". That is a false alarm on every upgrade, and it leaves the
            // skipped tables' watermarks unset for another round. Give the first
            // pass the same generous-but-still-bounded budget the cutover uses.
            const budget = this.hasCompletedSync ? SYNC_MAX_DURATION_MS : SYNC_MAX_DURATION_MS * 3;
            const deadline = Date.now() + budget;
            // Per-table failures and deadline skips are otherwise invisible: the
            // summary only carries a count, and an operator reading the log needs
            // to know WHICH table and WHY.
            const onProgress = (event: { table: string; phase: string; error?: string }) => {
                if (event.phase === 'error') {
                    console.warn(`[SupabaseSyncService] ${event.table}: ${event.error}`);
                }
            };
            if (opts.tables) {
                // Write-through pass: only the dirtied tables (+ FK ancestors).
                summary = await syncAll({ db, client, userId: session.user.id, tables: opts.tables, deadline, onProgress });
            } else {
                // One-time cutover: make Supabase the truth, rebuild the local cache.
                if (dm.getAppState(CUTOVER_APP_STATE_KEY) !== '1') {
                    await this.runCutover(db, client, dm, session.user.id);
                }
                summary = await syncAll({ db, client, userId: session.user.id, deadline, onProgress });
            }

            if (summary.totalFailed > 0 || summary.totalTableErrors > 0) {
                throw new Error(
                    `${summary.totalFailed} row(s) failed, ${summary.totalTableErrors} table(s) errored during sync.`,
                );
            }

            // Remember which tables this pass wrote to, so the realtime echo of
            // our own push does not immediately trigger another pass over the
            // same table (Supabase postgres_changes has no writer exclusion).
            this.hasCompletedSync = true;
            const nowMs = Date.now();
            for (const t of summary.tables) {
                if (t.pushed > 0 || t.deletedCloud > 0 || t.tombstonesPushed > 0) {
                    this.lastPushAt.set(t.table, nowMs);
                }
            }

            // The tables this pass covered are clean now — unless a write
            // bumped their seq again while we were syncing.
            if (opts.seqs) {
                for (const [table, seq] of opts.seqs) {
                    clearDirtyTableUpTo(db, table, seq);
                }
            }

            const counts = {
                rows: summary.totalRows,
                pushed: summary.totalPushed,
                pulled: summary.totalPulled,
                deleted: summary.totalDeleted,
                failed: summary.totalFailed,
            };
            const moved = counts.pushed + counts.pulled + counts.deleted > 0;
            if (!opts.silent || moved) {
                this.setStatus({
                    state: 'ok',
                    lastSyncedAt: Date.now(),
                    lastCounts: counts,
                });
                console.log(
                    `[SupabaseSyncService] ${opts.silent ? 'write-through' : 'sync'} ok: ` +
                    `↑${counts.pushed} ↓${counts.pulled} ✕${counts.deleted} for ${session.user.email || session.user.id}` +
                    // `candidates` is the incremental engine's cost signal: keys it
                    // actually had to consider. A steady-state reconcile reports 0
                    // (no rows downloaded), which is the quickest way to confirm
                    // from the log that a pass is not reading the database again.
                    ` [${summary.incremental ? 'incremental' : 'full'}, ${summary.totalCandidates} candidate(s)` +
                    // Outstanding rows whose push failed and are waiting out their
                    // backoff. The watermark is not held back for them any more, so
                    // this is the only place a stuck row is visible.
                    (summary.totalRetrying ? `, ${summary.totalRetrying} retrying` : '') +
                    // Only shown when a table WITH ROWS was read whole — empty
                    // tables are read unfiltered by design (they have no sequence
                    // to learn) and cost one empty request each.
                    (summary.incremental ? '' : `, ${summary.fullRescans} full rescan(s)`) + ']' +
                    (opts.tables ? ` (${opts.tables.join(', ')})` : ''),
                );
            }
        } catch (e) {
            console.error('[SupabaseSyncService] sync failed:', (e as Error)?.message || e);
            this.setStatus({
                state: 'error',
                lastSyncedAt: this.status.lastSyncedAt,
                lastCounts: this.status.lastCounts,
                lastError: (e as Error)?.message || String(e),
            });
        } finally {
            this.running = false;
        }
        return this.getStatus();
    }

    /**
     * One-time cloud-first cutover (runs inside the first full sync after
     * sign-in):
     *   1. Safety merge — push anything local (including rows created while
     *      signed out) so the wipe below cannot lose data.
     *   2. Wipe the local business tables + all change tracking, with the
     *      triggers suspended so the wipe records no tombstones (a plain
     *      DELETE would propagate as "delete everything" to the cloud).
     *   3. Blind pull — rebuild the local cache from Supabase verbatim.
     *   4. Mark the cutover done so it never runs again.
     */
    private async runCutover(
        db: any,
        client: SupabaseClient,
        dm: any,
        userId: string,
    ): Promise<void> {
        const previous = this.status;
        this.setStatus({ ...previous, state: 'syncing', phase: 'cutover' });
        console.log('[SupabaseSyncService] cloud-first cutover: merging local, then rebuilding the cache from Supabase…');

        // The cutover is a one-time bulk rebuild, so it gets a more generous
        // deadline than a routine reconcile — but still bounded so a black-holed
        // edge cannot leave it running forever. On failure it aborts cleanly and
        // retries on the next sign-in (local data stays intact).
        const cutoverDeadline = Date.now() + SYNC_MAX_DURATION_MS * 3;
        const safety = await syncAll({ db, client, userId, direction: 'both', deadline: cutoverDeadline });
        if (safety.totalFailed > 0 || safety.totalTableErrors > 0) {
            throw new Error(
                `cutover pre-sync failed: ${safety.totalFailed} row(s), ${safety.totalTableErrors} table(s) — local data left untouched`,
            );
        }

        wipeSyncedTables(db);
        clearAllDirty(db);

        const pull = await syncAll({ db, client, userId, direction: 'pull', deadline: cutoverDeadline });
        if (pull.totalFailed > 0 || pull.totalTableErrors > 0) {
            throw new Error(`cutover pull failed: ${pull.totalFailed} row(s), ${pull.totalTableErrors} table(s)`);
        }
        clearAllDirty(db);

        dm.setAppState(CUTOVER_APP_STATE_KEY, '1');
        console.log('[SupabaseSyncService] cloud-first cutover complete — Supabase is now the source of truth');
    }
}
