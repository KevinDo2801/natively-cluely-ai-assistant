
import Database from 'better-sqlite3';
import { buildLegacySpaceCaseSql } from '../rag/embeddingSpace';

// ============================================================================
// Database schema migrations (extracted from DatabaseManager.ts, Phase 0).
//
// This is the ordered migration chain that DatabaseManager.runMigrations()
// executes at startup. Every step preserves the EXACT version-gating, SQL,
// logging and error semantics of the original monolithic block â€” a pure move,
// not a redesign:
//
//   * `version` in the context is the `user_version` snapshot read ONCE at the
//     start of the run. Every gate compares against that snapshot (R-05: a step
//     may advance the pragma mid-chain; the later gates must still see the
//     pre-run value).
//   * A step returning `false` aborts the chain exactly like the original
//     `return;` statements (R-22 chain termination) â€” the runner skips the
//     remaining steps and the final log.
//   * Steps reach shared vec0 provisioning state through ctx.manager (the
//     DatabaseManager instance): ensureVecTableForDim / getExistingVecDims /
//     ensuredDims are used at runtime by VectorStore and the delete/clear
//     paths, so they stay on the manager; migrations only borrow them.
// ============================================================================

/**
 * CR-06: marks the v28 page-count DATA repair as still owed. It is deliberately
 * NOT the schema `user_version`: the repair changes no schema, so a failure must
 * not hold later SCHEMA migrations (notably v29's vec0 cosine rebuild) hostage.
 */
const PAGE_COUNT_REPAIR_PENDING_KEY = 'pending_page_count_repair';

/**
 * Known embedding dimension tiers.
 * Used by the v8 migration, delete operations, and table provisioning.
 * When a new provider dimension is encountered at runtime, ensureVecTableForDim() handles it.
 */
export const KNOWN_DIMS: readonly number[] = [768, 1536, 3072];

/** The DatabaseManager surface that migration steps may reach through the context. */
export interface MigrationManager {
    /** Cache: dimensions for which vec0 tables have already been verified/created this session. */
    ensuredDims: Set<number>;
    /** Lazily create a per-dimension vec0 table pair if not already present (runtime + migrations). */
    ensureVecTableForDim(dim: number): void;
    /** Enumerate every existing vec0 dimension unioned with KNOWN_DIMS. */
    getExistingVecDims(): number[];
}

export interface MigrationContext {
    db: Database.Database;
    /** Schema version snapshot, read once at the start of the migration run. */
    version: number;
    /** The DatabaseManager instance running this migration (shared vec0 helpers). */
    manager: MigrationManager;
}

export interface MigrationStep {
    id: string;
    /**
     * Run one step. `true` continues the chain; `false` aborts it (R-22: the
     * v28â†’v29 repair marker-write failure and the v29â†’v30 rebuild failure both
     * `return;` out of the original monolithic method, so the runner must stop
     * iterating when a step returns false).
     */
    up(ctx: MigrationContext): boolean;
}

/**
 * PHASE-2D (Fix-2): drop any orphan legacy vec0 tables from prior
 * installs that DID create the broken schema, and bump a counter so
 * the v3/v4 migration blocks can log a single line IF something was
 * actually cleaned up. The happy path (fresh install from a clean
 * git clone) drops nothing and emits no log line.
 *
 * Also returns the number of tables dropped via `this._lastLegacyCleanup`
 * so the migration loop can include it in its log message.
 */
let _lastLegacyCleanup: number = 0;
function tryProvisionLegacyVecTables(db: Database.Database): void {
        if (!db) return;
        _lastLegacyCleanup = 0;
        // The two legacy tables from the broken v3/v4 schema are
        // `vec_chunks` and `vec_summaries`. They have no dimension
        // column so sqlite-vec would reject any CREATE that references
        // them — but they CAN exist as orphans if a prior install DID
        // create them before the fix landed.
        const legacyNames = ['vec_chunks', 'vec_summaries'];
        for (const name of legacyNames) {
            try {
                // probe existence with sqlite_master — DROP IF EXISTS is
                // a no-op when the table is absent, but we want to
                // distinguish "dropped" from "didn't exist" so the log
                // is accurate.
                const row = db.prepare(
                    "SELECT name FROM sqlite_master WHERE type='table' AND name = ?"
                ).get(name);
                if (!row) continue;
                db.exec(`DROP TABLE ${name};`);
                _lastLegacyCleanup++;
                console.log(`[DatabaseManager] Dropped orphan legacy vec0 table: ${name}`);
            } catch (_) {
                // Best-effort: dropping an orphan should never crash
                // startup. If DROP fails here, the v8/v9 per-dim
                // migration below will still create the working tables.
            }
        }
    }

