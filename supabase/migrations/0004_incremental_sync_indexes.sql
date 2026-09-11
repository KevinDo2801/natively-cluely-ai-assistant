-- ============================================================================
-- Natively cloud schema — migration 0004 (incremental sync indexes)
--
-- The incremental sync engine (client v2.9.9+, local migration v35) no longer
-- reads whole tables. Every cloud read is now filtered:
--
--   select … from public.<table>
--     where user_id = $1 and updated_at > $2        -- the row delta
--   select … from public.sync_tombstones
--     where user_id = $1 and table_name = $2 and deleted_at > $3   -- the deletions
--
-- Without an index those predicates are sequential scans on every reconcile —
-- once per table per minute, per device — which is pure database CPU and, on a
-- large table, worse than the full read it replaced. The composite indexes
-- below make each delta a small index range scan.
--
-- Why (user_id, updated_at) and not just (updated_at): RLS already scopes every
-- query to `user_id = auth.uid()`, so user_id is an equality predicate in the
-- plan and must lead the index; updated_at is the range that follows it. The
-- same shape serves the `.in(pk, keys)` back-fill via the primary key.
--
-- sync_tombstones gets the deletion equivalent, including `table_name`, because
-- the engine reads one table's tombstones at a time.
--
-- Idempotent: `if not exists` everywhere, and the column-existence guards make
-- it safe to run before/after any other migration. Applied via the SQL editor or
-- scripts/supabase/apply-sql.cjs (Management API, which runs as postgres).
--
-- NOTE: these are plain CREATE INDEX (not CONCURRENTLY) because CONCURRENTLY
-- cannot run inside a DO block. Each statement takes a brief ACCESS EXCLUSIVE
-- lock on its table — negligible at the sizes this schema operates at, and this
-- migration runs once. A future migration on a very large live table should use
-- a standalone CONCURRENTLY statement outside the DO block instead.
-- ============================================================================

do $$
declare
    t text;
begin
    foreach t in array array[
        'folders',
        'user_profile',
        'resume_nodes',
        'modes',
        'mode_note_sections',
        'mode_reference_files',
        'meetings',
        'transcripts',
        'ai_interactions',
        'chunks',
        'chunk_summaries',
        'knowledge_sources',
        'knowledge_packs',
        'knowledge_cards',
        'knowledge_card_versions',
        'knowledge_entities',
        'knowledge_relations',
        'knowledge_index_versions',
        'assistant_claims',
        'turn_context_contracts'
    ] loop
        -- Only index a table that actually exists and carries both columns; a
        -- project that never ran 0001/0002 must not fail this migration.
        if exists (
            select 1 from information_schema.columns
            where table_schema = 'public' and table_name = t and column_name = 'user_id'
        ) and exists (
            select 1 from information_schema.columns
            where table_schema = 'public' and table_name = t and column_name = 'updated_at'
        ) then
            execute format(
                'create index if not exists %I on public.%I (user_id, updated_at)',
                'idx_' || t || '_user_updated_at',
                t
            );
        end if;
    end loop;

    -- Deletion deltas: one table's markers at a time, newest last.
    if exists (
        select 1 from information_schema.tables
        where table_schema = 'public' and table_name = 'sync_tombstones'
    ) then
        execute 'create index if not exists idx_sync_tombstones_user_table_deleted '
             || 'on public.sync_tombstones (user_id, table_name, deleted_at)';
    end if;
end $$;

-- 0002's single-column (user_id) index is now a redundant prefix of the
-- composite index above — the planner can use the composite for a bare
-- `user_id = ?` predicate too. Dropped so every tombstone push does not maintain
-- two indexes; tombstones are pushed in large batches (this project measured a
-- 61k-row ledger), so the write saving is real. Re-applying 0002 would recreate
-- it, which is harmless — this migration is where it gets cleaned up again.
drop index if exists public.idx_sync_tombstones_user;
