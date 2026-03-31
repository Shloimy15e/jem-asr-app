-- RPC functions for API key management

-- Validate key + deduct 1 credit atomically
-- Returns: { valid, credits_remaining, error? }
CREATE OR REPLACE FUNCTION use_api_key_credit(p_key text)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_row api_keys;
BEGIN
  SELECT * INTO v_row FROM api_keys WHERE key = p_key;

  IF NOT FOUND THEN
    RETURN json_build_object('valid', false, 'error', 'Invalid API key');
  END IF;

  IF v_row.credits <= 0 THEN
    RETURN json_build_object('valid', false, 'error', 'No credits remaining', 'credits_remaining', 0);
  END IF;

  UPDATE api_keys
  SET credits = credits - 1,
      total_used = total_used + 1,
      last_used_at = now()
  WHERE key = p_key
  RETURNING credits INTO v_row.credits;

  RETURN json_build_object('valid', true, 'credits_remaining', v_row.credits);
END;
$$;

-- Get credits for a key (read-only)
CREATE OR REPLACE FUNCTION get_api_key_credits(p_key text)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_row api_keys;
BEGIN
  SELECT * INTO v_row FROM api_keys WHERE key = p_key;
  IF NOT FOUND THEN
    RETURN json_build_object('valid', false, 'error', 'Invalid API key');
  END IF;
  RETURN json_build_object('valid', true, 'credits', v_row.credits, 'email', v_row.user_email);
END;
$$;

-- Generate a new API key for a user (called from dashboard)
CREATE OR REPLACE FUNCTION generate_api_key(p_email text, p_user_id uuid DEFAULT NULL)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_key text;
  v_row api_keys;
BEGIN
  -- Generate key: ak_live_ + 24 random chars
  v_key := 'ak_live_' || encode(gen_random_bytes(18), 'hex');

  INSERT INTO api_keys (key, user_email, user_id, credits)
  VALUES (v_key, p_email, p_user_id, 100)
  ON CONFLICT (key) DO NOTHING
  RETURNING * INTO v_row;

  IF v_row.key IS NULL THEN
    -- Rare collision — retry with new key
    v_key := 'ak_live_' || encode(gen_random_bytes(18), 'hex');
    INSERT INTO api_keys (key, user_email, user_id, credits)
    VALUES (v_key, p_email, p_user_id, 100)
    RETURNING * INTO v_row;
  END IF;

  RETURN json_build_object('key', v_row.key, 'credits', v_row.credits);
END;
$$;

GRANT EXECUTE ON FUNCTION use_api_key_credit(text) TO service_role;
GRANT EXECUTE ON FUNCTION get_api_key_credits(text) TO service_role;
GRANT EXECUTE ON FUNCTION generate_api_key(text, uuid) TO service_role;
-- Also allow authenticated users to generate their own key
GRANT EXECUTE ON FUNCTION generate_api_key(text, uuid) TO authenticated;
