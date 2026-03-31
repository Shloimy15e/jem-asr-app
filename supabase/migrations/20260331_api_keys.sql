-- Desktop App API Keys
-- Run this in your Supabase SQL editor

-- API keys for desktop app users
CREATE TABLE IF NOT EXISTS api_keys (
  id              uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  key             text UNIQUE NOT NULL,            -- e.g. ak_live_xxxxxxxx
  user_email      text,
  user_id         uuid REFERENCES auth.users(id),  -- optional Supabase auth link
  credits         integer NOT NULL DEFAULT 100,    -- starts with 100 free credits
  total_used      integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  last_used_at    timestamptz
);

CREATE TABLE IF NOT EXISTS api_key_usage (
  id              uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  api_key         text NOT NULL,
  credits_used    integer NOT NULL DEFAULT 1,
  provider        text,
  status          text DEFAULT 'ok',
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Auto-update updated_at
DROP TRIGGER IF EXISTS set_api_key_updated_at ON api_keys;
CREATE TRIGGER set_api_key_updated_at
  BEFORE UPDATE ON api_keys
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Indexes
CREATE INDEX IF NOT EXISTS idx_api_keys_key ON api_keys(key);
CREATE INDEX IF NOT EXISTS idx_api_keys_user_email ON api_keys(user_email);
CREATE INDEX IF NOT EXISTS idx_api_key_usage_key ON api_key_usage(api_key);

-- RLS
ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_key_usage ENABLE ROW LEVEL SECURITY;
GRANT ALL ON api_keys TO service_role;
GRANT ALL ON api_key_usage TO service_role;

-- Authenticated users can read their own key
CREATE POLICY "users can read own key" ON api_keys
  FOR SELECT USING (auth.uid() = user_id);
