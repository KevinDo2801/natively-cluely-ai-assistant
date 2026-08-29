-- ============================================================================
-- Natively cloud schema — migration 0001 (initial)
--
-- Mirrors the local SQLite schema (electron/db/migrations.ts) for the data
-- that is user-owned and worth syncing to Supabase, adapted for Postgres +
-- Supabase Auth multi-tenancy:
--
--   * Every table carries `user_id uuid not null default auth.uid()`
--     referencing auth.users(id) ON DELETE CASCADE.
--   * RLS is enabled on every table with a single "owner can do everything"
--     policy (`user_id = auth.uid()`). The desktop app writes through
--     PostgREST with the signed-in user's JWT (anon key), so each user can
--     only ever touch their own rows. The sync CLI / maintenance paths use
--     the service_role key, which bypasses RLS by design.
--   * Parent tables expose UNIQUE (id, user_id) so child tables can carry a
--     composite FK (parent_id, user_id) — a child row can never reference a
--     parent owned by a different account, even with a colliding local UUID.
--   * SQLite INTEGER 0/1 flags stay INTEGER for parity. SQLite TEXT timestamps
--     become timestamptz (Postgres parses both 'YYYY-MM-DD HH:MM:SS' and ISO
--     '…Z' forms; SQLite CURRENT_TIMESTAMP is UTC).
--   * Embeddings (float32 BLOBs locally) become pgvector `vector` columns
--     (unconstrained dimensionality) paired with an `embedding_dims` column
--     recording each row's real dimension (the app currently emits 768-dim
--     gemini-embedding-2 vectors; local 384/1536/3072 also exist on some
--     installs). pgvector cannot index unconstrained-dim columns, so no ANN
--     index is created yet — a future step can pin a constrained column
--     (<= 2000 dims) and index it.
--
-- NOT synced (intentionally local-only): embedding_queue, app_state,
-- usage_outbox, profile_custom_notes, profile_persona, vec_* virtual tables,
-- mode_reference_chunks, mode_reference_index_state.
--
-- Idempotent: every statement is IF NOT EXISTS / guarded.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Extensions
-- ---------------------------------------------------------------------------
create extension if not exists vector;

-- ---------------------------------------------------------------------------
-- Roles & grants (PostgREST + RLS contract)
-- ---------------------------------------------------------------------------
grant usage on schema public to anon, authenticated, service_role;
grant usage on schema extensions to authenticated;

-- The app always writes with a signed-in user (role `authenticated`).
-- anon deliberately gets NO table grants: there is no public data.
grant select, insert, update, delete on all tables in schema public to authenticated;
alter default privileges in schema public
  grant select, insert, update, delete on tables to authenticated;

-- ---------------------------------------------------------------------------
-- folders
-- ---------------------------------------------------------------------------
create table if not exists public.folders (
    id         text primary key,
    name       text not null,
    created_at timestamptz not null default now(),
    user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
    unique (id, user_id)
);
comment on table public.folders is 'Single-level meeting folders (Google-Drive style).';

-- ---------------------------------------------------------------------------
-- meetings
-- ---------------------------------------------------------------------------
create table if not exists public.meetings (
    id                    text primary key,
    title                 text,
    start_time            bigint,
    duration_ms           bigint,
    summary_json          text,
    created_at            timestamptz not null default now(),
    calendar_event_id     text,
    source                text,
    is_processed          integer not null default 1,
    summary_status        text not null default 'completed',
    embedding_provider    text,
    embedding_dimensions  integer,
    embedding_space       text,
    user_titled           integer not null default 0,
    is_live               integer not null default 0,
    folder_id             text references public.folders (id) on delete set null,
    user_id               uuid not null default auth.uid() references auth.users (id) on delete cascade,
    unique (id, user_id)
);
comment on table public.meetings is 'Meeting notes: title, summary, timing and embedding metadata.';
create index if not exists idx_meetings_folder_id        on public.meetings (folder_id);
create index if not exists idx_meetings_embedding_space  on public.meetings (embedding_space);
create index if not exists idx_meetings_user_id          on public.meetings (user_id);

