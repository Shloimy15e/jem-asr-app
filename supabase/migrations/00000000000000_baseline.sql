-- Baseline schema for JEM ASR Workbench (Supabase project xqivwkksimsvxsxhnzsj).
-- This documents the schema as it exists after all migrations have been applied.
-- It is NOT intended to be run against the existing instance — it serves as a
-- reference so the database can be recreated from scratch if needed.
--
-- Multi-tenancy: most tables include a library_id column for per-library isolation.

-- ── Primary catalog tables ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.audio_files (
  id               text PRIMARY KEY,
  name             text NOT NULL,
  r2_link          text,
  drive_link       text,
  year             integer,
  month            integer,
  day              integer,
  type             text,
  duration_minutes real,
  is_selected_50hr boolean NOT NULL DEFAULT false,
  is_benchmark     boolean NOT NULL DEFAULT false,
  comments         text,
  trim_start       real DEFAULT 0,
  trim_end         real DEFAULT 0,
  name_history     jsonb NOT NULL DEFAULT '[]'::jsonb,
  library_id       text NOT NULL DEFAULT 'jemedia',
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.transcripts (
  id                     text PRIMARY KEY,
  name                   text NOT NULL,
  year                   integer,
  month                  integer,
  day                    integer,
  first_line             text,
  text                   text,
  drive_link             text,
  r2_transcript_link     text,
  source_transcript_id   text,
  name_history           jsonb NOT NULL DEFAULT '[]'::jsonb,
  library_id             text NOT NULL DEFAULT 'jemedia',
  created_at             timestamptz NOT NULL DEFAULT now()
);

-- ── Work tables (FK → audio_files.id) ───────────────────────────────────

CREATE TABLE IF NOT EXISTS public.mappings (
  audio_id      text PRIMARY KEY REFERENCES public.audio_files(id) ON DELETE CASCADE,
  transcript_id text NOT NULL,
  confidence    double precision,
  match_reason  text,
  confirmed_by  text,
  library_id    text NOT NULL DEFAULT 'jemedia',
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.transcript_edits (
  audio_id      text NOT NULL REFERENCES public.audio_files(id) ON DELETE CASCADE,
  version       text NOT NULL,          -- 'cleaned', 'edited', 'asr-<model>', etc.
  text          text,
  original_text text,
  clean_rate    double precision,
  created_at    timestamptz DEFAULT now(),
  created_by    text,
  library_id    text NOT NULL DEFAULT 'jemedia',
  PRIMARY KEY (audio_id, version)
);

CREATE TABLE IF NOT EXISTS public.alignments (
  audio_id             text PRIMARY KEY REFERENCES public.audio_files(id) ON DELETE CASCADE,
  words                jsonb NOT NULL,
  avg_confidence       double precision,
  low_confidence_count integer,
  aligned_at           timestamptz,
  library_id           text NOT NULL DEFAULT 'jemedia'
);

CREATE TABLE IF NOT EXISTS public.reviews (
  audio_id    text PRIMARY KEY REFERENCES public.audio_files(id) ON DELETE CASCADE,
  status      text,
  edited_text text,
  reviewed_at timestamptz,
  library_id  text NOT NULL DEFAULT 'jemedia'
);

CREATE TABLE IF NOT EXISTS public.segment_approvals (
  audio_id     text NOT NULL REFERENCES public.audio_files(id) ON DELETE CASCADE,
  segment_hash text NOT NULL,
  approved_at  timestamptz DEFAULT now(),
  approved_by  text,
  library_id   text NOT NULL DEFAULT 'jemedia',
  PRIMARY KEY (audio_id, segment_hash)
);

-- ── Benchmark tables ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.asr_models (
  id               text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name             text NOT NULL,
  endpoint         text,
  api_key          text,
  request_template jsonb
);

CREATE TABLE IF NOT EXISTS public.benchmark_results (
  id            text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  audio_id      text NOT NULL REFERENCES public.audio_files(id) ON DELETE CASCADE,
  model_id      text NOT NULL,
  wer           double precision,
  cer           double precision,
  custom_wer    double precision,
  substitutions integer,
  insertions    integer,
  deletions     integer,
  total         integer,
  transcript    text,
  ran_at        timestamptz DEFAULT now(),
  library_id    text NOT NULL DEFAULT 'jemedia'
);

-- ── Convenience view ────────────────────────────────────────────────────

CREATE OR REPLACE VIEW public.latest_edits AS
SELECT DISTINCT ON (audio_id)
  audio_id, version, text, original_text, clean_rate, created_at, created_by
FROM public.transcript_edits
ORDER BY audio_id, created_at DESC;
