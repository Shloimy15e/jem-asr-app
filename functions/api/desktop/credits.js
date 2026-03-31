/**
 * GET /api/desktop/credits
 * Returns the credit balance for a desktop API key.
 *
 * Headers:
 *   Authorization: Bearer ak_live_...
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

async function sbRpc(env, fn, params) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      'apikey': env.SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Supabase RPC ${fn}: ${res.status} ${t.slice(0, 200)}`);
  }
  return res.json();
}

export async function onRequestGet(context) {
  const auth = context.request.headers.get('Authorization') || '';
  const key = auth.replace(/^Bearer\s+/i, '').trim();

  if (!key.startsWith('ak_')) {
    return json({ error: 'Missing or invalid Authorization header' }, 401);
  }

  try {
    const result = await sbRpc(context.env, 'get_api_key_credits', { p_key: key });
    if (!result.valid) {
      return json({ error: result.error || 'Invalid API key' }, 401);
    }
    return json({ credits: result.credits, email: result.email });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}

export async function onRequestOptions() {
  return new Response(null, { headers: CORS });
}
