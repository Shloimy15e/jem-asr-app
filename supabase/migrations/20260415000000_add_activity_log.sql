-- Activity log: centralized audit trail for all user actions
CREATE TABLE IF NOT EXISTS public.activity_log (
  id          BIGSERIAL PRIMARY KEY,
  user_email  TEXT NOT NULL,
  user_id     UUID,
  action      TEXT NOT NULL,
  target_id   TEXT,
  target_name TEXT,
  details     JSONB DEFAULT '{}'::jsonb,
  library_id  TEXT NOT NULL REFERENCES public.libraries(id),
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Fast admin queries: newest first, scoped to library
CREATE INDEX idx_activity_log_library_created
  ON public.activity_log (library_id, created_at DESC);

-- RLS: users see/insert activity only for their own libraries
ALTER TABLE public.activity_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "activity_log_select" ON public.activity_log
  FOR SELECT TO authenticated
  USING (library_id IN (SELECT public.user_library_ids()));

CREATE POLICY "activity_log_insert" ON public.activity_log
  FOR INSERT TO authenticated
  WITH CHECK (library_id IN (SELECT public.user_library_ids()));
