-- =============================================================
-- Life Dashboard — full Supabase schema (all phases)
-- Run this once in the Supabase SQL editor (paste + Run).
-- Safe to re-run: everything is IF NOT EXISTS / idempotent.
--
-- RLS is intentionally left DISABLED on every table: this is a
-- single-user dashboard and the owner explicitly chose to skip
-- auth. The publishable key has full read/write.
-- =============================================================

-- Extensions ---------------------------------------------------
create extension if not exists vector;    -- pgvector — Obsidian second-brain RAG (phases 6-7)
create extension if not exists pgcrypto;  -- gen_random_uuid()

-- 0. localStorage sync (already used by sync.js) ---------------
create table if not exists public.app_state (
  key        text primary key,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
do $$ begin
  alter publication supabase_realtime add table public.app_state;
exception when duplicate_object then null; end $$;

-- 1. Zepp / Amazfit Helio Strap (phase 2) ----------------------
-- Filled by api/zepp-sync.js (daily Vercel cron). A night is
-- keyed on its wake-up date.
create table if not exists public.zepp_sleep (
  date        date primary key,
  sleep_start timestamptz,
  sleep_end   timestamptz,
  deep_min    integer,
  light_min   integer,
  rem_min     integer,
  awake_min   integer,
  score       integer,
  raw         jsonb           -- untouched API payload, kept for re-parsing
);

create table if not exists public.zepp_daily (
  date        date primary key,
  steps       integer,
  distance_m  integer,
  calories    integer,
  resting_hr  integer,
  hrv         integer,
  stress      integer,
  raw         jsonb
);

create table if not exists public.zepp_heart (
  ts  timestamptz primary key,
  bpm integer not null
);

-- 2. Mood — How We Feel style check-ins (phase 3) --------------
create table if not exists public.mood_checkins (
  id         uuid primary key default gen_random_uuid(),
  ts         timestamptz not null default now(),
  quadrant   text not null check (quadrant in ('yellow','red','blue','green')),
  emotion    text not null,
  tags       text[] not null default '{}',
  note       text,
  weather    jsonb,
  sleep_date date references public.zepp_sleep(date)
);
create index if not exists mood_checkins_ts_idx on public.mood_checkins (ts desc);

-- 3. Nutrition — MyFitnessPal-style macros (phase 4) -----------
create table if not exists public.food_logs (
  id        uuid primary key default gen_random_uuid(),
  ts        timestamptz not null default now(),
  meal      text not null check (meal in ('breakfast','lunch','dinner','snack')),
  name      text not null,
  quantity  text,
  kcal      numeric,
  protein_g numeric,
  carbs_g   numeric,
  fat_g     numeric,
  source    text not null default 'manual'
            check (source in ('photo','text','library','barcode','manual'))
);
create index if not exists food_logs_ts_idx on public.food_logs (ts desc);

create table if not exists public.food_library (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  quantity   text,
  kcal       numeric,
  protein_g  numeric,
  carbs_g    numeric,
  fat_g      numeric,
  times_used integer not null default 0
);

create table if not exists public.weight_logs (
  date      date primary key,
  weight_kg numeric not null
);

-- 4. Climbing (phase 5) ----------------------------------------
create table if not exists public.climb_sessions (
  id           uuid primary key default gen_random_uuid(),
  date         date not null,
  location     text,
  kind         text not null check (kind in ('boulder','rope')),
  duration_min integer,
  notes        text
);
create index if not exists climb_sessions_date_idx on public.climb_sessions (date desc);

create table if not exists public.climb_sends (
  id         uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.climb_sessions(id) on delete cascade,
  grade      text not null,          -- French grade: 6a, 6b+, 7a…
  style      text not null check (style in ('onsight','flash','redpoint','attempt')),
  attempts   integer not null default 1,
  is_project boolean not null default false,
  name       text
);

-- 5. Second brain — Obsidian vault mirror (phases 6-7) ---------
create table if not exists public.brain_notes (
  path        text primary key,      -- vault-relative path, e.g. "Inbox/idea.md"
  title       text,
  folder      text,
  tags        text[] not null default '{}',
  modified_at timestamptz,
  size_bytes  integer,
  synced_at   timestamptz not null default now()
);

create table if not exists public.brain_chunks (
  id        uuid primary key default gen_random_uuid(),
  note_path text not null references public.brain_notes(path) on delete cascade,
  chunk_idx integer not null,
  content   text not null,
  embedding vector(1024)             -- Voyage voyage-3.5 dimension
);
create index if not exists brain_chunks_embedding_idx
  on public.brain_chunks using hnsw (embedding vector_cosine_ops);

-- 6. AI Mentor (phase 7) ---------------------------------------
create table if not exists public.mentor_profile (
  id         smallint primary key default 1 check (id = 1),  -- single row
  content    text not null default '',
  updated_at timestamptz not null default now()
);
insert into public.mentor_profile (id, content)
values (1, '') on conflict (id) do nothing;

create table if not exists public.mentor_memories (
  id         uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  fact       text not null,
  source     text,                   -- e.g. "conversation 2026-07-05"
  archived   boolean not null default false
);

create table if not exists public.mentor_messages (
  id      uuid primary key default gen_random_uuid(),
  ts      timestamptz not null default now(),
  role    text not null check (role in ('user','assistant')),
  content text not null
);
create index if not exists mentor_messages_ts_idx on public.mentor_messages (ts desc);