-- ---------------------------------------------------------------------------
-- transcripts
-- ---------------------------------------------------------------------------
create table if not exists public.transcripts (
    id           bigint primary key,
    meeting_id   text not null,
    speaker      text,
    content      text,
    timestamp_ms bigint,
    user_id      uuid not null default auth.uid() references auth.users (id) on delete cascade,
    foreign key (meeting_id, user_id)
        references public.meetings (id, user_id) on delete cascade
);
comment on table public.transcripts is 'Raw transcript segments of a meeting.';
create index if not exists idx_transcripts_meeting on public.transcripts (meeting_id);
create index if not exists idx_transcripts_user    on public.transcripts (user_id);

-- ---------------------------------------------------------------------------
-- ai_interactions
-- ---------------------------------------------------------------------------
create table if not exists public.ai_interactions (
    id            bigint primary key,
    meeting_id    text not null,
    type          text,
    timestamp     bigint,
    user_query    text,
    ai_response   text,
    metadata_json text,
    user_id       uuid not null default auth.uid() references auth.users (id) on delete cascade,
    foreign key (meeting_id, user_id)
        references public.meetings (id, user_id) on delete cascade
);
comment on table public.ai_interactions is 'Live AI assists + chat turns raised during a meeting.';
create index if not exists idx_ai_interactions_meeting on public.ai_interactions (meeting_id, timestamp);
create index if not exists idx_ai_interactions_user    on public.ai_interactions (user_id);

-- ---------------------------------------------------------------------------
-- chunks (transcript chunks + embeddings)
-- ---------------------------------------------------------------------------
create table if not exists public.chunks (
    id                 bigint primary key,
    meeting_id         text not null,
    chunk_index        integer not null,
    speaker            text,
    start_timestamp_ms bigint,
    end_timestamp_ms   bigint,
    cleaned_text       text not null,
    token_count        integer not null,
    embedding          vector,
    embedding_dims     integer,
    created_at         timestamptz not null default now(),
    user_id            uuid not null default auth.uid() references auth.users (id) on delete cascade,
    foreign key (meeting_id, user_id)
        references public.meetings (id, user_id) on delete cascade
);
comment on table public.chunks is 'Indexable transcript chunks with embeddings (3072-dim float32 vectors).';
create index if not exists idx_chunks_meeting on public.chunks (meeting_id);
create index if not exists idx_chunks_user    on public.chunks (user_id);

-- ---------------------------------------------------------------------------
-- chunk_summaries
-- ---------------------------------------------------------------------------
create table if not exists public.chunk_summaries (
    id             bigint primary key,
    meeting_id     text not null,
    summary_text   text not null,
    embedding      vector,
    embedding_dims integer,
    created_at     timestamptz not null default now(),
    user_id        uuid not null default auth.uid() references auth.users (id) on delete cascade,
    foreign key (meeting_id, user_id)
        references public.meetings (id, user_id) on delete cascade,
    unique (meeting_id, user_id)
);
comment on table public.chunk_summaries is 'One embedded summary per meeting.';
create index if not exists idx_chunk_summaries_user on public.chunk_summaries (user_id);

-- ---------------------------------------------------------------------------
-- user_profile
-- ---------------------------------------------------------------------------
create table if not exists public.user_profile (
    id               integer primary key,
    structured_json  text not null,
    compact_persona  text not null,
    intro_short      text,
    intro_interview  text,
    created_at       timestamptz not null default now(),
    user_id          uuid not null default auth.uid() references auth.users (id) on delete cascade
);
comment on table public.user_profile is 'User''s AI profile/persona (structured JSON + persona text).';
create index if not exists idx_user_profile_user on public.user_profile (user_id);

