-- RPC functions for atomic credit operations
-- Run this in your Supabase SQL editor AFTER the billing tables migration

-- Atomically decrement credits (won't go below 0)
CREATE OR REPLACE FUNCTION decrement_whatsapp_credits(p_phone text)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_row whatsapp_users;
BEGIN
  UPDATE whatsapp_users
  SET credits = GREATEST(credits - 1, 0)
  WHERE phone = p_phone
  RETURNING * INTO v_row;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'User not found: %', p_phone;
  END IF;

  RETURN json_build_object('credits', v_row.credits);
END;
$$;

-- Atomically add credits (upsert: create user if they don't exist yet)
CREATE OR REPLACE FUNCTION add_whatsapp_credits(p_phone text, p_amount integer)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_row whatsapp_users;
BEGIN
  INSERT INTO whatsapp_users (phone, credits)
  VALUES (p_phone, p_amount)
  ON CONFLICT (phone) DO UPDATE
    SET credits = whatsapp_users.credits + EXCLUDED.credits
  RETURNING * INTO v_row;

  RETURN json_build_object('credits', v_row.credits);
END;
$$;

-- Grant execute to service role (used by workers)
GRANT EXECUTE ON FUNCTION decrement_whatsapp_credits(text) TO service_role;
GRANT EXECUTE ON FUNCTION add_whatsapp_credits(text, integer) TO service_role;

-- Grant table access to service role
GRANT ALL ON whatsapp_users TO service_role;
GRANT ALL ON whatsapp_usage TO service_role;
