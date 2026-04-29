// GET /api/runpod-health
//
// Operator visibility into RunPod serverless endpoint health. Returns
// worker counts and queue depth for each configured endpoint so we can
// diagnose 429 "queue saturated" errors at-a-glance instead of guessing.
//
// Auth: requires a Supabase bearer token (any signed-in user). The values
// returned are operational metrics, not secrets, but we still gate it
// behind auth so anonymous traffic can't enumerate endpoint IDs.

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

async function fetchHealth(endpointId, apiKey) {
  if (!endpointId) return { error: 'endpoint not configured' };
  try {
    const resp = await fetch(`https://api.runpod.ai/v2/${endpointId}/health`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!resp.ok) return { error: `HTTP ${resp.status}`, detail: (await resp.text()).slice(0, 300) };
    return await resp.json();
  } catch (err) {
    return { error: String(err).slice(0, 200) };
  }
}

export async function onRequestGet(context) {
  const { request, env } = context;

  const auth = request.headers.get('Authorization');
  if (!auth?.startsWith('Bearer ')) {
    return json({ error: 'Missing Authorization' }, 401);
  }
  if (env.SUPABASE_URL && env.SUPABASE_ANON_KEY) {
    const authResp = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
      headers: { Authorization: auth, apikey: env.SUPABASE_ANON_KEY },
    });
    if (!authResp.ok) return json({ error: 'Unauthorized' }, 401);
  }

  if (!env.RUNPOD_API_KEY) return json({ error: 'RUNPOD_API_KEY not configured' }, 500);

  const endpoints = {
    stable_ts:        env.STABLE_TS_ENDPOINT_ID,
    stable_ts_trim:   env.STABLE_TS_TRIM_ENDPOINT_ID,
    ivrit_iterative:  env.IVRIT_ENDPOINT_ID,
  };

  const out = {};
  for (const [label, id] of Object.entries(endpoints)) {
    out[label] = { endpoint_id: id || null, ...(await fetchHealth(id, env.RUNPOD_API_KEY)) };
  }
  return json(out);
}

export async function onRequestOptions() {
  return new Response(null, { headers: CORS_HEADERS });
}