-- ---------------------------------------------------------------------------
-- resume_nodes
-- ---------------------------------------------------------------------------
create table if not exists public.resume_nodes (
    id              bigint primary key,
    category        text,
    title           text,
    organization    text,
    start_date      text,
    end_date        text,
    duration_months integer,
    text_content    text,
    tags            text,
    embedding       vector,
    embedding_dims  integer,
    user_id         uuid not null default auth.uid() references auth.users (id) on delete cascade
);
comment on table public.resume_nodes is 'Résumé/JD profile nodes with embeddings.';
create index if not exists idx_resume_nodes_user on public.resume_nodes (user_id);

-- ---------------------------------------------------------------------------
-- modes / mode_reference_files / mode_note_sections
-- ---------------------------------------------------------------------------
create table if not exists public.modes (
    id                    text primary key,
    name                  text not null,
    template_type         text not null default 'general',
    custom_context        text not null default '',
    is_active             integer not null default 0,
    created_at            timestamptz not null default now(),
    source_contract_json  text,
    is_builtin            integer not null default 0,
    user_id               uuid not null default auth.uid() references auth.users (id) on delete cascade,
    unique (id, user_id)
);
comment on table public.modes is 'Assistant modes (builtin + user-created).';
create index if not exists idx_modes_user on public.modes (user_id);

create table if not exists public.mode_reference_files (
    id                    text primary key,
    mode_id               text not null,
    file_name             text not null,
    content               text not null default '',
    created_at            timestamptz not null default now(),
    page_count            integer,
    extracted_page_count  integer,
    user_id               uuid not null default auth.uid() references auth.users (id) on delete cascade,
    foreign key (mode_id, user_id)
        references public.modes (id, user_id) on delete cascade
);
comment on table public.mode_reference_files is 'Reference documents attached to a mode.';
create index if not exists idx_mode_reference_files_mode on public.mode_reference_files (mode_id);
create index if not exists idx_mode_reference_files_user on public.mode_reference_files (user_id);

create table if not exists public.mode_note_sections (
    id              text primary key,
    mode_id         text not null,
    title           text not null,
    description     text not null default '',
    sort_order      integer not null default 0,
    compiled_prompt text default '',
    created_at      timestamptz not null default now(),
    user_id         uuid not null default auth.uid() references auth.users (id) on delete cascade,
    foreign key (mode_id, user_id)
        references public.modes (id, user_id) on delete cascade
);
comment on table public.mode_note_sections is 'Note sections a mode''s summary is compiled into.';
create index if not exists idx_mode_note_sections_mode on public.mode_note_sections (mode_id);
create index if not exists idx_mode_note_sections_user on public.mode_note_sections (user_id);

-- ---------------------------------------------------------------------------
-- OKF knowledge system
-- ---------------------------------------------------------------------------
create table if not exists public.knowledge_sources (
    id                     text primary key,
    type                   text not null default 'reference_file',
    file_id                text references public.mode_reference_files (id) on delete cascade,
    mode_id                text references public.modes (id) on delete cascade,
    file_name              text,
    source_checksum        text not null,
    content_hash           text not null,
    created_at             timestamptz not null default now(),
    indexed_at             timestamptz,
    page_count             integer,
    extracted_page_count   integer,
    index_version          text not null default 'knowledge_pack_v1',
    embedding_space        text,
    user_id                uuid not null default auth.uid() references auth.users (id) on delete cascade
);
comment on table public.knowledge_sources is 'OKF knowledge sources (reference files / profile).';
create index if not exists idx_knowledge_sources_file_id on public.knowledge_sources (file_id);
create index if not exists idx_knowledge_sources_mode_id on public.knowledge_sources (mode_id);
create index if not exists idx_knowledge_sources_user    on public.knowledge_sources (user_id);