export const MIGRATIONS: MigrationStep[] = [

    {
        id: 'v0-to-v1-initial-schema',
        up(ctx) {
            const { db, version } = ctx;
        // Version 0 → 1: Initial schema (all core tables)
        if (version < 1) {
            console.log('[DatabaseManager] Applying migration v0 → v1: Initial schema');
            db.exec(`
                CREATE TABLE IF NOT EXISTS meetings (
                    id TEXT PRIMARY KEY,
                    title TEXT,
                    start_time INTEGER,
                    duration_ms INTEGER,
                    summary_json TEXT,
                    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                    calendar_event_id TEXT,
                    source TEXT,
                    is_processed INTEGER DEFAULT 1,
                    summary_status TEXT DEFAULT 'completed'
                );

                CREATE TABLE IF NOT EXISTS transcripts (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    meeting_id TEXT,
                    speaker TEXT,
                    content TEXT,
                    timestamp_ms INTEGER,
                    FOREIGN KEY(meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS ai_interactions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    meeting_id TEXT,
                    type TEXT,
                    timestamp INTEGER,
                    user_query TEXT,
                    ai_response TEXT,
                    metadata_json TEXT,
                    FOREIGN KEY(meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS chunks (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    meeting_id TEXT NOT NULL,
                    chunk_index INTEGER NOT NULL,
                    speaker TEXT,
                    start_timestamp_ms INTEGER,
                    end_timestamp_ms INTEGER,
                    cleaned_text TEXT NOT NULL,
                    token_count INTEGER NOT NULL,
                    embedding BLOB,
                    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY(meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS chunk_summaries (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    meeting_id TEXT NOT NULL UNIQUE,
                    summary_text TEXT NOT NULL,
                    embedding BLOB,
                    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY(meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS embedding_queue (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    meeting_id TEXT NOT NULL,
                    chunk_id INTEGER,
                    status TEXT DEFAULT 'pending',
                    retry_count INTEGER DEFAULT 0,
                    error_message TEXT,
                    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                    processed_at TEXT
                );

                CREATE INDEX IF NOT EXISTS idx_chunks_meeting ON chunks(meeting_id);

                CREATE TABLE IF NOT EXISTS user_profile (
                    id INTEGER PRIMARY KEY,
                    structured_json TEXT NOT NULL,
                    compact_persona TEXT NOT NULL,
                    intro_short TEXT,
                    intro_interview TEXT,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                );

                CREATE TABLE IF NOT EXISTS resume_nodes (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    category TEXT,
                    title TEXT,
                    organization TEXT,
                    start_date TEXT,
                    end_date TEXT,
                    duration_months INTEGER,
                    text_content TEXT,
                    tags TEXT,
                    embedding BLOB
                );
            `);
            db.pragma('user_version = 1');
        }
            return true;
        },
    },

    {
        id: 'v1-to-v2-meetings-columns',
        up(ctx) {
            const { db, version } = ctx;
        // Version 1 → 2: Add columns for existing installs (safe for fresh installs too)
        if (version < 2) {
            console.log('[DatabaseManager] Applying migration v1 → v2: Add meetings columns');
            // For fresh installs these columns already exist from v1, so we guard with try/catch.
            // Unlike the old code, these are versioned and run exactly once.
            const columnsToAdd = [
                "ALTER TABLE meetings ADD COLUMN calendar_event_id TEXT",
                "ALTER TABLE meetings ADD COLUMN source TEXT",
                "ALTER TABLE meetings ADD COLUMN is_processed INTEGER DEFAULT 1"
            ];
            for (const sql of columnsToAdd) {
                try { db.exec(sql); } catch (e) { /* Column already exists from v1 CREATE */ }
            }
            db.pragma('user_version = 2');
        }
            return true;
        },
    },

    {
        id: 'v2-to-v3-legacy-vec-cleanup',
        up(ctx) {
            const { db, version } = ctx;
        // Version 2 → 3: sqlite-vec virtual tables for native vector search
        if (version < 3) {
            // PHASE-2D (Fix-2): the historical v3 step attempted to create
            // a vec0 table with `embedding float` (no dimension), which
            // sqlite-vec rejects with "At least one vector column is
            // required". The fix is to skip that broken CREATE entirely
            // and let the v8/v9 per-dimension migration below provision
            // the working tables. We still bump user_version to 3 so the
            // migration loop advances normally.
            //
            // The happy path (fresh install) is now COMPLETELY SILENT —
            // no log line, no error. We only log when there's actual
            // legacy cleanup to report (a prior install that DID create
            // the broken tables).
            try {
                tryProvisionLegacyVecTables(db);
                if (_lastLegacyCleanup > 0) {
                    console.log(`[DatabaseManager] v3 migration: cleared ${_lastLegacyCleanup} legacy broken vec0 table(s) (replaced by per-dim v8/v9)`);
                    _lastLegacyCleanup = 0;
                }
            } catch (e) {
                // Only log on ACTUAL failure, not on the historic "vec0
                // constructor error: At least one vector column is
                // required" which we now explicitly do NOT raise.
                console.error('[DatabaseManager] v3 migration failed unexpectedly (non-fatal, will be retried at v8/v9):', (e as { message?: string })?.message || e);
            }
            db.pragma('user_version = 3');
        }
            return true;
        },
    },

    {
        id: 'v3-to-v4-drop-strict-vec0',
        up(ctx) {
            const { db, version } = ctx;
        // Version 3 → 4: Drop strict 768-dim vec0 tables to allow flexible embedding dimensions
        if (version < 4) {
            // PHASE-2D (Fix-2): same fix as v3 — silent on fresh installs.
            // The only action this step used to take was DROP TABLE on
            // tables that v3 just CREATED. Since v3 no longer creates
            // them, and legacy repos already had them dropped in v3,
            // there's nothing to do on the happy path.
            try {
                tryProvisionLegacyVecTables(db);
                if (_lastLegacyCleanup > 0) {
                    console.log(`[DatabaseManager] v4 migration: cleared ${_lastLegacyCleanup} legacy broken vec0 table(s)`);
                    _lastLegacyCleanup = 0;
                }
            } catch (e) {
                console.error('[DatabaseManager] v4 migration failed (non-fatal):', (e as { message?: string })?.message || e);
            }
            db.pragma('user_version = 4');
        }
            return true;
        },
    },

    {
        id: 'v4-to-v5-embedding-columns',
        up(ctx) {
            const { db, version } = ctx;
        // Version 4 → 5: Add embedding provider and dimensions columns
        if (version < 5) {
            console.log('[DatabaseManager] Applying migration v4 → v5: Add embedding provider/dimensions columns');
            const columnsToAdd = [
                "ALTER TABLE meetings ADD COLUMN embedding_provider TEXT",
                "ALTER TABLE meetings ADD COLUMN embedding_dimensions INTEGER"
            ];
            for (const sql of columnsToAdd) {
                try { db.exec(sql); } catch (e) { /* Column already exists */ }
            }
            db.pragma('user_version = 5');
        }
            return true;
        },
    },

    {
        id: 'v5-to-v6-app-state',
        up(ctx) {
            const { db, version } = ctx;
        // Version 5 → 6: Add app_state table for KV storage (Ollama pull state, etc)
        if (version < 6) {
            console.log('[DatabaseManager] Applying migration v5 → v6: Add app_state table');
            db.exec(`
                CREATE TABLE IF NOT EXISTS app_state (
                    key TEXT PRIMARY KEY,
                    value TEXT
                );
            `);
            db.pragma('user_version = 6');
        }
            return true;
        },
    },

    {
        id: 'v6-to-v7-meeting-indexes',
        up(ctx) {
            const { db, version } = ctx;
        // Version 6 → 7: Add indexes on transcripts and ai_interactions meeting_id
        // (Previously missing — causes O(N) full-table scans when fetching meeting details)
        if (version < 7) {
            console.log('[DatabaseManager] Applying migration v6 → v7: Add meeting_id indexes');
            try {
                db.exec('CREATE INDEX IF NOT EXISTS idx_transcripts_meeting ON transcripts(meeting_id);');
                db.exec('CREATE INDEX IF NOT EXISTS idx_ai_interactions_meeting ON ai_interactions(meeting_id, timestamp);');
                console.log('[DatabaseManager] Meeting ID indexes created successfully');
            } catch (e) {
                console.error('[DatabaseManager] Failed to create indexes (non-fatal):', e);
            }
            db.pragma('user_version = 7');
        }
            return true;
        },
    },

    {
        id: 'v7-to-v8-vec-tables',
        up(ctx) {
            const { db, version } = ctx;
        // Version 7 → 8: Provision per-dimension vec0 tables (NOTE: this v8 ran in two broken
        // iterations for some users — first with float[1536] single table, then with correct per-dim
        // tables. The v9 migration below corrects any v8 that used the old broken schema.)
        if (version < 8) {
            console.log('[DatabaseManager] Applying migration v7 → v8: Provision per-dimension vec0 tables');
            // Drop the legacy single-dim tables from v3/v4 if they exist and are unusable
            try { db.exec('DROP TABLE IF EXISTS vec_chunks;'); } catch (_) {}
            try { db.exec('DROP TABLE IF EXISTS vec_summaries;'); } catch (_) {}

            for (const dim of KNOWN_DIMS) {
                ctx.manager.ensureVecTableForDim(dim);
            }
            console.log('[DatabaseManager] v8 migration: per-dimension vec0 tables provisioned');
            db.pragma('user_version = 8');
        }
            return true;
        },
    },

    {
        id: 'v8-to-v9-ensure-vec-tables',
        up(ctx) {
            const { db, version } = ctx;
        // Version 8 → 9: Ensure per-dimension tables exist.
        // Required for DBs already at v8 but with the old broken float[1536] single-table schema,
        // or with the first incorrect v8 migration that didn't provision KNOWN_DIMS tables.
        if (version < 9) {
            console.log('[DatabaseManager] Applying migration v8 → v9: Ensure per-dimension vec0 tables exist');
            // Drop old single-dim orphan tables if they exist (float[1536] schema)
            try { db.exec('DROP TABLE IF EXISTS vec_chunks;'); } catch (_) {}
            try { db.exec('DROP TABLE IF EXISTS vec_summaries;'); } catch (_) {}

            let allOk = true;
            for (const dim of KNOWN_DIMS) {
                ctx.manager.ensureVecTableForDim(dim);
                // Verify the table actually exists after provisioning
                try {
                    db.prepare(`SELECT count(*) FROM vec_chunks_${dim} LIMIT 1`).get();
                } catch (e) {
                    console.error(`[DatabaseManager] v9: vec_chunks_${dim} still missing after provisioning:`, e);
                    allOk = false;
                }
            }
            if (allOk) {
                console.log('[DatabaseManager] v9 migration: all per-dimension vec0 tables verified ✓');
            } else {
                console.warn('[DatabaseManager] v9 migration: some tables missing — sqlite-vec extension may not be loaded');
            }
            db.pragma('user_version = 9');
        }
            return true;
        },
    },

    {
        id: 'v9-to-v10-embedding-queue-unique',
        up(ctx) {
            const { db, version } = ctx;
        // Version 9 → 10: Add UNIQUE constraint on embedding_queue(meeting_id, chunk_id).
        // This enables INSERT OR IGNORE in EmbeddingPipeline.queueMeeting() to silently
        // skip duplicate rows when queueMeeting() is called more than once for the same meeting.
        // SQLite doesn't support ADD CONSTRAINT on existing tables, so we recreate the table
        // using the standard rename-create-copy-drop pattern.
        if (version < 10) {
            console.log('[DatabaseManager] Applying migration v9 → v10: Add UNIQUE constraint to embedding_queue');
            try {
                // Wrap all steps in an explicit better-sqlite3 transaction for atomicity.
                // If any step throws, the entire migration is rolled back cleanly —
                // preventing the dangerous half-renamed table state that a bare exec() chain would leave.
                const migrate = db.transaction(() => {
                    // Step 1: Rename the existing table to a temp name
                    db!.exec('ALTER TABLE embedding_queue RENAME TO embedding_queue_old;');

                    // Step 2: Recreate with the UNIQUE(meeting_id, chunk_id) constraint
                    db!.exec(`
                        CREATE TABLE embedding_queue (
                            id INTEGER PRIMARY KEY AUTOINCREMENT,
                            meeting_id TEXT NOT NULL,
                            chunk_id INTEGER,
                            status TEXT DEFAULT 'pending',
                            retry_count INTEGER DEFAULT 0,
                            error_message TEXT,
                            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                            processed_at TEXT,
                            UNIQUE(meeting_id, chunk_id)
                        );
                    `);

                    // Step 3: Copy rows; INSERT OR IGNORE silently drops any pre-existing duplicates
                    db!.exec(`
                        INSERT OR IGNORE INTO embedding_queue
                            (id, meeting_id, chunk_id, status, retry_count, error_message, created_at, processed_at)
                        SELECT id, meeting_id, chunk_id, status, retry_count, error_message, created_at, processed_at
                        FROM embedding_queue_old;
                    `);

                    // Step 4: Drop the backup
                    db!.exec('DROP TABLE embedding_queue_old;');
                });
                migrate();
                console.log('[DatabaseManager] v10 migration: embedding_queue UNIQUE constraint added ✓');
            } catch (e) {
                console.error('[DatabaseManager] v10 migration failed — table structure unchanged:', e);
                // user_version still advances. We do NOT retry — a failed rename leaves
                // embedding_queue_old behind; retrying would cause "table already exists".
                // In the failure case, INSERT OR IGNORE in queueMeeting() will still work
                // for natural uniqueness (same meeting queued twice picks up existing rows),
                // just without DB-enforced deduplication.
            }
            db.pragma('user_version = 10');
        }
            return true;
        },
    },

    {
        id: 'v10-to-v11-modes-tables',
        up(ctx) {
            const { db, version } = ctx;
        // Version 10 → 11: Add modes, mode_reference_files, and mode_note_sections tables
        if (version < 11) {
            console.log('[DatabaseManager] Applying migration v10 → v11: Add modes tables');
            db.exec(`
                CREATE TABLE IF NOT EXISTS modes (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    template_type TEXT NOT NULL DEFAULT 'general',
                    custom_context TEXT NOT NULL DEFAULT '',
                    is_active INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                );

                CREATE TABLE IF NOT EXISTS mode_reference_files (
                    id TEXT PRIMARY KEY,
                    mode_id TEXT NOT NULL,
                    file_name TEXT NOT NULL,
                    content TEXT NOT NULL DEFAULT '',
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY(mode_id) REFERENCES modes(id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS mode_note_sections (
                    id TEXT PRIMARY KEY,
                    mode_id TEXT NOT NULL,
                    title TEXT NOT NULL,
                    description TEXT NOT NULL DEFAULT '',
                    sort_order INTEGER NOT NULL DEFAULT 0,
                    compiled_prompt TEXT DEFAULT '',
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY(mode_id) REFERENCES modes(id) ON DELETE CASCADE
                );
            `);
            // Seed a default "General" mode as active
            const defaultModeId = 'mode_general_default';
            db.prepare(`
                INSERT OR IGNORE INTO modes (id, name, template_type, custom_context, is_active)
                VALUES (?, ?, ?, ?, 1)
            `).run(defaultModeId, 'General', 'general', '');
            db.pragma('user_version = 11');
        }
            return true;
        },
    },

    {
        id: 'v11-to-v12-default-note-sections',
        up(ctx) {
            const { db, version } = ctx;
        // Version 11 → 12: Seed note sections for the default General mode if missing
        if (version < 12) {
            console.log('[DatabaseManager] Applying migration v11 → v12: Seed default General mode note sections');
            const defaultModeId = 'mode_general_default';
            const modeExists = db.prepare('SELECT id FROM modes WHERE id = ?').get(defaultModeId);
            const existing = modeExists
                ? db.prepare('SELECT id FROM mode_note_sections WHERE mode_id = ?').get(defaultModeId)
                : null;
            if (modeExists && !existing) {
                const defaultSections = [
                    { title: 'Summary',      description: 'High-level summary of the conversation.' },
                    { title: 'Action items', description: 'Tasks and follow-ups identified.' },
                    { title: 'Key points',   description: 'Important points discussed.' },
                ];
                const insertSection = db.prepare(
                    'INSERT OR IGNORE INTO mode_note_sections (id, mode_id, title, description, sort_order) VALUES (?, ?, ?, ?, ?)'
                );
                defaultSections.forEach((s, i) => {
                    insertSection.run(`ns_general_${i}`, defaultModeId, s.title, s.description, i);
                });
            }
            db.pragma('user_version = 12');
        }
            return true;
        },
    },

    {
        id: 'v12-to-v13-backfill-note-sections',
        up(ctx) {
            const { db, version } = ctx;
        // Version 12 → 13: Backfill note sections for any mode instance that has none
        if (version < 13) {
            console.log('[DatabaseManager] Applying migration v12 → v13: Backfill missing mode note sections');
            const BACKFILL_SECTIONS: Record<string, Array<{ title: string; description: string }>> = {
                general: [
                    { title: 'Summary',      description: 'High-level summary of the conversation.' },
                    { title: 'Action items', description: 'Tasks and follow-ups identified.' },
                    { title: 'Key points',   description: 'Important points discussed.' },
                ],
                'looking-for-work': [
                    { title: 'Follow-up actions',       description: 'Next interview steps or additional materials I said I would send if applicable.' },
                    { title: 'Overview',                description: 'Overview of the interview, the company, and general structure.' },
                    { title: 'Questions and responses', description: 'All questions asked to me during the interview and answers that gave.' },
                    { title: 'Areas to improve',        description: 'What I could have done better during the interview.' },
                    { title: 'Role details',            description: 'Anything discussed about the position, salary expectations, etc.' },
                ],
                sales: [
                    { title: 'Action Items',        description: 'All action items that were said I would do after the meeting.' },
                    { title: 'Outcome',             description: 'Did I close the sale and what was the outcome of the conversation.' },
                    { title: 'Prospect background', description: 'Background and context on who I was selling to.' },
                    { title: 'Discovery',           description: 'What the prospect said during discovery.' },
                    { title: 'Product',             description: "How I pitched the product and the prospect's reaction." },
                    { title: 'Objections',          description: 'Objections from the prospect if there were any.' },
                ],
                recruiting: [
                    { title: 'Action Items',          description: 'All action items that I have to do after the meeting.' },
                    { title: 'Experience and skills', description: "Candidate's previous work experience and skills discussed." },
                    { title: 'Quality of responses',  description: 'If there were questions asked, how well and how accurately the candidate answered each question.' },
                    { title: 'Interest in company',   description: 'What the candidate said about their interest in the company.' },
                    { title: 'Role expectations',     description: 'Anything discussed about the position, salary expectations, etc.' },
                ],
                'team-meet': [
                    { title: 'Action Items',           description: 'All action items that were said I would do after the meeting.' },
                    { title: 'Announcements',          description: 'Any team-wide announcements from the meeting.' },
                    { title: 'Team updates',           description: "Each team member's progress, accomplishments, and current focus." },
                    { title: 'Challenges or blockers', description: 'Any issues or obstacles raised that may affect progress.' },
                    { title: 'Decisions made',         description: 'Key decisions or agreements reached during the meeting.' },
                ],
                lecture: [
                    { title: 'Follow-up work', description: 'Follow-up reading, assignments, or tasks to complete.' },
                    { title: 'Topic',          description: 'Main subject or theme of the lecture.' },
                    { title: 'Key concepts',   description: 'Core ideas or frameworks covered.' },
                    { title: 'Content',        description: 'All content from the lecture with incredibly detailed bullet notes.' },
                ],
                'technical-interview': [
                    { title: 'Problems covered', description: 'Each problem asked, the approach used, and the outcome.' },
                    { title: 'Concepts tested',  description: 'Key algorithms, data structures, or system design concepts that came up.' },
                    { title: 'What went well',   description: 'Approaches or explanations that landed well.' },
                    { title: 'Areas to study',   description: 'Topics or gaps identified that need more preparation.' },
                    { title: 'Action items',     description: 'Follow-up steps — e.g. send code, study specific topics, await next round.' },
                ],
            };

            const allModes = db.prepare('SELECT id, template_type FROM modes').all() as Array<{ id: string; template_type: string }>;
            const insertSection = db.prepare(
                'INSERT OR IGNORE INTO mode_note_sections (id, mode_id, title, description, sort_order) VALUES (?, ?, ?, ?, ?)'
            );
            for (const mode of allModes) {
                const hasSection = db.prepare('SELECT id FROM mode_note_sections WHERE mode_id = ? LIMIT 1').get(mode.id);
                if (!hasSection) {
                    const sections = BACKFILL_SECTIONS[mode.template_type] ?? [];
                    sections.forEach((s, i) => {
                        insertSection.run(`ns_bf_${mode.id}_${i}`, mode.id, s.title, s.description, i);
                    });
                    if (sections.length > 0) {
                        console.log(`[DatabaseManager] Backfilled ${sections.length} sections for mode "${mode.id}" (${mode.template_type})`);
                    }
                }
            }
            db.pragma('user_version = 13');
        }
            return true;
        },
    },

    {
        id: 'v13-to-v14-profile-custom-notes',
        up(ctx) {
            const { db, version } = ctx;
        // NOTE: profile_custom_notes and profile_persona (v13→14, v14→15 below) are orphaned —
        // the Custom Context / AI Persona feature they backed was removed. Kept non-destructively.
        // Version 13 → 14: Add profile_custom_notes table
        if (version < 14) {
            console.log('[DatabaseManager] Applying migration v13 → v14: Add profile_custom_notes table');
            db.exec(`
                CREATE TABLE IF NOT EXISTS profile_custom_notes (
                    id INTEGER PRIMARY KEY CHECK (id = 1),
                    content TEXT NOT NULL DEFAULT '',
                    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
                );
                INSERT OR IGNORE INTO profile_custom_notes (id, content) VALUES (1, '');
            `);
            db.pragma('user_version = 14');
        }
            return true;
        },
    },

    {
        id: 'v14-to-v15-profile-persona',
        up(ctx) {
            const { db, version } = ctx;
        // Version 14 → 15: Add profile_persona table
        if (version < 15) {
            console.log('[DatabaseManager] Applying migration v14 → v15: Add profile_persona table');
            db.exec(`
                CREATE TABLE IF NOT EXISTS profile_persona (
                    id INTEGER PRIMARY KEY CHECK (id = 1),
                    content TEXT NOT NULL DEFAULT '',
                    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
                );
                INSERT OR IGNORE INTO profile_persona (id, content) VALUES (1, '');
            `);
            db.pragma('user_version = 15');
        }
            return true;
        },
    },

    {
        id: 'v15-to-v16-embedding-space',
        up(ctx) {
            const { db, version } = ctx;
        // Version 15 → 16: Add embedding_space identity column + backfill.
        // The previous re-index compatibility check keyed on `embedding_provider`
        // (name only, e.g. 'gemini'), which CANNOT distinguish two models with the
        // same provider+dimensions but incompatible vector spaces (e.g.
        // gemini-embedding-001 768d vs gemini-embedding-2 768d). embedding_space is
        // the composite `${name}:${model}:${dims}` identity that fixes this.
        //
        // Backfill synthesizes the v1 space for each legacy row from its existing
        // provider+dims so it correctly DIFFERS from any new model's space. The
        // model strings below must match each provider's shipped default at the
        // time legacy rows were written (see electron/rag/embeddingSpace.ts:legacySpaceForProvider).
        if (version < 16) {
            console.log('[DatabaseManager] Applying migration v15 → v16: Add embedding_space column + backfill');
            try { db.exec('ALTER TABLE meetings ADD COLUMN embedding_space TEXT'); } catch (e) { /* column already exists */ }
            try {
                // Build the CASE arms from the SAME shared map legacySpaceForProvider uses,
                // so the migration backfill and the runtime space key can never drift apart.
                const caseArms = buildLegacySpaceCaseSql();
                db.exec(`
                    UPDATE meetings
                    SET embedding_space =
                        embedding_provider || ':' ||
                        CASE embedding_provider
                          ${caseArms}
                          ELSE 'unknown'
                        END || ':' ||
                        COALESCE(CAST(embedding_dimensions AS TEXT), 'unknown')
                    WHERE embedding_provider IS NOT NULL
                      AND embedding_space IS NULL;
                `);
                db.exec('CREATE INDEX IF NOT EXISTS idx_meetings_embedding_space ON meetings(embedding_space);');
                console.log('[DatabaseManager] v16 migration: embedding_space backfilled + indexed ✓');
            } catch (e) {
                console.error('[DatabaseManager] v16 migration backfill failed (non-fatal):', e);
            }
            db.pragma('user_version = 16');
        }
            return true;
        },
    },

    {
        id: 'v16-to-v17-summary-status',
        up(ctx) {
            const { db, version } = ctx;
        // Version 16 → 17: Track post-meeting note generation state.
        // V3 summarization is multi-stage (queued → chunking → summarizing_chunks →
        // reducing → validating → completed/failed). Store only a safe status string —
        // never transcript or generated note content — so the UI can expose retry/regenerate.
        if (version < 17) {
            console.log('[DatabaseManager] Applying migration v16 → v17: Add summary_status column');
            try { db.exec("ALTER TABLE meetings ADD COLUMN summary_status TEXT DEFAULT 'completed'"); } catch (e) { /* column already exists */ }
            try { db.exec("UPDATE meetings SET summary_status = 'queued' WHERE is_processed = 0"); } catch (e) { /* non-fatal backfill */ }
            db.pragma('user_version = 17');
        }
            return true;
        },
    },

    {
        id: 'v17-to-v18-compiled-prompt',
        up(ctx) {
            const { db, version } = ctx;
        // Version 17 → 18: Add compiled_prompt to mode_note_sections. When a user adds or
        // edits a note-section (or creates a custom mode), an AI-compiled extraction
        // instruction is generated from the section's title+description and cached here so
        // summary generation can fill that section faithfully. Empty/null = fall back to
        // title+description. Never stores transcript or note content.
        if (version < 18) {
            console.log('[DatabaseManager] Applying migration v17 → v18: Add compiled_prompt to mode_note_sections');
            try { db.exec("ALTER TABLE mode_note_sections ADD COLUMN compiled_prompt TEXT DEFAULT ''"); } catch (e) { /* column already exists */ }
            db.pragma('user_version = 18');
        }
            return true;
        },
    },

    {
        id: 'v18-to-v19-page-count',
        up(ctx) {
            const { db, version } = ctx;
        if (version < 19) {
            // PDF ingestion now captures real page counts (electron/ipcHandlers.ts
            // 2026-06-27 fix F1+F2). Persist them on the file row so the
            // retriever can use real numbers instead of falling back to the
            // 3000-char text-length heuristic on every app restart.
            console.log('[DatabaseManager] Applying migration v18 → v19: Add page_count + extracted_page_count to mode_reference_files');
            try { db.exec("ALTER TABLE mode_reference_files ADD COLUMN page_count INTEGER"); } catch (e) { /* column already exists */ }
            try { db.exec("ALTER TABLE mode_reference_files ADD COLUMN extracted_page_count INTEGER"); } catch (e) { /* column already exists */ }
            db.pragma('user_version = 19');
        }
            return true;
        },
    },

    {
        id: 'v19-to-v20-okf-tables',
        up(ctx) {
            const { db, version } = ctx;
        if (version < 20) {
            // OKF Hybrid Knowledge System (Phase 2, 2026-07-01): structured,
            // source-attributed "Knowledge Packs" (OKF-compatible Knowledge
            // Bundles) generated from uploaded reference files, layered ON TOP
            // of (never replacing) mode_reference_files / mode_reference_chunks.
            // All FKs cascade on mode/source deletion so a deleted reference
            // file's pack/cards/entities/relations are cleaned up automatically.
            console.log('[DatabaseManager] Applying migration v19 → v20: Add OKF knowledge_* tables');
            db.exec(`
                CREATE TABLE IF NOT EXISTS knowledge_sources (
                    id TEXT PRIMARY KEY,
                    type TEXT NOT NULL DEFAULT 'reference_file',
                    file_id TEXT,
                    mode_id TEXT,
                    file_name TEXT,
                    source_checksum TEXT NOT NULL,
                    content_hash TEXT NOT NULL,
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    indexed_at TEXT,
                    page_count INTEGER,
                    extracted_page_count INTEGER,
                    index_version TEXT NOT NULL DEFAULT 'knowledge_pack_v1',
                    embedding_space TEXT,
                    FOREIGN KEY(file_id) REFERENCES mode_reference_files(id) ON DELETE CASCADE,
                    FOREIGN KEY(mode_id) REFERENCES modes(id) ON DELETE CASCADE
                );
                CREATE INDEX IF NOT EXISTS idx_knowledge_sources_file_id ON knowledge_sources(file_id);
                CREATE INDEX IF NOT EXISTS idx_knowledge_sources_mode_id ON knowledge_sources(mode_id);

                CREATE TABLE IF NOT EXISTS knowledge_packs (
                    id TEXT PRIMARY KEY,
                    source_id TEXT NOT NULL,
                    mode_id TEXT NOT NULL,
                    file_name TEXT NOT NULL,
                    index_md TEXT NOT NULL DEFAULT '',
                    stats_json TEXT NOT NULL DEFAULT '{}',
                    pack_version INTEGER NOT NULL DEFAULT 1,
                    generated_by TEXT NOT NULL DEFAULT 'okf_extractor_v1',
                    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY(source_id) REFERENCES knowledge_sources(id) ON DELETE CASCADE,
                    FOREIGN KEY(mode_id) REFERENCES modes(id) ON DELETE CASCADE
                );
                CREATE INDEX IF NOT EXISTS idx_knowledge_packs_source_id ON knowledge_packs(source_id);
                CREATE INDEX IF NOT EXISTS idx_knowledge_packs_mode_id ON knowledge_packs(mode_id);

                CREATE TABLE IF NOT EXISTS knowledge_cards (
                    id TEXT PRIMARY KEY,
                    pack_id TEXT NOT NULL,
                    source_id TEXT NOT NULL,
                    type TEXT NOT NULL,
                    title TEXT NOT NULL,
                    slug TEXT NOT NULL,
                    concept_id TEXT NOT NULL,
                    body TEXT NOT NULL DEFAULT '',
                    body_markdown TEXT,
                    source_pages_json TEXT NOT NULL DEFAULT '[]',
                    source_sections_json TEXT NOT NULL DEFAULT '[]',
                    source_quotes_json TEXT NOT NULL DEFAULT '[]',
                    entities_json TEXT NOT NULL DEFAULT '[]',
                    tags_json TEXT NOT NULL DEFAULT '[]',
                    related_card_ids_json TEXT NOT NULL DEFAULT '[]',
                    confidence TEXT NOT NULL DEFAULT 'medium',
                    generated_from TEXT NOT NULL DEFAULT 'pdf_extraction',
                    source_checksum TEXT NOT NULL,
                    user_edited INTEGER NOT NULL DEFAULT 0,
                    approval_status TEXT NOT NULL DEFAULT 'generated',
                    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    card_version INTEGER NOT NULL DEFAULT 1,
                    FOREIGN KEY(pack_id) REFERENCES knowledge_packs(id) ON DELETE CASCADE,
                    FOREIGN KEY(source_id) REFERENCES knowledge_sources(id) ON DELETE CASCADE
                );
                CREATE INDEX IF NOT EXISTS idx_knowledge_cards_pack_id ON knowledge_cards(pack_id);
                CREATE INDEX IF NOT EXISTS idx_knowledge_cards_source_id ON knowledge_cards(source_id);
                CREATE INDEX IF NOT EXISTS idx_knowledge_cards_concept_id ON knowledge_cards(concept_id);
                CREATE INDEX IF NOT EXISTS idx_knowledge_cards_type ON knowledge_cards(type);

                CREATE TABLE IF NOT EXISTS knowledge_entities (
                    id TEXT PRIMARY KEY,
                    pack_id TEXT NOT NULL,
                    slug TEXT NOT NULL,
                    name TEXT NOT NULL,
                    type TEXT NOT NULL DEFAULT 'concept',
                    aliases_json TEXT NOT NULL DEFAULT '[]',
                    description TEXT NOT NULL DEFAULT '',
                    source_card_ids_json TEXT NOT NULL DEFAULT '[]',
                    source_pages_json TEXT NOT NULL DEFAULT '[]',
                    first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY(pack_id) REFERENCES knowledge_packs(id) ON DELETE CASCADE
                );
                CREATE INDEX IF NOT EXISTS idx_knowledge_entities_pack_id ON knowledge_entities(pack_id);
                CREATE INDEX IF NOT EXISTS idx_knowledge_entities_slug ON knowledge_entities(slug);

                CREATE TABLE IF NOT EXISTS knowledge_relations (
                    id TEXT PRIMARY KEY,
                    pack_id TEXT NOT NULL,
                    subject_id TEXT NOT NULL,
                    subject_type TEXT NOT NULL,
                    predicate TEXT NOT NULL,
                    object_id TEXT NOT NULL,
                    object_type TEXT NOT NULL,
                    source_card_ids_json TEXT NOT NULL DEFAULT '[]',
                    source_pages_json TEXT NOT NULL DEFAULT '[]',
                    confidence TEXT NOT NULL DEFAULT 'medium',
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY(pack_id) REFERENCES knowledge_packs(id) ON DELETE CASCADE
                );
                CREATE INDEX IF NOT EXISTS idx_knowledge_relations_pack_id ON knowledge_relations(pack_id);
                CREATE INDEX IF NOT EXISTS idx_knowledge_relations_subject_id ON knowledge_relations(subject_id);

                CREATE TABLE IF NOT EXISTS knowledge_index_versions (
                    id TEXT PRIMARY KEY,
                    source_id TEXT NOT NULL,
                    pack_id TEXT,
                    pack_version INTEGER NOT NULL DEFAULT 1,
                    content_hash TEXT NOT NULL,
                    embedding_space TEXT,
                    status TEXT NOT NULL DEFAULT 'pending',
                    error_message TEXT,
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY(source_id) REFERENCES knowledge_sources(id) ON DELETE CASCADE
                );
                CREATE INDEX IF NOT EXISTS idx_knowledge_index_versions_source_id ON knowledge_index_versions(source_id);
            `);
            db.pragma('user_version = 20');
        }
            return true;
        },
    },

    {
        id: 'v20-to-v21-knowledge-card-versions',
        up(ctx) {
            const { db, version } = ctx;
        if (version < 21) {
            // OKF Phase 6 (2026-07-01): user edits and approval workflow.
            // knowledge_card_versions preserves EVERY prior card body (both
            // generated and user-edited) so an edit can always be reverted to
            // the original generated card, never destructively overwriting
            // history. approval_status/user_edited columns already exist on
            // knowledge_cards (added in v19→v20); this migration adds the
            // version-history table those columns' UI depends on.
            console.log('[DatabaseManager] Applying migration v20 → v21: Add knowledge_card_versions table');
            db.exec(`
                CREATE TABLE IF NOT EXISTS knowledge_card_versions (
                    id TEXT PRIMARY KEY,
                    card_id TEXT NOT NULL,
                    card_version INTEGER NOT NULL,
                    title TEXT NOT NULL,
                    body TEXT NOT NULL,
                    entities_json TEXT NOT NULL DEFAULT '[]',
                    tags_json TEXT NOT NULL DEFAULT '[]',
                    confidence TEXT NOT NULL DEFAULT 'medium',
                    edited_by TEXT NOT NULL DEFAULT 'system',
                    edit_reason TEXT,
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY(card_id) REFERENCES knowledge_cards(id) ON DELETE CASCADE
                );
                CREATE INDEX IF NOT EXISTS idx_knowledge_card_versions_card_id ON knowledge_card_versions(card_id);
            `);
            db.pragma('user_version = 21');
        }
            return true;
        },
    },

    {
        id: 'v21-to-v22-page-count-backfill',
        up(ctx) {
            const { db, version } = ctx;
        if (version < 22) {
            // FIX 2026-07-01: backfill page_count / extracted_page_count on
            // existing reference_file rows where the column is NULL. The cause:
            // the v18→v19 schema migration added the columns and the v19→v21
            // rounds shipped the upstream producer-side forwarding fix (see
            // ModesManager.addReferenceFile). Rows inserted BEFORE that fix
            // shipped still have NULL page_count, which forces
            // ModeContextRetriever.reportReferenceFilePageCounts into its
            // heuristic branch (`referenceFileIngestedByPageHeuristic: true`)
            // until the user re-uploads the file. This migration derives the
            // value from [Page N] markers already embedded in content (round-2
            // injected those into pdf-parse output). Two phases:
            //   1) Derive a count from [Page N] markers for PDFs (fast, exact).
            //   2) Fall back to a character-length estimate for any non-PDF
            //      where markers don't match. Conservative divisor of 3000
            //      mirrors the live in-app heuristic exactly so downstream
            //      behavior is stable.
            // Safe on WAL — single bulk UPDATE per phase, no FK cascade
            // impact (page_count is a leaf integer column, no schema change).
            // Idempotent: WHERE page_count IS NULL ensures re-runs are no-ops.
            console.log('[DatabaseManager] Applying migration v21 → v22: Backfill NULL page_count + extracted_page_count on mode_reference_files');
            try {
                // Phase 1: derive exact count from every [Page N] marker via
                // recursive CTE. The CTE seeds with the first occurrence offset,
                // then iterates `instr(content, '[Page ', prev + 1)` to find
                // each subsequent occurrence until instr returns 0 (no more
                // matches). Each iteration extracts `CAST(... AS INTEGER)` of
                // the trailing number. MAX() then returns the largest page
                // number found, which == total page count for any document
                // with sequentially-numbered markers.
                //
                // CRITICAL: the first draft of Phase 1 used a single
                // `instr(content, '[Page ')` call which returns ONLY the FIRST
                // occurrence offset — so substr() extracted the page number
                // from the first marker only (returned 1 for a 66-page PDF).
                // The recursive CTE walks EVERY occurrence so MAX() finds the
                // actual total. Test-engineer caught this on 2026-07-01.
                const phaseOne = db.prepare(`
                    UPDATE mode_reference_files
                    SET page_count = (
                        -- Each row's content is its own subquery scope. CTE walks
                        -- by chopping "rest" to everything-after the [Page N]
                        -- header, finding the next [Page marker in that rest,
                        -- extracting its integer, and recursing. The seeded
                        -- row finds marker #1, the recursive step finds #N+1,
                        -- and so on until no more markers remain.
                        -- SQLite's built-in instr() takes (haystack, needle)
                        -- only — no 3-arg form — so we walk by carving the
                        -- string instead of using absolute offsets.
                        -- If no markers exist this SELECT returns NULL (no
                        -- rows); the WHERE phase_count IS NULL guard in Phase 2
                        -- picks those rows back up for the heuristic fallback.
                        WITH RECURSIVE cte_pages(rest, page_num) AS (
                            SELECT
                                substr(content, instr(content, '[Page ') + 6),
                                CASE
                                    WHEN instr(content, '[Page ') > 0
                                    THEN CAST(
                                        substr(
                                            content,
                                            instr(content, '[Page ') + 6,
                                            instr(substr(content, instr(content, '[Page ') + 6), ']') - 1
                                        ) AS INTEGER
                                    )
                                    ELSE NULL
                                END
                            -- F-701: there is deliberately NO inner FROM here.
                            -- An inner FROM mode_reference_files re-opens the
                            -- table and SHADOWS the outer UPDATE row, which made
                            -- the old self-equality correlation predicate a
                            -- tautology over that inner instance — so the
                            -- subquery was UNCORRELATED and MAX(page_num)
                            -- returned the largest page number in the WHOLE
                            -- table, written into every row (a 3-page document
                            -- reporting 6 pages). A seed with no FROM is a
                            -- single-row SELECT whose content column binds to the
                            -- row being updated, which is the correlation this
                            -- migration always intended.
                        UNION ALL
                            SELECT
                                substr(rest, instr(rest, '[Page ') + 6),
                                CASE
                                    WHEN instr(rest, '[Page ') > 0
                                    THEN CAST(
                                        substr(
                                            rest,
                                            instr(rest, '[Page ') + 6,
                                            instr(substr(rest, instr(rest, '[Page ') + 6), ']') - 1
                                        ) AS INTEGER
                                    )
                                    ELSE NULL
                                END
                            FROM cte_pages
                            WHERE instr(rest, '[Page ') > 0
                            LIMIT 5000
                        )
                        SELECT MAX(page_num) FROM cte_pages WHERE page_num IS NOT NULL
                    )
                    WHERE page_count IS NULL
                      AND content LIKE '%[Page %]%'
                `).run();
                // Phase 2: heuristic for non-marked content (rare — only old
                // pre-round-2 content or non-PDF text). Use 3000 chars/page to
                // match the live ModeContextRetriever heuristic exactly.
                const phaseTwo = db.prepare(`
                    UPDATE mode_reference_files
                    SET page_count = MAX(1, CAST(LENGTH(content) / 3000 AS INTEGER)),
                        extracted_page_count = MAX(1, CAST(LENGTH(content) / 3000 AS INTEGER))
                    WHERE page_count IS NULL
                `).run();
                console.log(`[DatabaseManager] v22 backfill: derived ${phaseOne.changes} rows from [Page N] markers, heuristically estimated ${phaseTwo.changes} remaining rows`);
                // Senior-review fix 2026-07-01: only advance the schema version
                // when BOTH phases complete without throwing. The catch block
                // below now re-throws so we don't get stuck re-running a
                // partial migration on every app start (which would retry
                // any deterministic SQLite failure — e.g. recursion limit on
                // a 5000+ marker pathological doc — forever).
                db.pragma('user_version = 22');
            } catch (e) {
                console.error('[DatabaseManager] v22 backfill migration failed (re-throwing to halt startup so user sees the error):', e);
                throw e;
            }
        }
            return true;
        },
    },

    {
        id: 'v22-to-v23-profile-okf',
        up(ctx) {
            const { db, version } = ctx;
        if (version < 23) {
            // OKF Profile Intelligence upgrade (2026-07-02): the shared knowledge_*
            // tables (v19→v20) were built for MODE reference files — knowledge_sources
            // and knowledge_packs declare `mode_id TEXT NOT NULL` with an FK to
            // modes(id). Profile packs (candidate resume/JD → OKF cards) have no user
            // mode. Rather than fork a parallel table family (explicitly forbidden by
            // the migration brief — "no second OKF stack"), we reserve ONE sentinel
            // mode row, '__profile_okf__', that profile packs hang off. It satisfies
            // the NOT NULL + FK constraint AND is filterable so it never surfaces as a
            // real mode: ModesManager.getModes and every getPacksByModeId caller for
            // document-grounded retrieval query by a USER mode id, never this reserved
            // id, so profile cards can never leak into a document-grounded answer via
            // the mode path. DatabaseManager itself enables `PRAGMA foreign_keys
            // = ON` on this same shared connection at boot (see the pragma setup
            // in connect()), so the FK is genuinely enforced at runtime — the
            // sentinel is required, not cosmetic. template_type '__reserved__'
            // keeps it out of the general/custom template universe.
            //
            // Also add the `pii` marker column to knowledge_cards: profile cards carry
            // pii=1 so downstream tooling (export, UI, any future consumer) can filter
            // PII cards. Reference-file cards keep the default pii=0 — no behavior
            // change for the existing document OKF path.
            console.log('[DatabaseManager] Applying migration v22 → v23: profile OKF (reserved mode + knowledge_cards.pii)');
            const addPiiColumn = () => {
                try {
                    db!.exec(`ALTER TABLE knowledge_cards ADD COLUMN pii INTEGER NOT NULL DEFAULT 0`);
                } catch (e) {
                    // Column already exists (idempotent re-run / older partial migration) — additive ALTER only.
                    const msg = (e as Error)?.message || '';
                    if (!/duplicate column name/i.test(msg)) throw e;
                }
            };
            addPiiColumn();
            db.prepare(`
                INSERT OR IGNORE INTO modes (id, name, template_type, custom_context, is_active, created_at)
                VALUES ('__profile_okf__', 'Profile Intelligence (reserved)', '__reserved__', '', 0, CURRENT_TIMESTAMP)
            `).run();
            db.pragma('user_version = 23');
        }
            return true;
        },
    },

    {
        id: 'v23-to-v24-context-os',
        up(ctx) {
            const { db, version } = ctx;
        // Version 23 → 24: Context OS memory safety (docs/context-os/, Phase 9).
        // assistant_claims separates factual CLAIMS from conversational assistant
        // messages: a claim starts `unverified` and only `verified` claims (with
        // evidence pointers) may ever be re-used as evidence in a later turn.
        // turn_context_contracts persists the privacy-safe per-turn source
        // decision so contamination incidents can be reproduced from the trace.
        // Both tables are ADDITIVE — no existing table or write path changes.
        if (version < 24) {
            console.log('[DatabaseManager] Applying migration v23 → v24: Context OS assistant_claims + turn_context_contracts');
            db.exec(`
                CREATE TABLE IF NOT EXISTS assistant_claims (
                    claim_id TEXT PRIMARY KEY,
                    turn_id TEXT NOT NULL,
                    claim_text TEXT NOT NULL,
                    source_owner TEXT NOT NULL,
                    requested_property TEXT,
                    validation_status TEXT NOT NULL DEFAULT 'unverified',
                    evidence_ids_json TEXT NOT NULL DEFAULT '[]',
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    contradicted_by_claim_id TEXT
                );
                CREATE INDEX IF NOT EXISTS idx_assistant_claims_turn ON assistant_claims(turn_id);
                CREATE INDEX IF NOT EXISTS idx_assistant_claims_status ON assistant_claims(validation_status);

                CREATE TABLE IF NOT EXISTS turn_context_contracts (
                    turn_id TEXT PRIMARY KEY,
                    surface TEXT NOT NULL,
                    active_mode_id TEXT,
                    answer_shape TEXT NOT NULL,
                    source_owner TEXT NOT NULL,
                    requested_property TEXT,
                    allowed_sources_json TEXT NOT NULL DEFAULT '[]',
                    forbidden_sources_json TEXT NOT NULL DEFAULT '[]',
                    memory_write_policy_json TEXT NOT NULL DEFAULT '{}',
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                );
                CREATE INDEX IF NOT EXISTS idx_turn_contracts_surface ON turn_context_contracts(surface);
            `);
            db.pragma('user_version = 24');
        }
            return true;
        },
    },

    {
        id: 'v24-to-v25-source-contract',
        up(ctx) {
            const { db, version } = ctx;
        // Version 24 → 25: persisted ModeSourceContract (real-custom-mode-repair,
        // 2026-07-11). Closes the root cause of the P0 contamination incident:
        // `documentGrounded`/`sourceAuthority` were previously RE-DERIVED on every
        // turn by regex-matching the mode's free-text prompt, so a real user's
        // natural phrasing silently failed to satisfy the detector and modes
        // defaulted to `general_mixed` (everything allowed) with no user
        // visibility. `source_contract_json` stores the explicit, typed,
        // user-editable ModeSourceContract (electron/services/modeSourceContract.ts).
        // NULL means "not yet migrated" — ModesManager migrates it once on first
        // read and persists the result (never re-derives per-turn again).
        if (version < 25) {
            console.log('[DatabaseManager] Applying migration v24 → v25: Add modes.source_contract_json');
            const hasColumn = db.prepare(`PRAGMA table_info(modes)`).all()
                .some((col: any) => col.name === 'source_contract_json');
            if (!hasColumn) {
                db.exec(`ALTER TABLE modes ADD COLUMN source_contract_json TEXT`);
            }
            db.pragma('user_version = 25');
        }
            return true;
        },
    },

    {
        id: 'v25-to-v26-is-builtin',
        up(ctx) {
            const { db, version } = ctx;
        // Version 25 → 26: modes.is_builtin (2026-08-09).
        //
        // Until now there were no default modes. Every row was a user-created
        // `mode_<uuid>` with a freely editable template, including the ones
        // NAMED "General" / "Team Meet" / "Technical Interview", and updateMode
        // would persist any template onto any row. A mode named "Technical
        // Interview" therefore ran as `general` — the one built-in with
        // `profileSources: []` — and the user's résumé was silently out of
        // scope.
        //
        // This migration only ADDS the column. Deciding which existing rows
        // become built-ins reclassifies user data, so that rule lives in
        // services/builtinModes.ts (pure, tested) and is applied once at
        // startup by ModesManager.ensureBuiltinModes() — where seeding can reuse
        // createMode and get note sections and a source contract for free.
        if (version < 26) {
            console.log('[DatabaseManager] Applying migration v25 → v26: Add modes.is_builtin');
            const hasColumn = db.prepare(`PRAGMA table_info(modes)`).all()
                .some((col: any) => col.name === 'is_builtin');
            if (!hasColumn) {
                db.exec(`ALTER TABLE modes ADD COLUMN is_builtin INTEGER NOT NULL DEFAULT 0`);
            }
            db.pragma('user_version = 26');
        }
            return true;
        },
    },

    {
        id: 'v26-to-v27-usage-outbox',
        up(ctx) {
            const { db, version } = ctx;
        // Version 26 → 27: usage_outbox — durable queue for client-reported
        // usage events (2026-08-14, Usage Ledger campaign 2).
        //
        // WHY A DURABLE QUEUE AND NOT fetch-and-forget.
        //
        // The events this carries are the ONLY evidence that a BYOK feature ran.
        // When a customer uses their own provider key, the backend executes
        // nothing and meters nothing, so an event dropped because the laptop was
        // on a plane is not a gap in telemetry — it is the entire record of that
        // session, gone. A fetch() that fails during a network blip loses it
        // silently and forever.
        //
        // WHY IT LIVES HERE rather than in a JSON file or electron-store: this
        // is where the app already keeps durable local state, it is already
        // migrated, already WAL-checkpointed on shutdown, and already survives
        // crash/sleep/restart. A second persistence engine would have to earn
        // all of that again.
        //
        // NOTE ON `status`: 'delivered' rows are kept briefly rather than
        // deleted on ACK, so a duplicate enqueue of the same event_id inside the
        // compaction window is caught by the UNIQUE constraint instead of being
        // re-sent. compactOutbox() removes them after 7 days.
        if (version < 27) {
            console.log('[DatabaseManager] Applying migration v26 → v27: usage_outbox');
            db.exec(`
                CREATE TABLE IF NOT EXISTS usage_outbox (
                    event_id        TEXT PRIMARY KEY,
                    layer           TEXT NOT NULL DEFAULT 'ledger',
                    payload_json    TEXT NOT NULL,
                    status          TEXT NOT NULL DEFAULT 'pending',
                    attempt_count   INTEGER NOT NULL DEFAULT 0,
                    next_retry_at   INTEGER NOT NULL DEFAULT 0,
                    last_error      TEXT,
                    created_at      INTEGER NOT NULL,
                    delivered_at    INTEGER
                );
                CREATE INDEX IF NOT EXISTS usage_outbox_due_idx
                    ON usage_outbox (status, next_retry_at);
                CREATE INDEX IF NOT EXISTS usage_outbox_created_idx
                    ON usage_outbox (created_at);
            `);
            db.pragma('user_version = 27');
        }
            return true;
        },
    },

    {
        id: 'v27-to-v28-user-titled',
        up(ctx) {
            const { db, version } = ctx;
        // user_titled flag on meetings (RC-7, 2026-08-21). A user rename was
        // silently overwritten TWICE: by the post-call title generation in
        // saveMeeting's final write, and unconditionally by
        // replaceDetailedSummary when the deferred V3 summary landed. The flag
        // is set by updateMeetingTitle (the one rename entry point) and makes
        // every generated-title write yield to it.
        //
        // APPLIED UNCONDITIONALLY, NOT VERSION-GATED (live incident,
        // 2026-08-23): this shipped as `if (version < 28)` while a parallel
        // branch's migrations stamped the same numbers first — the live DB was
        // observed at user_version 30 WITHOUT the column, so the gate never
        // ran and EVERY saveMeeting threw "table meetings has no column named
        // user_titled": meetings (including their generated summaries) were
        // silently lost. An additive nullable column is idempotent by
        // construction (the try/catch absorbs "duplicate column"), so it must
        // not depend on a version counter that concurrent branches can race.
        try { db.exec("ALTER TABLE meetings ADD COLUMN user_titled INTEGER DEFAULT 0"); } catch (e) { /* Column already exists */ }
        if (version < 28) {
            db.pragma('user_version = 28');
        }
            return true;
        },
    },

    {
        id: 'v28-to-v29-page-count-repair',
        up(ctx) {
            const { db, version } = ctx;
        // MERGE NOTE (2026-08-23): SECOND renumbering. main advanced and claimed
        // 28 for meetings.user_titled — a real ALTER TABLE — while this branch's
        // page-count repair also sat on 28. Whichever stamped first would have
        // permanently suppressed the other. main is the shared trunk, so it keeps
        // 28 and this branch moved to 29 (page-count repair) and 30 (vec0 cosine
        // rebuild). Neither number was ever released, so no installed profile can
        // be sitting on the old numbering.
        // MERGE NOTE (2026-08-19): main's v26 → v27 (usage_outbox) and this
        // branch's page-count repair BOTH claimed version 27. Whichever ran
        // first would have stamped user_version = 27 and permanently suppressed
        // the other — a user coming from main would never get the page-count
        // repair, and a user from this branch would never get usage_outbox.
        // main is the shared trunk, so it keeps 27 and this branch's two
        // migrations were renumbered to 28 (page-count repair) and 29 (vec0
        // cosine rebuild). This branch was never released, so no installed
        // profile can be sitting on its old 27/28 numbering.
        // Version 27 → 28: REPAIR the page counts corrupted by v22 (F-701/F-702).
        //
        // v22's Phase 1 seeded its recursive CTE from an inner
        // `FROM mode_reference_files`, which shadowed the outer UPDATE row and
        // made its correlation predicate a tautology. The subquery was
        // therefore uncorrelated and wrote the LARGEST page number in the whole
        // table into EVERY marker-bearing row — a 3-page document reporting 6
        // pages. It could not self-heal, because `page_count IS NULL` was false
        // on any re-run. v22 also never set extracted_page_count on those rows
        // (Phase 2 was gated on the same predicate Phase 1 had just falsified),
        // so the extraction-coverage signal was silently absent.
        //
        // This repair re-derives both values from the [Page N] markers, which
        // are ground truth for marker-bearing content. It is unconditional over
        // marker-bearing rows (not gated on IS NULL) precisely because the bad
        // values are non-NULL, and it is idempotent — re-running derives the
        // same counts.
        // CR-06: this repair is gated on `user_version`, the SCHEMA counter, but it
        // changes no schema — it is pure UPDATE over mode_reference_files, and it is
        // idempotent. Conflating the two is the actual modelling error: when the
        // repair failed, the (correct-in-isolation) `return` below also blocked v29's
        // vec0 cosine rebuild FOREVER on that profile, while ensureVecTableForDim
        // keeps creating every NEW dimension table as cosine — leaving one database
        // with mixed metrics read through a single `similarity = 1 - distance` and
        // one shared minSimilarity. That is the exact hazard v29 exists to remove,
        // reached through a different door.
        //
        // So the two are separated: the schema version advances (safe — no schema
        // change here), and the repair records its own pending flag in app_state and
        // retries on later launches until it succeeds. R-05's requirement is
        // preserved (a failed repair is never forgotten); what changes is that a
        // failed DATA repair no longer holds the SCHEMA chain hostage.
        const pageRepairPending = (() => {
            if (version < 29) return true;
            try {
                const row = db.prepare('SELECT value FROM app_state WHERE key = ?')
                    .get(PAGE_COUNT_REPAIR_PENDING_KEY) as { value?: string } | undefined;
                return row?.value === '1';
            } catch (e) {
                // The ONE place this design could lose a retry: if the marker cannot
                // be read we cannot tell "no repair owed" from "repair owed but
                // unreadable", and R-05's requirement is that a failed repair is
                // never forgotten. The repair is a pure idempotent UPDATE, so
                // re-running it when none was owed costs one no-op statement —
                // strictly cheaper than dropping one that WAS owed.
                console.warn('[DatabaseManager] could not read the page-count repair marker; '
                    + 're-running the repair rather than risk forgetting a pending one:', e);
                return true;
            }
        })();

        if (pageRepairPending) {
            console.log('[DatabaseManager] Applying migration v28 → v29: Repair v22 page_count/extracted_page_count corruption');
            try {
                const repaired = db.prepare(`
                    UPDATE mode_reference_files
                    SET page_count = (
                        WITH RECURSIVE cte_pages(rest, page_num) AS (
                            SELECT
                                substr(content, instr(content, '[Page ') + 6),
                                CASE
                                    WHEN instr(content, '[Page ') > 0
                                    THEN CAST(
                                        substr(
                                            content,
                                            instr(content, '[Page ') + 6,
                                            instr(substr(content, instr(content, '[Page ') + 6), ']') - 1
                                        ) AS INTEGER
                                    )
                                    ELSE NULL
                                END
                        UNION ALL
                            SELECT
                                substr(rest, instr(rest, '[Page ') + 6),
                                CASE
                                    WHEN instr(rest, '[Page ') > 0
                                    THEN CAST(
                                        substr(
                                            rest,
                                            instr(rest, '[Page ') + 6,
                                            instr(substr(rest, instr(rest, '[Page ') + 6), ']') - 1
                                        ) AS INTEGER
                                    )
                                    ELSE NULL
                                END
                            FROM cte_pages
                            WHERE instr(rest, '[Page ') > 0
                            LIMIT 5000
                        )
                        SELECT MAX(page_num) FROM cte_pages WHERE page_num IS NOT NULL
                    )
                    -- R-11: scope the re-derive to rows v22 could actually have
                    -- corrupted. v22 Phase 1 ran WHERE page_count IS NULL AND
                    -- content LIKE '%[Page %]%' and set ONLY page_count — it never
                    -- wrote extracted_page_count. The ingestion path writes the two
                    -- TOGETHER (pageCount from data.total, extractedPageCount from
                    -- data.pages). So extracted_page_count IS NULL is the signature
                    -- of a row v22 touched, and its presence is the signature of a
                    -- row that came from ingestion and must be left alone.
                    --
                    -- Without this scope the re-derive was unconditional and
                    -- DOWNGRADED correct values: on the extractor's timeout path
                    -- (SafeDocumentTextExtractor withTimeout -> parser.destroy())
                    -- data.pages is partial while data.total is the true count, so a
                    -- document with a correct page_count of 10 and an honest 3/10
                    -- coverage signal was rewritten to 3/3 — destroying the value AND
                    -- erasing the coverage gap it encoded, which ModeContextRetriever
                    -- consumes as ingested-page coverage.
                    WHERE content LIKE '%[Page %]%'
                      AND extracted_page_count IS NULL
                `).run();
                // Mirror the ingestion path (ipcHandlers writes pageCount and
                // extractedPageCount together) for rows still missing the
                // extraction figure.
                //
                // R-11: scoped to MARKER-BEARING rows. Unscoped, this reached rows
                // v22 never touched and fabricated 100% extraction coverage for
                // documents from which zero page-level text was extracted — a PDF
                // whose data.pages came back empty has page_count from data.total but
                // extractedPageCount undefined -> NULL, and this wrote page_count
                // into it. A marker-less row now keeps NULL, an honest "unknown",
                // rather than claiming full coverage. (A scanned PDF with
                // extracted_page_count = 0 was already safe: `?? null` preserves 0
                // and the IS NULL guard skips it.)
                const filled = db.prepare(`
                    UPDATE mode_reference_files
                    SET extracted_page_count = page_count
                    WHERE extracted_page_count IS NULL
                      AND page_count IS NOT NULL
                      AND content LIKE '%[Page %]%'
                `).run();
                console.log(`[DatabaseManager] v29 repair: re-derived ${repaired.changes} marker-bearing rows, filled ${filled.changes} extracted_page_count values`);
                // Succeeded — clear any pending marker from an earlier failed launch.
                try {
                    db.prepare('DELETE FROM app_state WHERE key = ?').run(PAGE_COUNT_REPAIR_PENDING_KEY);
                } catch { /* the repair itself is what matters */ }
            } catch (e) {
                // R-05 found the original hazard here: this block swallows rather
                // than re-throwing so the repair retries next launch, but `version`
                // is read ONCE into a const, so control fell straight through to the
                // NEXT migration with the stale snapshot — which then succeeded and
                // stamped a version past this one, so the repair never ran again.
                // Re-reading the pragma does not help; the stale const is the point.
                //
                // CR-06 removes the conflict instead of stalling the chain: this
                // repair changes no schema, so the version may advance while the
                // repair itself is recorded as still-owed in its own marker and
                // retried on every later launch. R-05's requirement — a failed
                // repair is never forgotten — is preserved by the marker, not by
                // freezing user_version.
                try {
                    db.prepare('INSERT OR REPLACE INTO app_state (key, value) VALUES (?, ?)')
                        .run(PAGE_COUNT_REPAIR_PENDING_KEY, '1');
                    console.error('[DatabaseManager] page-count repair failed; marked pending and will retry on the next launch. '
                        + 'Later migrations still run — this repair changes no schema:', e);
                } catch (markErr) {
                    // Could not even record the marker, so the retry would be lost.
                    // THEN the original behaviour is right: stop, leave the version
                    // put, and let the whole block run again next launch.
                    console.error('[DatabaseManager] v28 page-count repair failed AND its pending marker could not be written; '
                        + 'leaving version at 27 and skipping later migrations so the repair is not forgotten:', e, markErr);
                    return false;
                }
            }
            if (version < 29) db.pragma('user_version = 29');
        }
            return true;
        },
    },

    {
        id: 'v29-to-v30-vec0-cosine-rebuild',
        up(ctx) {
            const { version } = ctx;
        // Version 28 → 29: rebuild the vec0 tables with distance_metric=cosine (F-410).
        //
        // The tables were created without a distance metric, and sqlite-vec
        // defaults to L2. VectorStore then read that column as if it were a
        // cosine distance (`similarity = 1 - vecRow.distance`) and every
        // consumer thresholded the result as a cosine in [-1,1]: minSimilarity
        // 0.25, MEETING_MIN_SIMILARITY 0.3, MEETING_RAG_MIN_SIMILARITY. For
        // unit vectors L2 = sqrt(2-2cos), so a 0.25 floor silently demanded
        // cos >= 0.719; for NON-unit vectors it is worse still — a vector with
        // identical direction but twice the magnitude scores 0.0 and is
        // dropped outright (measured). The JS fallback computes true cosine and
        // applies the SAME floor, so the two paths disagreed sharply on
        // identical data — and every existing test forces the JS path, which is
        // why the shipped native path was never covered.
        //
        // Ranking order is unaffected for normalized vectors (L2 is monotonic
        // in cosine), which is why this degraded recall silently rather than
        // producing visibly wrong output.
        //
        // vec0 virtual tables cannot be ALTERed, so the metric change requires
        // a drop + recreate + backfill from the embedding BLOBs still held in
        // chunks / chunk_summaries.
        if (version < 30) {
            console.log('[DatabaseManager] Applying migration v29 → v30: rebuild vec0 tables with cosine distance');
            try {
                let rebuilt = 0;
                // R-08: enumerate the dimensions that actually EXIST, not just
                // KNOWN_DIMS ([768, 1536, 3072]). LocalEmbeddingProvider — the
                // offline fallback — is 384-d, so vec_chunks_384 is a real, shipped
                // table on any install that has ever embedded locally. Iterating
                // KNOWN_DIMS left it on L2 forever: the drop skipped it, and the
                // later re-create is `CREATE VIRTUAL TABLE IF NOT EXISTS`, a silent
                // no-op on a surviving table whose persisted DDL carries no
                // distance_metric. The result was MIXED metrics under one shared
                // `similarity = 1 - distance` and one shared threshold — on unit
                // vectors L2 = sqrt(2-2cos), so a 0.25 floor silently demanded
                // cos >= 0.719 on precisely the provider used when the cloud is down.
                // getExistingVecDims() returns KNOWN_DIMS union the discovered ones
                // and its own docstring warns about this exact case; it must be
                // captured BEFORE the drop loop, or discovery finds nothing.
                const dimsToRebuild = ctx.manager.getExistingVecDims();
                // R-13: the drop and the backfill must be ONE unit. v28 was not
                // transactional, so a crash after the drop loop but during the
                // rebuild left the vec0 tables EXISTING BUT EMPTY — and both
                // detectVecSupport (VectorStore.ts:66) and hasVecExtension
                // (:2388) probe with `SELECT count(*) ... LIMIT 1`, which SUCCEEDS
                // on an empty table. useNativeVec stayed true, searchSimilarNative
                // returned [] on zero rows, and there is no JS fallback on an empty
                // result (only on a throw) — a silent, total RAG blackout with no
                // error anywhere. Verified for this build that vec0 DROP TABLE does
                // roll back (3 rows dropped inside a tx, 3 rows present after abort),
                // so the wrap is sound rather than assumed.
                // R-13 follow-up: capture a non-null local. TypeScript does not carry
                // the enclosing method's `this.db` narrowing INTO the arrow function, so
                // every use inside the transaction was TS2531 "Object is possibly null"
                // (CI typecheck caught this; esbuild does not typecheck, so the local
                // build was green). runMigrations() already returns early when this.db
                // is null, so the local is genuinely non-null here.
                const db = ctx.db;
                db.transaction(() => {
                for (const dim of dimsToRebuild) {
                    db.exec(`DROP TABLE IF EXISTS vec_chunks_${dim};`);
                    db.exec(`DROP TABLE IF EXISTS vec_summaries_${dim};`);
                }
                ctx.manager.ensuredDims.clear();
                for (const dim of dimsToRebuild) {
                    ctx.manager.ensureVecTableForDim(dim); // now emits distance_metric=cosine
                    const bytes = dim * 4;
                    const chunkIns = db.prepare(
                        `INSERT OR REPLACE INTO vec_chunks_${dim}(chunk_id, embedding) VALUES (?, ?)`
                    );
                    for (const row of db.prepare(
                        `SELECT id, embedding FROM chunks WHERE embedding IS NOT NULL AND length(embedding) = ?`
                    ).iterate(bytes) as Iterable<any>) {
                        try { chunkIns.run(BigInt(row.id), row.embedding); rebuilt++; } catch { /* skip unusable row */ }
                    }
                    const sumIns = db.prepare(
                        `INSERT OR REPLACE INTO vec_summaries_${dim}(summary_id, embedding) VALUES (?, ?)`
                    );
                    for (const row of db.prepare(
                        `SELECT id, embedding FROM chunk_summaries WHERE embedding IS NOT NULL AND length(embedding) = ?`
                    ).iterate(bytes) as Iterable<any>) {
                        try { sumIns.run(BigInt(row.id), row.embedding); rebuilt++; } catch { /* skip unusable row */ }
                    }
                }
                })();
                console.log(`[DatabaseManager] v30: rebuilt vec0 indexes with cosine distance (${rebuilt} vectors re-inserted)`);
                db.pragma('user_version = 30');
            } catch (e) {
                console.error('[DatabaseManager] v30 vec0 cosine rebuild failed (leaving version at 29 to retry next launch):', e);
                // R-22: stop here, as v28/v29 do. v30 is currently the LAST
                // migration, so falling through is harmless TODAY — which is
                // precisely why it would not stay harmless: the next migration
                // added below would run and stamp user_version past a v30 that
                // never applied, and `version < 30` would be false forever after.
                // That is R-05 verbatim, and R-05 only became reachable because
                // an earlier block was written this same way.
                return false;
            }
        }
            return true;
        },
    },

    {
        id: 'v30-to-v31-is-live',
        up(ctx) {
            const { db, version } = ctx;
        // Version 30 → 31: Live meeting notes. A meetings row is created at
        // meeting Start with is_live=1 so the note exists immediately and
        // survives a crash/quit mid-meeting; transcript + usage are flushed
        // into it periodically while the meeting runs. At Stop the same row is
        // finalized (is_live → 0) and title/summary are generated into it.
        // Orphaned is_live rows (app quit before Stop) are adopted by
        // MeetingPersistence.recoverUnprocessedMeetings on the next launch.
        if (version < 31) {
            console.log('[DatabaseManager] Applying migration v30 → v31: Add is_live to meetings');
            db.pragma('user_version = 31');
        }
            return true;
        },
    },

    {
        id: 'v31-to-v32-folders',
        up(ctx) {
            const { db, version } = ctx;
        // Version 31 → 32: Meeting folders (single-level, Google-Drive style).
        // A `folders` table owns the folder rows; `meetings.folder_id` (nullable,
        // NULL = root / main launcher list) assigns a meeting to a folder.
        // ON DELETE SET NULL is a belt-and-suspenders integrity net — the
        // deleteFolder() method already moves contained meetings to root
        // explicitly inside a transaction, and this FK covers any future raw
        // DELETE of a folder row. The folders table must be created BEFORE the
        // ALTER so the REFERENCES target exists (see the unconditional section
        // below).
        if (version < 32) {
            console.log('[DatabaseManager] Applying migration v31 → v32: Add folders table + meetings.folder_id');
            db.pragma('user_version = 32');
        }
            return true;
        },
    },

    {
        id: 'unconditional-additive-schema',
        up(ctx) {
            const { db } = ctx;
        // ── Unconditional additive schema (NOT version-gated) ─────────────
        // is_live (v31) and folder_id (v32) are applied on EVERY launch — same
        // live-incident lesson as user_titled above (2026-08-23): an additive
        // nullable column is idempotent by construction (the try/catch absorbs
        // "duplicate column"), and a version counter that a parallel branch can
        // race must never be able to suppress it — a missing column here makes
        // EVERY saveMeeting INSERT throw and silently kills meeting
        // persistence. Kept AFTER the version-gated blocks so each gate's body
        // stays self-contained (R-22 chain invariant — the chain-termination
        // parser must see v30's `return` as its last catch). Ordering within
        // this section matters: folders table BEFORE meetings.folder_id (the
        // REFERENCES target).
        db.exec(`
            CREATE TABLE IF NOT EXISTS folders (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            );
        `);
        try { db.exec("ALTER TABLE meetings ADD COLUMN is_live INTEGER DEFAULT 0"); } catch (e) { /* Column already exists */ }
        try { db.exec("ALTER TABLE meetings ADD COLUMN folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL"); } catch (e) { /* Column already exists */ }
        try { db.exec('CREATE INDEX IF NOT EXISTS idx_meetings_folder ON meetings(folder_id)'); } catch (e) { /* Index already exists */ }
            return true;
        },
    },

    {
        id: 'v32-to-v33-two-way-sync',
        up(ctx) {
            const { db, version } = ctx;
        // Version 32 → 33: two-way Supabase sync change tracking.
        //
        // Adds the local half of the two-way sync contract:
        //   * `updated_at` TEXT (ISO-8601 UTC) on every user-data table.
        //   * `sync_tombstones` — a deletion marker is written by a DELETE
        //     trigger for every removed row so the sync engine can propagate
        //     the deletion to Supabase instead of the old push-only upsert
        //     silently resurrecting it.
        //   * INSERT/UPDATE/DELETE triggers stamp `updated_at` with millisecond
        //     precision (strftime %f — CURRENT_TIMESTAMP is second-resolution,
        //     which LWW cannot use) and clear/record tombstones:
        //       - INSERT clears any tombstone for the row id (so the app's
        //         INSERT OR REPLACE pattern — meetings, assistant_claims,
        //         chunk_summaries — does not fake a deletion: REPLACE fires
        //         DELETE then INSERT, and the INSERT trigger undoes the
        //         DELETE trigger's marker for the same id).
        //       - UPDATE stamps only when the app did NOT set updated_at
        //         itself, so a sync pull that writes a remote timestamp is
        //         preserved verbatim (no ping-pong).
        //
        // APPLIED UNCONDITIONALLY, NOT VERSION-GATED (same live-incident
        // lesson as user_titled / is_live / folder_id): the sync engine's
        // writes and the cloud schema depend on these columns existing, and
        // an additive column/trigger is idempotent by construction. The
        // version counter is still advanced for bookkeeping when it is behind.
        const syncedTables: Array<{ table: string; pk: string; hasCreatedAt: boolean }> = [
            { table: 'folders',                 pk: 'id',       hasCreatedAt: true },
            { table: 'meetings',                pk: 'id',       hasCreatedAt: true },
            { table: 'transcripts',             pk: 'id',       hasCreatedAt: false },
            { table: 'ai_interactions',         pk: 'id',       hasCreatedAt: false },
            { table: 'chunks',                  pk: 'id',       hasCreatedAt: true },
            { table: 'chunk_summaries',         pk: 'id',       hasCreatedAt: true },
            { table: 'user_profile',            pk: 'id',       hasCreatedAt: true },
            { table: 'resume_nodes',            pk: 'id',       hasCreatedAt: false },
            { table: 'modes',                   pk: 'id',       hasCreatedAt: true },
            { table: 'mode_reference_files',    pk: 'id',       hasCreatedAt: true },
            { table: 'mode_note_sections',      pk: 'id',       hasCreatedAt: true },
            { table: 'knowledge_sources',       pk: 'id',       hasCreatedAt: true },
            { table: 'knowledge_packs',         pk: 'id',       hasCreatedAt: false }, // has updated_at only
            { table: 'knowledge_cards',         pk: 'id',       hasCreatedAt: false }, // has updated_at only
            { table: 'knowledge_entities',      pk: 'id',       hasCreatedAt: false },
            { table: 'knowledge_relations',     pk: 'id',       hasCreatedAt: true },
            { table: 'knowledge_index_versions', pk: 'id',      hasCreatedAt: true },
            { table: 'knowledge_card_versions', pk: 'id',       hasCreatedAt: true },
            { table: 'assistant_claims',        pk: 'claim_id', hasCreatedAt: true },
            { table: 'turn_context_contracts',  pk: 'turn_id',  hasCreatedAt: true },
        ];

        const stampSql = `strftime('%Y-%m-%dT%H:%M:%fZ','now')`;

        // 1. Deletion-marker table (must exist before the DELETE triggers).
        db.exec(`
            CREATE TABLE IF NOT EXISTS sync_tombstones (
                table_name TEXT NOT NULL,
                row_id TEXT NOT NULL,
                deleted_at TEXT NOT NULL DEFAULT (${stampSql}),
                PRIMARY KEY (table_name, row_id)
            );
            CREATE INDEX IF NOT EXISTS idx_sync_tombstones_deleted_at ON sync_tombstones(deleted_at);
        `);

        for (const t of syncedTables) {
            // 2. updated_at column (knowledge_packs / knowledge_cards /
            //    knowledge_index_versions already have one — absorb the
            //    duplicate-column error exactly like the earlier additive steps).
            try { db.exec(`ALTER TABLE ${t.table} ADD COLUMN updated_at TEXT`); } catch (_e) { /* Column already exists */ }

            // 3. Backfill: inherit created_at where it exists (old rows must
            //    not suddenly look "newer" than their cloud copy), otherwise
            //    stamp now as the baseline.
            const backfill = t.hasCreatedAt
                ? `UPDATE ${t.table} SET updated_at = created_at WHERE updated_at IS NULL`
                : `UPDATE ${t.table} SET updated_at = ${stampSql} WHERE updated_at IS NULL`;
            try { db.exec(backfill); } catch (e) { console.warn(`[DatabaseManager] v33 backfill ${t.table} failed (non-fatal):`, e); }

            // 4. Change-tracking triggers.
            db.exec(`
                CREATE TRIGGER IF NOT EXISTS trg_${t.table}_ai AFTER INSERT ON ${t.table} FOR EACH ROW
                BEGIN
                    UPDATE ${t.table} SET updated_at = ${stampSql}
                        WHERE ${t.pk} = NEW.${t.pk} AND NEW.updated_at IS NULL;
                    DELETE FROM sync_tombstones
                        WHERE table_name = '${t.table}' AND row_id = CAST(NEW.${t.pk} AS TEXT);
                END;

                CREATE TRIGGER IF NOT EXISTS trg_${t.table}_au AFTER UPDATE ON ${t.table} FOR EACH ROW
                WHEN NEW.updated_at IS OLD.updated_at
                BEGIN
                    UPDATE ${t.table} SET updated_at = ${stampSql}
                        WHERE ${t.pk} = NEW.${t.pk};
                END;

                CREATE TRIGGER IF NOT EXISTS trg_${t.table}_ad AFTER DELETE ON ${t.table} FOR EACH ROW
                BEGIN
                    INSERT OR REPLACE INTO sync_tombstones (table_name, row_id, deleted_at)
                    VALUES ('${t.table}', CAST(OLD.${t.pk} AS TEXT), ${stampSql});
                END;
            `);
        }

        if (version < 33) {
            db.pragma('user_version = 33');
        }
            return true;
        },
    },

    {
        id: 'v33-to-v34-cloud-first-sync',
        up(ctx) {
            const { db, version } = ctx;
        // Version 33 → 34: cloud-first (write-through) sync.
        //
        // Supabase is the source of truth while a user is signed in; the local
        // SQLite tables are a cache mirror. So the in-app sync loop needs to
        // know the instant a local write happens:
        //
        //   * `sync_dirty` — per-table monotonic counter. The triggers below
        //     bump it on ANY insert/update/delete of a synced table, and the
        //     sync loop polls it (~1s) and reconciles just the dirty tables
        //     (write-through) instead of waiting for the periodic pull.
        //   * A monotonic `seq` (not a boolean) makes clearing race-free: the
        //     loop captures the seq before syncing and clears only when the
        //     current seq is unchanged, so a write that lands mid-sync keeps
        //     the table dirty for the next tick instead of being skipped.
        //   * The dirty triggers are SEPARATE from the v33 triggers because
        //     the v33 UPDATE trigger only fires when the app did NOT set
        //     updated_at itself — cloud pulls set it explicitly and would
        //     otherwise not mark the table. The extra echo pass those marks
        //     cause is a pure LWW no-op (pull timestamps are preserved), so
        //     it converges to silence.
        //
        // ADDITIVE + IDEMPOTENT (same policy as v32→v33): a fresh install or
        //     an upgraded DB both end up with the same triggers.
        const syncedTables: Array<{ table: string }> = [
            { table: 'folders' },
            { table: 'meetings' },
            { table: 'transcripts' },
            { table: 'ai_interactions' },
            { table: 'chunks' },
            { table: 'chunk_summaries' },
            { table: 'user_profile' },
            { table: 'resume_nodes' },
            { table: 'modes' },
            { table: 'mode_reference_files' },
            { table: 'mode_note_sections' },
            { table: 'knowledge_sources' },
            { table: 'knowledge_packs' },
            { table: 'knowledge_cards' },
            { table: 'knowledge_entities' },
            { table: 'knowledge_relations' },
            { table: 'knowledge_index_versions' },
            { table: 'knowledge_card_versions' },
            { table: 'assistant_claims' },
            { table: 'turn_context_contracts' },
        ];

        db.exec(`
            CREATE TABLE IF NOT EXISTS sync_dirty (
                table_name TEXT PRIMARY KEY,
                seq INTEGER NOT NULL DEFAULT 1
            );
        `);

        for (const t of syncedTables) {
            db.exec(`
                CREATE TRIGGER IF NOT EXISTS trg_${t.table}_di AFTER INSERT ON ${t.table} FOR EACH ROW
                BEGIN
                    INSERT INTO sync_dirty (table_name, seq) VALUES ('${t.table}', 1)
                    ON CONFLICT(table_name) DO UPDATE SET seq = sync_dirty.seq + 1;
                END;

                CREATE TRIGGER IF NOT EXISTS trg_${t.table}_du AFTER UPDATE ON ${t.table} FOR EACH ROW
                BEGIN
                    INSERT INTO sync_dirty (table_name, seq) VALUES ('${t.table}', 1)
                    ON CONFLICT(table_name) DO UPDATE SET seq = sync_dirty.seq + 1;
                END;

                CREATE TRIGGER IF NOT EXISTS trg_${t.table}_dd AFTER DELETE ON ${t.table} FOR EACH ROW
                BEGIN
                    INSERT INTO sync_dirty (table_name, seq) VALUES ('${t.table}', 1)
                    ON CONFLICT(table_name) DO UPDATE SET seq = sync_dirty.seq + 1;
                END;
            `);
        }

        if (version < 34) {
            db.pragma('user_version = 34');
        }
            return true;
        },
    },

];
