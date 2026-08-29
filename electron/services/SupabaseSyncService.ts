/**
 * SupabaseSyncService — pushes the local SQLite data to the Supabase project
 * for the signed-in user, keeping the cloud copy fresh while the app runs.
 *
 * Design notes:
 *   - Runs in the MAIN process (like SupabaseAuthService). The supabase-js
 *     client is created with the ANON key; before every push the signed-in
 *     user's session is applied to it (setSession), so PostgREST carries the
 *     user's own JWT and Supabase RLS enforces that only this user's rows can
 *     be written. No service_role key ever ships in the app.
 *   - The sync engine itself is shared with the one-shot CLI script
 *     (scripts/supabase/sync-local-to-supabase.cjs) via
 *     supabaseSyncEngine.js — full upserts, idempotent, parent tables first.
 *   - v1 schedule: one immediate push on start, then a full upsert every
 *     SYNC_INTERVAL_MS while signed in. Data volumes are small (hundreds of
 *     rows), so full-upsert polling is cheap; row-level change capture can
 *     replace it later.
 *   - Deletions are not propagated (push-only, documented in the engine).
 *
 * EventEmitter signals (rebroadcast over IPC by ipcHandlers.ts):
 *   'status' — fires on every state change with the SupabaseSyncStatus.
 */

import { EventEmitter } from 'events';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { syncAll, type SyncSummary } from './supabaseSyncEngine.js';

export type SupabaseSyncState = 'idle' | 'syncing' | 'ok' | 'error';

export interface SupabaseSyncStatus {
  state: SupabaseSyncState;
  /** Epoch ms of the last fully successful push. */
  lastSyncedAt?: number;
  /** Row counts from the last fully successful push. */
  lastCounts?: { rows: number; upserted: number; failed: number };
  /** Error message from the last failed push. */
  lastError?: string;
}

const SYNC_INTERVAL_MS = 5 * 60 * 1000;

export class SupabaseSyncService extends EventEmitter {
  private static instance: SupabaseSyncService;

  private client: SupabaseClient | null = null;
  private timer: NodeJS.Timeout | null = null;
  private started = false;
  private running = false;
  private status: SupabaseSyncStatus = { state: 'idle' };

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
    this.client = null;
    this.started = false;
    this.running = false;
    this.status = { state: 'idle' };
  }

  // ---------------------------------------------------------------------------
  // Client construction (lazy)
  // ---------------------------------------------------------------------------

  private getUrl(): string | undefined {
    return process.env.SUPABASE_URL || undefined;
  }

  private getAnonKey(): string | undefined {
    return process.env.SUPABASE_ANON_KEY || undefined;
  }

  private ensureClient(): SupabaseClient {
    if (this.client) return this.client;
    const url = this.getUrl();
    const key = this.getAnonKey();
    if (!url || !key) {
      throw new Error(
        'Supabase is not configured. Set SUPABASE_URL and SUPABASE_ANON_KEY in .env.',
      );
    }
    this.client = createClient(url, key, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    });
    return this.client;
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
    return { ...this.status };
  }

  /**
   * Start periodic cloud sync while signed in. Idempotent: a second call while
   * running is a no-op. An immediate push kicks off right away.
   */
  public start(): void {
    if (this.started) return;
    this.started = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => {
      void this.syncNow();
    }, SYNC_INTERVAL_MS);
    void this.syncNow();
  }

  /** Stop periodic sync (e.g. on sign-out). The last status is kept. */
  public stop(): void {
    this.started = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Sync
  // ---------------------------------------------------------------------------

  /**
   * Push the whole local database to Supabase for the signed-in user.
   * Re-entrant: concurrent calls return the in-flight status.
   */
  public async syncNow(): Promise<SupabaseSyncStatus> {
    if (this.running) return this.getStatus();
    this.running = true;
    const previous = this.status;
    this.setStatus({ ...previous, state: 'syncing' });
    try {
      // Lazy requires so test harnesses don't pull the full Electron app in.
      const { SupabaseAuthService } = require('./SupabaseAuthService');
      const auth = SupabaseAuthService.getInstance();
      const session = await auth.ensureFreshSession();
      if (!session?.user) {
        // Signed out (or the session could not be refreshed): nothing to push.
        this.setStatus({ state: 'idle' });
        return this.getStatus();
      }

      const client = this.ensureClient();
      await client.auth.setSession({
        access_token: session.access_token,
        refresh_token: session.refresh_token,
      });

      const { DatabaseManager } = require('../db/DatabaseManager');
      const db = DatabaseManager.getInstance().getDb();
      if (!db) {
        throw new Error('Local database is not available.');
      }

      const summary: SyncSummary = await syncAll({ db, client, userId: session.user.id });
      if (summary.totalFailed > 0) {
        throw new Error(`${summary.totalFailed} row(s) failed to sync.`);
      }
      this.setStatus({
        state: 'ok',
        lastSyncedAt: Date.now(),
        lastCounts: {
          rows: summary.totalRows,
          upserted: summary.totalUpserted,
          failed: summary.totalFailed,
        },
      });
      console.log(
        `[SupabaseSyncService] sync ok: ${summary.totalUpserted} row(s) upserted for ${session.user.email || session.user.id}`,
      );
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
}