create table if not exists public.knowledge_packs (
    id            text primary key,
    source_id     text not null references public.knowledge_sources (id) on delete cascade,
    mode_id       text not null references public.modes (id) on delete cascade,
    file_name     text not null,
    index_md      text not null default '',
    stats_json    text not null default '{}',
    pack_version  integer not null default 1,
    generated_by  text not null default 'okf_extractor_v1',
    updated_at    timestamptz not null default now(),
    user_id       uuid not null default auth.uid() references auth.users (id) on delete cascade
);
comment on table public.knowledge_packs is 'OKF knowledge packs generated from a source.';
create index if not exists idx_knowledge_packs_source_id on public.knowledge_packs (source_id);
create index if not exists idx_knowledge_packs_mode_id   on public.knowledge_packs (mode_id);
create index if not exists idx_knowledge_packs_user      on public.knowledge_packs (user_id);

create table if not exists public.knowledge_cards (
    id                      text primary key,
    pack_id                 text not null references public.knowledge_packs (id) on delete cascade,
    source_id               text not null references public.knowledge_sources (id) on delete cascade,
    type                    text not null,
    title                   text not null,
    slug                    text not null,
    concept_id              text not null,
    body                    text not null default '',
    body_markdown           text,
    source_pages_json       text not null default '[]',
    source_sections_json    text not null default '[]',
    source_quotes_json      text not null default '[]',
    entities_json           text not null default '[]',
    tags_json               text not null default '[]',
    related_card_ids_json   text not null default '[]',
    confidence              text not null default 'medium',
    generated_from          text not null default 'pdf_extraction',
    source_checksum         text not null,
    user_edited             integer not null default 0,
    approval_status         text not null default 'generated',
    pii                     integer not null default 0,
    updated_at              timestamptz not null default now(),
    card_version            integer not null default 1,
    user_id                 uuid not null default auth.uid() references auth.users (id) on delete cascade
);
comment on table public.knowledge_cards is 'OKF knowledge cards (generated + user-edited).';
create index if not exists idx_knowledge_cards_pack_id    on public.knowledge_cards (pack_id);
create index if not exists idx_knowledge_cards_source_id  on public.knowledge_cards (source_id);
create index if not exists idx_knowledge_cards_concept_id on public.knowledge_cards (concept_id);
create index if not exists idx_knowledge_cards_type       on public.knowledge_cards (type);
create index if not exists idx_knowledge_cards_user       on public.knowledge_cards (user_id);

create table if not exists public.knowledge_entities (
    id                    text primary key,
    pack_id               text not null references public.knowledge_packs (id) on delete cascade,
    slug                  text not null,
    name                  text not null,
    type                  text not null default 'concept',
    aliases_json          text not null default '[]',
    description           text not null default '',
    source_card_ids_json  text not null default '[]',
    source_pages_json     text not null default '[]',
    first_seen_at         timestamptz not null default now(),
    user_id               uuid not null default auth.uid() references auth.users (id) on delete cascade
);
comment on table public.knowledge_entities is 'OKF knowledge entities.';
create index if not exists idx_knowledge_entities_pack_id on public.knowledge_entities (pack_id);
create index if not exists idx_knowledge_entities_slug    on public.knowledge_entities (slug);
create index if not exists idx_knowledge_entities_user    on public.knowledge_entities (user_id);

create table if not exists public.knowledge_relations (
    id                    text primary key,
    pack_id               text not null references public.knowledge_packs (id) on delete cascade,
    subject_id            text not null,
    subject_type          text not null,
    predicate             text not null,
    object_id             text not null,
    object_type           text not null,
    source_card_ids_json  text not null default '[]',
    source_pages_json     text not null default '[]',
    confidence            text not null default 'medium',
    created_at            timestamptz not null default now(),
    user_id               uuid not null default auth.uid() references auth.users (id) on delete cascade
);
comment on table public.knowledge_relations is 'OKF relations between entities.';
create index if not exists idx_knowledge_relations_pack_id   on public.knowledge_relations (pack_id);
create index if not exists idx_knowledge_relations_subject_id on public.knowledge_relations (subject_id);
create index if not exists idx_knowledge_relations_user      on public.knowledge_relations (user_id);

