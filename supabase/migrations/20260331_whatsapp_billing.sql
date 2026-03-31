-- WhatsApp Bot Billing Tables
-- Run this in your Supabase SQL editor

-- Users identified by their WhatsApp phone number (international format, no +)
CREATE TABLE IF NOT EXISTS whatsapp_users (
  id              uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  phone           text UNIQUE NOT NULL,          -- e.g. "12125551234"
  credits         integer NOT NULL DEFAULT 5,    -- 5 free transcriptions on signup
  stripe_customer text,                          -- Stripe customer ID (optional)
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Log every transcription request for auditing / debugging
CREATE TABLE IF NOT EXISTS whatsapp_usage (
  id              uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  phone           text NOT NULL,
  credits_used    integer NOT NULL DEFAULT 1,
  provider        text,                          -- 'gemini' | 'yiddish-labs'
  duration_sec    real,                          -- audio duration if known
  status          text DEFAULT 'ok',             -- 'ok' | 'error' | 'no_credits'
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;

DROP TRIGGER IF EXISTS set_updated_at ON whatsapp_users;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON whatsapp_users
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Index for fast phone lookups
CREATE INDEX IF NOT EXISTS idx_whatsapp_users_phone ON whatsapp_users(phone);
CREATE INDEX IF NOT EXISTS idx_whatsapp_usage_phone ON whatsapp_usage(phone);

-- Row-level security: service role has full access (used from worker)
ALTER TABLE whatsapp_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_usage ENABLE ROW LEVEL SECURITY;
