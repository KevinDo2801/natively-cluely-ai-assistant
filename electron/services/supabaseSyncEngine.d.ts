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
    failed: Array<{ id: unknown; error: string }>;
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
}): Promise<SyncSummary>;
