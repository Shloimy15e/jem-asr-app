-- ============================================================================
--  Vertex AI endpoint registry
-- ----------------------------------------------------------------------------
--  Replaces the localStorage-only list in src/asr-config.js. Globally readable
--  by every authenticated user; only service_role / admins can mutate. The
--  Worker still ships the SA JSON via env.GEMINI_SA_JSON — this table only
--  holds the endpoint coordinates (project / region / endpoint_id / display).
-- ============================================================================

CREATE TABLE vertex_endpoints (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name    TEXT NOT NULL,
  project_id      TEXT NOT NULL,
  region          TEXT NOT NULL DEFAULT 'us-central1',
  endpoint_id     TEXT NOT NULL,                  -- numeric Vertex endpoint ID
  base_model      TEXT NOT NULL,                  -- e.g. 'gemini-2.5-pro' (for pricing lookup)
  tuning_job_id   TEXT,                           -- groups checkpoints from the same job
  tuning_version  TEXT,                           -- 'v1', 'v2', etc.
  checkpoint      INTEGER,                        -- ckpt number; NULL for base
  is_default      BOOLEAN NOT NULL DEFAULT FALSE, -- preselect in the picker
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, region, endpoint_id)
);

CREATE INDEX idx_vertex_endpoints_active  ON vertex_endpoints(is_active) WHERE is_active = TRUE;
CREATE INDEX idx_vertex_endpoints_default ON vertex_endpoints(is_default) WHERE is_default = TRUE;

ALTER TABLE vertex_endpoints ENABLE ROW LEVEL SECURITY;

CREATE POLICY "vertex_authenticated_read" ON vertex_endpoints
  FOR SELECT TO authenticated
  USING (is_active = TRUE);

DROP TRIGGER IF EXISTS bump_vertex_endpoints ON vertex_endpoints;
CREATE TRIGGER bump_vertex_endpoints
  BEFORE UPDATE ON vertex_endpoints
  FOR EACH ROW EXECUTE FUNCTION public.bump_updated_at();

GRANT SELECT ON vertex_endpoints TO authenticated;
GRANT ALL    ON vertex_endpoints TO service_role;

-- ── Pricing for the tuned base model (gemini-2.5-pro retail rates Q4 2025) ──
-- Tuned-model serving on Vertex bills at base-model token rates plus a small
-- hosting fee per hour; we approximate with token rates only (good enough for
-- per-call cost tracking).

INSERT INTO provider_pricing (provider, model_id, unit_type, unit_cost_micro_usd, notes) VALUES
  ('gemini-vertex', 'gemini-2.5-pro', 'per_input_token',  125, 'Vertex 2.5-pro input @ $1.25/M tok'),
  ('gemini-vertex', 'gemini-2.5-pro', 'per_audio_token',  125, 'Audio billed at input-token rate'),
  ('gemini-vertex', 'gemini-2.5-pro', 'per_output_token', 500, 'Vertex 2.5-pro output @ $5/M tok')
ON CONFLICT DO NOTHING;

-- ── Seed 19 fine-tuned endpoints + base ─────────────────────────────────────
-- Source: transcription_eval_starter.ipynb supplied April 2026.

INSERT INTO vertex_endpoints
  (display_name,           project_id,   region,         endpoint_id,            base_model,        tuning_job_id,         tuning_version, checkpoint, is_default, notes)
