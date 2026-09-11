-- ============================================================================
-- Natively cloud schema — migration 0006 (deletions made outside the app)
--
-- THE HOLE THIS CLOSES
--
-- Deletions propagate through `sync_tombstones`, and every tombstone is written
-- by a DEVICE: the app's SQLite DELETE trigger records the marker locally and the
-- sync engine mirrors it up. Nothing on the server ever records one.
--
-- So a row deleted on the server — in the Supabase table editor, in the SQL
-- editor, by a cleanup script — leaves no marker. Every device still holds its
-- copy, sees no cloud row and no tombstone for that key, and concludes the cloud
-- never had the row: the next reconcile PUSHES IT BACK. The row reappears, in
-- every device and in the dashboard, apparently unable to be deleted. Worse, the
-- same happens to a CASCADE: deleting one parent meeting removes its transcripts
-- on the server, and all of them come back on the next pass.
--
-- Migration 0005 added the same class of server-side trigger for updates
-- (`sync_seq`). This one adds it for deletes: an AFTER DELETE trigger on every
-- synced table records the tombstone, so a server-side delete becomes an ordinary
-- propagated deletion.
--
-- WHY SECURITY DEFINER IS SAFE HERE
--
-- The function runs as its owner, which bypasses RLS on `sync_tombstones`. That
-- is not a privilege escalation: the trigger only fires when a row has already
-- been DELETEd, deleting a row requires the caller to pass that table's RLS
-- USING policy, and the marker it writes takes `user_id` from the deleted row
-- itself (never from the caller). A user therefore cannot create a tombstone for
-- a row they could not already delete.
--
-- The trigger deliberately does NOT go on `sync_tombstones` itself: markers are
-- updated by the sync engine (a newer marker wins) and a marker must never
-- produce a marker of its own.
--
-- Idempotent: `create or replace trigger` for each table (PostgreSQL 14+;
-- this project is 17.6). Apply via the SQL editor or
-- scripts/supabase/apply-sql.cjs (Management API, which runs as postgres).
-- ============================================================================

create or replace function public.sync_touch_tombstone()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
    pk_name text := TG_ARGV[0];
    row_owner uuid;
    deleted_id text;
begin
    -- to_jsonb avoids dynamic SQL entirely: the primary-key column name is
    -- supplied per table as a trigger argument, and every synced table has a
    -- `user_id`.
    deleted_id := to_jsonb(OLD) ->> pk_name;
    row_owner := nullif(to_jsonb(OLD) ->> 'user_id', '')::uuid;

    if deleted_id is null or row_owner is null then
        -- Defensive: a row without an owner cannot be attributed to a device.
        -- Deleting it changes nothing for any user, so skip rather than guess.
        return OLD;
    end if;

    insert into public.sync_tombstones (user_id, table_name, row_id, deleted_at)
    values (row_owner, TG_TABLE_NAME, deleted_id, now())
    on conflict (user_id, table_name, row_id) do update
       -- Never move a marker backwards: the newest deletion wins, and a device
       -- may already have pushed a newer one from its own clock.
       set deleted_at = greatest(public.sync_tombstones.deleted_at, excluded.deleted_at);

    return OLD;
end;
$$;

do $$
declare
    rec record;
    tbl_count int := 0;
    trg_count int := 0;
begin
    -- (table, primary-key column) for every synced table. The pk name is not
    -- always `id`: the Context OS tables use claim_id / turn_id.
    for rec in
        select * from (values
            ('folders',                  'id'),
            ('user_profile',             'id'),
            ('resume_nodes',             'id'),
            ('modes',                    'id'),
            ('mode_note_sections',       'id'),
            ('mode_reference_files',     'id'),
            ('meetings',                 'id'),
            ('transcripts',              'id'),
            ('ai_interactions',          'id'),
            ('chunks',                   'id'),
            ('chunk_summaries',          'id'),
            ('knowledge_sources',        'id'),
            ('knowledge_packs',          'id'),
            ('knowledge_cards',          'id'),
            ('knowledge_card_versions',  'id'),
            ('knowledge_entities',       'id'),
            ('knowledge_relations',      'id'),
            ('knowledge_index_versions', 'id'),
            ('assistant_claims',         'claim_id'),
            ('turn_context_contracts',   'turn_id')
        ) as t(table_name, pk_column)
    loop
        -- Skip anything this project does not have or that lacks the columns the
        -- trigger needs; a partially-migrated project must not fail here.
        if not exists (
            select 1 from information_schema.columns
            where table_schema = 'public' and table_name = rec.table_name and column_name = rec.pk_column
        ) or not exists (
            select 1 from information_schema.columns
            where table_schema = 'public' and table_name = rec.table_name and column_name = 'user_id'
        ) then
            continue;
        end if;

        execute format(
            'create or replace trigger %I after delete on public.%I
               for each row execute function public.sync_touch_tombstone(%L)',
            'trg_' || rec.table_name || '_del_tombstone', rec.table_name, rec.pk_column
        );
        tbl_count := tbl_count + 1;
    end loop;

    select count(*) into trg_count
      from pg_trigger g
      join pg_class c on c.oid = g.tgrelid
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and not g.tgisinternal and g.tgname like 'trg\_%\_del_tombstone';

    if trg_count <> tbl_count then
        raise exception '0006 verification failed: % table(s) eligible but % trigger(s) created', tbl_count, trg_count;
    end if;

    raise notice '0006 verified: % delete-tombstone trigger(s) installed', trg_count;
end $$;

comment on function public.sync_touch_tombstone() is
    'Records a sync_tombstones marker for a row deleted on the server, so a deletion made outside the app (dashboard, SQL, cascade) propagates to devices instead of being pushed back. SECURITY DEFINER; the marker owner comes from the deleted row, not the caller.';
