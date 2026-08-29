/**
 * Type declarations for supabaseSyncEngine.js (see that file for semantics).
 * The implementation is plain CommonJS so both the Electron app and the CLI
 * script can load it; this file gives TypeScript consumers typed access.
 */

export interface SyncTableDef {
    table: string;
    /** Primary-key column name (defaults to 'id'). */
    pk?: string;
    /** Local columns mirrored 1:1 on Supabase. */
    columns: string[];
    /** float32 BLOB column to convert to a pgvector array. */
    vector?: string;
}

export interface SyncProgressEvent {
    table: string;
    phase: 'reading' | 'pushing' | 'dry-run' | 'error';
    done?: number;
    total?: number;
    rows?: number;
    error?: string;
}

export interface SyncTableResult {
    table: string;
    rows: number;
    upserted: number;
    failed: Array<{ id: unknown; error: string }>;
    error: string | null;
}

export interface SyncSummary {
    tables: SyncTableResult[];
    totalRows: number;
    totalUpserted: number;
    totalFailed: number;
}

export const TABLE_DEFS: SyncTableDef[];
export const DEFAULT_BATCH_SIZE: number;

export function blobToVector(buf: Buffer | null | undefined): {
    embedding: number[] | null;
    embeddingDims: number | null;
};

export function syncTable(opts: {
    db: import('better-sqlite3').Database;
    client: any;
    userId: string;
    def: SyncTableDef;
    onProgress?: (event: SyncProgressEvent) => void;
    dryRun?: boolean;
    batchSize?: number;
}): Promise<SyncTableResult>;

export function syncAll(opts: {
    db: import('better-sqlite3').Database;
    client: any;
    userId: string;
    onProgress?: (event: SyncProgressEvent) => void;
    dryRun?: boolean;
    batchSize?: number;
}): Promise<SyncSummary>;