VALUES
  -- V1: tuned from gemini-2.5-pro (tuning job 8638531751817248768)
  ('Jem 1 V1 — final (ckpt 10)',  'jem-chabad', 'us-central1', '3019435401489154048', 'gemini-2.5-pro', '8638531751817248768', 'v1', 10, FALSE, 'V1 final — 10 active ckpts'),
  ('Jem 1 V1 — ckpt 9',           'jem-chabad', 'us-central1', '6689869097796108288', 'gemini-2.5-pro', '8638531751817248768', 'v1', 9,  FALSE, 'V1 base for V2 tune'),
  ('Jem 1 V1 — ckpt 8',           'jem-chabad', 'us-central1', '1723524608713293824', 'gemini-2.5-pro', '8638531751817248768', 'v1', 8,  FALSE, NULL),
  ('Jem 1 V1 — ckpt 7',           'jem-chabad', 'us-central1', '6671854699286626304', 'gemini-2.5-pro', '8638531751817248768', 'v1', 7,  FALSE, NULL),
  ('Jem 1 V1 — ckpt 6',           'jem-chabad', 'us-central1', '5069699131849572352', 'gemini-2.5-pro', '8638531751817248768', 'v1', 6,  FALSE, NULL),
  ('Jem 1 V1 — ckpt 5',           'jem-chabad', 'us-central1', '5645033984246153216', 'gemini-2.5-pro', '8638531751817248768', 'v1', 5,  FALSE, NULL),
  ('Jem 1 V1 — ckpt 4',           'jem-chabad', 'us-central1', '1807967101726490624', 'gemini-2.5-pro', '8638531751817248768', 'v1', 4,  FALSE, NULL),
  ('Jem 1 V1 — ckpt 3',           'jem-chabad', 'us-central1', '7572574624760725504', 'gemini-2.5-pro', '8638531751817248768', 'v1', 3,  FALSE, NULL),
  ('Jem 1 V1 — ckpt 2',           'jem-chabad', 'us-central1', '8987830807661903872', 'gemini-2.5-pro', '8638531751817248768', 'v1', 2,  FALSE, NULL),
  ('Jem 1 V1 — ckpt 1 (early)',   'jem-chabad', 'us-central1', '1597423819146919936', 'gemini-2.5-pro', '8638531751817248768', 'v1', 1,  FALSE, 'Earliest V1 checkpoint'),
  -- V2: tuned on top of V1 ckpt 9 (tuning job 8161620782292664320)
  ('Jem 1 V2 — final (ckpt 9)',   'jem-chabad', 'us-central1', '5055062433060618240', 'gemini-2.5-pro', '8161620782292664320', 'v2', 9,  TRUE,  'V2 final — best Yiddish performance (default)'),
  ('Jem 1 V2 — ckpt 8',           'jem-chabad', 'us-central1', '738784402691063808',  'gemini-2.5-pro', '8161620782292664320', 'v2', 8,  FALSE, NULL),
  ('Jem 1 V2 — ckpt 7',           'jem-chabad', 'us-central1', '2102952877319258112', 'gemini-2.5-pro', '8161620782292664320', 'v2', 7,  FALSE, NULL),
  ('Jem 1 V2 — ckpt 6',           'jem-chabad', 'us-central1', '5908916774912393216', 'gemini-2.5-pro', '8161620782292664320', 'v2', 6,  FALSE, NULL),
  ('Jem 1 V2 — ckpt 5',           'jem-chabad', 'us-central1', '4647908879248654336', 'gemini-2.5-pro', '8161620782292664320', 'v2', 5,  FALSE, NULL),
  ('Jem 1 V2 — ckpt 4',           'jem-chabad', 'us-central1', '7079852678028722176', 'gemini-2.5-pro', '8161620782292664320', 'v2', 4,  FALSE, NULL),
  ('Jem 1 V2 — ckpt 3',           'jem-chabad', 'us-central1', '6225998336176947200', 'gemini-2.5-pro', '8161620782292664320', 'v2', 3,  FALSE, NULL),
  ('Jem 1 V2 — ckpt 2',           'jem-chabad', 'us-central1', '6555887008881836032', 'gemini-2.5-pro', '8161620782292664320', 'v2', 2,  FALSE, NULL),
  ('Jem 1 V2 — ckpt 1 (early)',   'jem-chabad', 'us-central1', '1081057974371221504', 'gemini-2.5-pro', '8161620782292664320', 'v2', 1,  FALSE, 'Earliest V2 checkpoint')
ON CONFLICT (project_id, region, endpoint_id) DO NOTHING;
