CREATE TABLE IF NOT EXISTS public.segment_approvals (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  audio_id TEXT NOT NULL REFERENCES public.audio_files(id) ON DELETE CASCADE,
  segment_hash TEXT NOT NULL,
  approved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  approved_by TEXT,
  library_id TEXT NOT NULL DEFAULT 'jemedia' REFERENCES public.libraries(id),
  CONSTRAINT segment_approvals_audio_hash_key UNIQUE (audio_id, segment_hash)
);

ALTER TABLE public.segment_approvals ENABLE ROW LEVEL SECURITY;

CREATE POLICY "library_access" ON public.segment_approvals
  USING (library_id IN (SELECT public.user_library_ids()))
  WITH CHECK (library_id IN (SELECT public.user_library_ids()));
