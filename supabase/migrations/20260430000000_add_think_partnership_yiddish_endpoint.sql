-- ============================================================================
--  Think Partnership tuned Gemini 2.5 Yiddish ASR endpoint
-- ----------------------------------------------------------------------------
--  Adds the Think Partnership tuned model (gemini-2.5-pro-yiddish-asr) to the
--  picker. Already inserted on the live DB; committed here for repo parity.
--
--  Vertex tuning job 3088427608648450048 in project fink-partnership produced
--  model 2953172783485419520 with 4 checkpoints. The default checkpoint (4)
--  is deployed on endpoint 6374124542670929920 (display name "fink").
--
--  Cross-project access: vertex-ai@jem-chabad.iam.gserviceaccount.com was
--  granted roles/aiplatform.user on fink-partnership so the existing
--  GEMINI_SA_JSON Worker secret can call this endpoint without rotating
--  credentials.
-- ============================================================================

INSERT INTO vertex_endpoints
  (display_name,                              project_id,         region,         endpoint_id,            base_model,        tuning_job_id,         tuning_version, checkpoint, is_default, notes)
VALUES
  ('Think Partnership Yiddish (Gemini 2.5)', 'fink-partnership', 'us-central1', '6374124542670929920', 'gemini-2.5-pro', '3088427608648450048', 'tp1',          4,          FALSE,
   'Think Partnership tuned model (gemini-2.5-pro-yiddish-asr); 6016 training examples; default ckpt 4. Cross-project: vertex-ai@jem-chabad SA granted aiplatform.user on fink-partnership.')
ON CONFLICT (project_id, region, endpoint_id) DO NOTHING;
