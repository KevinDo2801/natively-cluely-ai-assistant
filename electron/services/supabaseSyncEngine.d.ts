/**
 * Type declarations for supabaseSyncEngine.js (see that file for semantics).
 * The implementation is plain CommonJS so both the Electron app and the CLI
 * script can load it; this file gives TypeScript consumers typed access.
 */

export type SyncDirection = 'both' | 'push' | 'pull';

export interface SyncTableDef {
    table: string;
    /** Primary-key column name (defaults to 'id'). */
    pk?: string;
    /** 'bigint' for INTEGER autoincrement primary keys. */
    pkType?: 'bigint' | 'text';
    /** Local columns mirrored 1:1 on Supabase. */
    columns: string[];
    /** float32 BLOB column ↔ pgvector array conversion. */
    vector?: string;
}

export interface SyncProgressEvent {
    table: string;
    phase: 'pushing' | 'pulling' | 'dry-run' | 'error';
    done?: number;
    total?: number;
    rows?: number;
    cloudRows?: number;
    error?: string;
}

export interface SyncTableResult {
    table: string;
    rows: number;
    cloudRows: number;
    pushed: number;
    pulled: number;
    deletedLocal: number;
    deletedCloud: number;
    tombstonesPushed: number;
    tombstonesPulled: number;
    /** Keys this pass actually considered (0 in the steady state). */
    candidates: number;
    /** Keys re-offered this pass because an earlier push failed. */
    retrying: number;
    /** False when the pass read the table whole (first pass / periodic floor). */
    incremental: boolean;
    failed: Array<{ id: unknown; key?: string; error: string }>;
    error: string | null;
}

export interface SyncSummary {
    tables: SyncTableResult[];
    totalRows: number;
    totalPushed: number;
    totalPulled: number;
    totalDeleted: number;
    totalFailed: number;
    /** Tables whose sync errored outright (e.g. a cloud read timed out). */
    totalTableErrors: number;
    /** Candidate keys considered across every table. */
    totalCandidates: number;
    /** Outstanding retry-ledger entries across every table. */
    totalRetrying: number;
    /** True when every table was reconciled incrementally. */
    incremental: boolean;
}

/** Per-table incremental sync high-water marks. 0 means "never synced". */
export interface SyncWatermarks {
    localMs: number;
    cloudMs: number;
    /** Server-assigned sequence watermark (exact, skew-proof). 0 = unused. */
    cloudSeq: number;
    fullMs: number;
    gcMs: number;
}

/** Result of scoping an incremental pass down to the keys that can need work. */
export interface IncrementalScope {
    keys: Set<string>;
    localRows: any[];
    localTombs: Map<string, number>;
    cloudRows: any[];
    cloudTombs: Map<string, number>;
    missingCloudKeys: string[];
    allCandidates: boolean;
}

export interface SyncActions {
    pushRows: any[];
    pushDeletes: Array<{ key: string; pkValue: unknown }>;
    pullRows: any[];
    pullDeletes: Array<{ key: string; pkValue: unknown }>;
    tombPush: Array<{ table: string; rowId: string; deletedAtMs: number }>;
    tombPull: Array<{ table: string; rowId: string; deletedAtMs: number }>;
    tombCloudClear: string[];
}

export const TABLE_DEFS: SyncTableDef[];
export const FK_PARENTS: Record<string, string[]>;
export const DEFAULT_BATCH_SIZE: number;
export const TOMBSTONE_TTL_MS: number;
export const CLOUD_REQUEST_TIMEOUT_MS: number;
/** Periodic unfiltered re-read floor — the correctness net behind the watermarks. */
export const FULL_RESCAN_INTERVAL_MS: number;
export const TOMBSTONE_GC_INTERVAL_MS: number;
export const LOCAL_WATERMARK_OVERLAP_MS: number;
export const CLOUD_WATERMARK_OVERLAP_MS: number;
/** Retry backoff for rows whose push failed (see the `sync_retry` ledger). */
export const RETRY_BASE_MS: number;
export const RETRY_MAX_MS: number;

export function toMs(v: unknown): number;
export function toIso(ms: number): string;
export function blobToVector(buf: Buffer | null | undefined): {
    embedding: number[] | null;
    embeddingDims: number | null;
};
export function vectorStringToBlob(s: string | null | undefined): Buffer | null;

export function expandTables(tables: string[]): Set<string>;

