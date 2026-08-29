-- ============================================================================
-- Natively cloud schema — migration 0002 (two-way sync)
--
-- Adds the change-tracking pieces the two-way sync engine needs:
--
--   * `updated_at timestamptz` on every user-data table (LWW conflict
--     resolution compares this against the local SQLite `updated_at`).
--   * `sync_tombstones` — deletion markers. When a device deletes a row, the
--     local DELETE trigger records (table_name, row_id, deleted_at); the sync
--     engine mirrors that marker here and removes the row everywhere, so a
--     deletion on one device propagates to every other device. A row edit
--     strictly NEWER than its tombstone revives the row (deletion must be
--     strictly newer than the last edit to win).
--
-- Backfill: existing rows inherit their created_at as updated_at so the first
-- two-way sync does not treat the migration itself as an edit.
--
-- Idempotent: safe to re-run.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- updated_at on every user-data table (skip the ones that already have it)
-- ---------------------------------------------------------------------------
do $$
declare
    t text;
begin
    foreach t in array array[
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
            select 1 from information_schema.columns
            where table_schema = 'public' and table_name = t and column_name = 'updated_at'
        ) then
            execute format('alter table public.%I add column updated_at timestamptz not null default now()', t);
        end if;
    end loop;
end $$;

-- Backfill updated_at from created_at where that column exists. Tables without
-- created_at (transcripts, ai_interactions, resume_nodes) keep the ALTER-time
-- now() default; the next device sync stamps its own baseline over it.
update public.folders                  set updated_at = created_at where created_at is not null;
update public.meetings                 set updated_at = created_at where created_at is not null;
update public.chunks                   set updated_at = created_at where created_at is not null;
update public.chunk_summaries          set updated_at = created_at where created_at is not null;
update public.user_profile             set updated_at = created_at where created_at is not null;
update public.modes                    set updated_at = created_at where created_at is not null;
update public.mode_reference_files     set updated_at = created_at where created_at is not null;
update public.mode_note_sections       set updated_at = created_at where created_at is not null;
update public.knowledge_sources        set updated_at = created_at where created_at is not null;
update public.knowledge_entities       set updated_at = first_seen_at where first_seen_at is not null;
update public.knowledge_relations      set updated_at = created_at where created_at is not null;
update public.knowledge_card_versions  set updated_at = created_at where created_at is not null;
update public.assistant_claims         set updated_at = created_at where created_at is not null;
update public.turn_context_contracts   set updated_at = created_at where created_at is not null;

-- ---------------------------------------------------------------------------
-- sync_tombstones — deletion markers (one row per deleted user row)
-- ---------------------------------------------------------------------------
create table if not exists public.sync_tombstones (
    user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
    table_name text not null,
    row_id     text not null,
    deleted_at timestamptz not null default now(),
    primary key (user_id, table_name, row_id)
);
comment on table public.sync_tombstones is 'Deletion markers propagated by the two-way sync engine.';
create index if not exists idx_sync_tombstones_user on public.sync_tombstones (user_id);

alter table public.sync_tombstones enable row level security;
drop policy if exists sync_tombstones_owner_all on public.sync_tombstones;
create policy sync_tombstones_owner_all on public.sync_tombstones
    for all
    using (user_id = auth.uid())
    with check (user_id = auth.uid());

grant select, insert, update, delete on public.sync_tombstones to authenticated;
