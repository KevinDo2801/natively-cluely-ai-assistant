-- ============================================================================
-- Natively cloud schema — migration 0005 (skew-proof incremental watermarks)
--
-- WHY THIS EXISTS
--
-- Migration 0004 made the incremental engine's delta queries fast. This one
-- makes them CORRECT in the presence of clock skew.
--
-- v35's cloud watermark is a timestamp: the engine reads `updated_at > lastSeen`
-- where `lastSeen` is derived from the app's own clock. `updated_at` is written
-- by whoever makes the change — PostgREST defaults and dashboard edits use the
-- server clock, but the desktop app stamps its OWN clock (the LWW contract in
-- `electron/services/supabaseSyncEngine.js` relies on that). So a device whose
-- clock runs behind by more than the watermark margin writes rows BELOW the
-- watermark, and those rows are never in a delta: they waited for the 12-hour
-- full rescan. No margin fixes this in general — a timestamp watermark is only
-- ever as good as the clocks that feed it.
--
-- A server-assigned monotonic sequence has no such failure mode. One sequence
-- serves every table; a BEFORE INSERT OR UPDATE trigger stamps `sync_seq` with
-- `nextval()`, so a row written later ALWAYS has a strictly higher sequence than
-- any row written earlier, whatever any machine's clock says. The engine's delta
-- becomes `sync_seq > lastSeq`, which needs no margin, no overlap window, and no
-- wall-clock comparison at all.
--
-- `updated_at` keeps its job untouched: it remains the last-write-wins conflict
-- key. The two serve different purposes and must not be conflated.
--
-- COMPATIBILITY
--
-- The app probes for `sync_seq` once per process and falls back to the v35
-- timestamp watermark when this migration has not been applied, so applying it
-- is an optimisation the operator can make at any time — and skipping it is
-- safe (correct, only slower to converge under severe skew).
--
-- The trigger overwrites any client-supplied value, so a device cannot spoof its
-- way past another device's watermark.
--
-- Idempotent: `create or replace trigger` (PostgreSQL 14+; this project is 17.6)
-- plus guarded column/index creation. Apply via the SQL editor or
-- scripts/supabase/apply-sql.cjs (Management API, which runs as postgres) —
-- DDL on a sequence and triggers needs the postgres role.
-- ============================================================================

-- One sequence for the whole schema. Sequences are non-transactional, so a
-- rolled-back write leaves a gap — harmless: the engine only ever needs
-- monotonicity, never contiguity.
create sequence if not exists public.sync_seq as bigint;

-- The writer must be able to call nextval() from a non-trigger path. The trigger
-- itself does NOT depend on this grant (it is SECURITY DEFINER, below), which is
-- deliberate: a grant is easy to miss, and every insert/update of every synced
-- table would fail if it were. This is belt-and-braces.
grant usage, select on sequence public.sync_seq to authenticated;
grant usage, select on sequence public.sync_seq to service_role;

-- SECURITY DEFINER so the assigned sequence never depends on the caller's grants.
-- A trigger function only ever runs from the trigger it belongs to, assigns one
-- value from one sequence, runs no dynamic SQL and takes no user input, so
-- running it as the owner is safe. `set search_path` is the standard hardening
-- for a definer function (everything it touches is schema-qualified anyway).
create or replace function public.sync_touch_seq()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
    -- Always the server's sequence, never the client's value.
    new.sync_seq := nextval('public.sync_seq');
    return new;
end;
$$;

do $$
declare
    t text;
    has_seq boolean;
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
        'turn_context_contracts',
        'sync_tombstones'
    ] loop
        -- Skip tables this project does not have (a partially-migrated project
        -- must not fail the whole migration).
        if not exists (
            select 1 from information_schema.tables
            where table_schema = 'public' and table_name = t
        ) then
            continue;
        end if;

        -- The DEFAULT matters: it covers any insert path that bypasses the
        -- trigger (bulk loads, SQL editor, future server-side code), so a row
        -- can never be written with a NULL or stale sequence. For an existing
        -- table the volatile default is evaluated per row, which backfills the
        -- current contents with increasing values.
        select exists (
            select 1 from information_schema.columns
            where table_schema = 'public' and table_name = t and column_name = 'sync_seq'
        ) into has_seq;
        if not has_seq then
            execute format(
                'alter table public.%I add column sync_seq bigint not null default nextval(''public.sync_seq'')',
                t
            );
        end if;

        -- Delta index. Tombstones are read one table_name at a time, so they get
        -- the narrower-keyed variant; business tables are read per user.
        if t = 'sync_tombstones' then
            execute format(
                'create index if not exists %I on public.%I (user_id, table_name, sync_seq)',
                'idx_' || t || '_user_table_seq', t
            );
        else
            execute format(
                'create index if not exists %I on public.%I (user_id, sync_seq)',
                'idx_' || t || '_user_seq', t
            );
        end if;

        execute format(
            'create or replace trigger %I before insert or update on public.%I
               for each row execute function public.sync_touch_seq()',
            'trg_' || t || '_sync_seq', t
        );
    end loop;
end $$;

comment on sequence public.sync_seq is
    'Monotonic sequence driving the incremental sync watermarks (migration 0005). Server-assigned on every insert/update by trg_*_sync_seq.';
comment on function public.sync_touch_seq() is
    'Stamps NEW.sync_seq from public.sync_seq on insert/update so the desktop app can compute an exact, clock-independent sync delta. SECURITY DEFINER so it never depends on the caller''s sequence grants.';

-- ---------------------------------------------------------------------------
-- Self-verification.
--
-- The app probes for the `sync_seq` COLUMN, so a partially-applied migration
-- would look healthy while the column silently stopped advancing — which would
-- make other devices miss rows until their 12h full rescan. Fail loudly here
-- instead, at apply time, where it can still be fixed in one command.
-- ---------------------------------------------------------------------------
do $$
declare
    fn_secdef boolean;
    tbl_count int;
    trg_count int;
begin
    select p.prosecdef into fn_secdef from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'sync_touch_seq';
    if fn_secdef is null then
        raise exception '0005 verification failed: public.sync_touch_seq() does not exist';
    end if;
    if not fn_secdef then
        raise exception '0005 verification failed: sync_touch_seq() is not SECURITY DEFINER, so every write would fail whenever the caller lacks USAGE on public.sync_seq';
    end if;

    select count(*) into tbl_count from information_schema.columns
     where table_schema = 'public' and column_name = 'sync_seq';

    select count(*) into trg_count
      from pg_trigger g
      join pg_class c on c.oid = g.tgrelid
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and not g.tgisinternal and g.tgname like 'trg\_%\_sync_seq';

    if tbl_count = 0 then
        raise exception '0005 verification failed: no sync_seq column was created';
    end if;
    if trg_count <> tbl_count then
        raise exception '0005 verification failed: % column(s) carry sync_seq but % trigger(s) maintain it', tbl_count, trg_count;
    end if;

    raise notice '0005 verified: sync_seq on % table(s), each with a SECURITY DEFINER trigger', trg_count;
end $$;