export function readLocalRows(db: import('better-sqlite3').Database, def: SyncTableDef): any[];
export function readLocalTombstones(db: import('better-sqlite3').Database, table: string): Map<string, number>;

export function isNeverSynced(ms: unknown): boolean;
export function readWatermark(db: import('better-sqlite3').Database, table: string): SyncWatermarks;
export function writeWatermark(
    db: import('better-sqlite3').Database,
    table: string,
    values: SyncWatermarks,
): void;

/**
 * Cut the local/cloud row and tombstone sets down to the keys that changed on
 * either side since the matching watermark. Pure.
 */
export function scopeIncrementalCandidates(opts: {
    localRows: any[];
    localTombs: Map<string, number>;
    cloudRows: any[];
    cloudTombs: Map<string, number>;
    localSinceMs: number;
    cloudSinceMs: number;
    /** Sequence mode: the cloud delta IS the changed set — skip clock comparisons. */
    cloudDeltaIsExact?: boolean;
    /** Keys the retry ledger re-offers this pass. */
    extraKeys?: string[] | null;
}): IncrementalScope;

/** Backoff for the Nth failed push attempt (30s → 30min, capped). */
export function retryDelayMs(attempts: number): number;
/** Retry entries for a table whose backoff has elapsed. */
export function readDueRetries(
    db: import('better-sqlite3').Database,
    table: string,
    nowMs: number,
    limit?: number,
): Array<{ row_id: string; attempts: number }>;
export function readAllRetryKeys(db: import('better-sqlite3').Database, table: string): string[];
export function recordRetries(
    db: import('better-sqlite3').Database,
    table: string,
    keys: string[],
    error: string,
    nowMs: number,
): void;
export function clearRetries(db: import('better-sqlite3').Database, table: string, keys: string[]): void;
export function countRetries(db: import('better-sqlite3').Database, table: string): number;

/**
 * Whether the project has migration 0005 applied (the server-assigned
 * `sync_seq`). Probed once per process and cached; false means the engine falls
 * back to the timestamp watermark.
 */
export function cloudHasSyncSeq(client: any): Promise<boolean>;
/** Test hook: forget the cached probe result. */
export function __resetSeqProbe(): void;

export function readCloudRows(
    client: any,
    def: SyncTableDef,
    userId: string,
    opts?: { sinceMs?: number; sinceSeq?: number; selectSeq?: boolean },
): Promise<any[]>;
export function readCloudRowsByKeys(
    client: any,
    def: SyncTableDef,
    userId: string,
    keys: string[],
    opts?: { slim?: boolean },
): Promise<any[]>;
export function readCloudTombstones(
    client: any,
    table: string,
    userId: string,
    opts?: { sinceMs?: number; sinceSeq?: number; selectSeq?: boolean },
): Promise<Map<string, number>>;

export function readDirtyTables(db: import('better-sqlite3').Database): Array<{ table_name: string; seq: number }>;
export function clearDirtyTableUpTo(db: import('better-sqlite3').Database, table: string, seq: number): void;
export function clearAllDirty(db: import('better-sqlite3').Database): void;
export function suspendLocalTriggers<T>(db: import('better-sqlite3').Database, fn: () => T): T;
export function wipeSyncedTables(db: import('better-sqlite3').Database): void;

export function planTableSync(opts: {
    def: SyncTableDef;
    localRows: any[];
    localTombs: Map<string, number>;
    cloudRows: any[];
    cloudTombs: Map<string, number>;
}): SyncActions;

export function syncTable(opts: {
    db: import('better-sqlite3').Database;
    client: any;
    userId: string;
    def: SyncTableDef;
    direction?: SyncDirection;
    onProgress?: (event: SyncProgressEvent) => void;
    dryRun?: boolean;
    batchSize?: number;
    /** Ignore the watermarks and read this table whole (like v34). */
    fullRescan?: boolean;
}): Promise<SyncTableResult>;

export function syncAll(opts: {
    db: import('better-sqlite3').Database;
    client: any;
    userId: string;
    direction?: SyncDirection;
    onProgress?: (event: SyncProgressEvent) => void;
    dryRun?: boolean;
    batchSize?: number;
    /** Only reconcile these tables (FK ancestors are added automatically). */
    tables?: string[];
    /** Epoch-ms cap for the whole reconciliation; remaining tables are skipped. */
    deadline?: number;
    /** Ignore every watermark and read each table whole (like v34). */
    fullRescan?: boolean;
}): Promise<SyncSummary>;
