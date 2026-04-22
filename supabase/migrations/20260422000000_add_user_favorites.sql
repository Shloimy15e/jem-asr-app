-- Per-user favorites: each reviewer keeps their own shortlist of audio files.
CREATE TABLE IF NOT EXISTS public.user_favorites (
  user_id    UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  audio_id   TEXT        NOT NULL REFERENCES public.audio_files(id) ON DELETE CASCADE,
  library_id TEXT        NOT NULL REFERENCES public.libraries(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, audio_id, library_id)
);

CREATE INDEX IF NOT EXISTS user_favorites_user_library_idx
  ON public.user_favorites (user_id, library_id);

ALTER TABLE public.user_favorites ENABLE ROW LEVEL SECURITY;

-- Each user can only see / modify their own favorites, scoped to libraries
-- they belong to. RLS filters automatically on every query.
CREATE POLICY "user_favorites_self" ON public.user_favorites
  USING (user_id = auth.uid() AND library_id IN (SELECT public.user_library_ids()))
  WITH CHECK (user_id = auth.uid() AND library_id IN (SELECT public.user_library_ids()));