create table if not exists public.knowledge_index_versions (
    id              text primary key,
    source_id       text not null references public.knowledge_sources (id) on delete cascade,
    pack_id         text,
    pack_version    integer not null default 1,
    content_hash    text not null,
    embedding_space text,
    status          text not null default 'pending',
    error_message   text,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now(),
    user_id         uuid not null default auth.uid() references auth.users (id) on delete cascade
);
comment on table public.knowledge_index_versions is 'OKF indexing runs per source.';
create index if not exists idx_knowledge_index_versions_source_id on public.knowledge_index_versions (source_id);
create index if not exists idx_knowledge_index_versions_user      on public.knowledge_index_versions (user_id);

create table if not exists public.knowledge_card_versions (
    id            text primary key,
    card_id       text not null references public.knowledge_cards (id) on delete cascade,
    card_version  integer not null,
    title         text not null,
    body          text not null,
    entities_json text not null default '[]',
    tags_json     text not null default '[]',
    confidence    text not null default 'medium',
    edited_by     text not null default 'system',
    edit_reason   text,
    created_at    timestamptz not null default now(),
    user_id       uuid not null default auth.uid() references auth.users (id) on delete cascade
);
comment on table public.knowledge_card_versions is 'Version history for knowledge cards.';
create index if not exists idx_knowledge_card_versions_card_id on public.knowledge_card_versions (card_id);
create index if not exists idx_knowledge_card_versions_user    on public.knowledge_card_versions (user_id);

-- ---------------------------------------------------------------------------
-- Context OS (assistant memory)
-- ---------------------------------------------------------------------------
create table if not exists public.assistant_claims (
    claim_id                 text primary key,
    turn_id                  text not null,
    claim_text               text not null,
    source_owner             text not null,
    requested_property       text,
    validation_status        text not null default 'unverified',
    evidence_ids_json        text not null default '[]',
    created_at               timestamptz not null default now(),
    contradicted_by_claim_id text,
    user_id                  uuid not null default auth.uid() references auth.users (id) on delete cascade
);
comment on table public.assistant_claims is 'Context OS factual claims (verified/unverified).';
create index if not exists idx_assistant_claims_turn   on public.assistant_claims (turn_id);
create index if not exists idx_assistant_claims_status on public.assistant_claims (validation_status);
create index if not exists idx_assistant_claims_user   on public.assistant_claims (user_id);

create table if not exists public.turn_context_contracts (
    turn_id                text primary key,
    surface                text not null,
    active_mode_id         text,
    answer_shape           text not null,
    source_owner           text not null,
    requested_property     text,
    allowed_sources_json   text not null default '[]',
    forbidden_sources_json text not null default '[]',
    memory_write_policy_json text not null default '{}',
    created_at             timestamptz not null default now(),
    user_id                uuid not null default auth.uid() references auth.users (id) on delete cascade
);
comment on table public.turn_context_contracts is 'Context OS per-turn source-decision traces.';
create index if not exists idx_turn_contracts_surface on public.turn_context_contracts (surface);
create index if not exists idx_turn_contracts_user    on public.turn_context_contracts (user_id);

-- ---------------------------------------------------------------------------
-- Row Level Security — every table: owner-only access
-- ---------------------------------------------------------------------------
do $$
declare
    tbl text;
begin
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
        execute format('alter table public.%I enable row level security', tbl);
        execute format('drop policy if exists %I on public.%I', tbl || '_owner_all', tbl);
        execute format(
            'create policy %I on public.%I for all '
            || 'using (user_id = auth.uid()) with check (user_id = auth.uid())',
            tbl || '_owner_all',
            tbl
        );
    end loop;
end $$;
