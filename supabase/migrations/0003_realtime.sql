-- ============================================================================
-- Natively cloud schema — migration 0003 (Realtime change notifications)
--
-- Adds every synced user-data table to the `supabase_realtime` publication so
-- the desktop app can subscribe to INSERT/UPDATE/DELETE events and reconcile
-- the affected table immediately, instead of waiting for the 60s full
-- reconcile (which stays as the safety net — Realtime does not replay events
-- missed while a socket is disconnected).
--
-- Realtime postgres_changes only broadcasts tables that are members of this
-- publication, and delivery is still filtered by RLS: a subscriber only
-- receives events for rows its JWT may SELECT. Adding a table here therefore
-- never leaks rows across accounts — it only makes already-visible changes
-- arrive faster.
--
-- Idempotent: re-running skips tables that are already members.
--
-- NOTE: DDL on a publication requires the postgres role. Apply via the SQL
-- editor or scripts/supabase/apply-sql.cjs (Management API, which runs as
-- postgres); the service_role key alone cannot run this.
-- ============================================================================

do $$
declare
    tbl text;
begin
    if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
        raise exception 'supabase_realtime publication is missing — enable Realtime for this project first';
    end if;

    foreach tbl in array array[
        'folders',
        'meetings',
        'transcripts',
        'ai_interactions',
        'chunks',
        'chunk_summaries',
        'user_profile',
        'resume_nodes',
        'modes',
        'mode_reference_files',
        'mode_note_sections',
        'knowledge_sources',
        'knowledge_packs',
        'knowledge_cards',
        'knowledge_entities',
        'knowledge_relations',
        'knowledge_index_versions',
        'knowledge_card_versions',
        'assistant_claims',
        'turn_context_contracts'
    ] loop
        if not exists (
            select 1 from pg_publication_tables
            where pubname = 'supabase_realtime'
              and schemaname = 'public'
              and tablename = tbl
        ) then
            execute format('alter publication supabase_realtime add table public.%I', tbl);
        end if;
    end loop;
end $$;
