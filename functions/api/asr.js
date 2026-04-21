// Proxy ASR model requests to avoid CORS issues
// POST /api/asr -> forwards to endpoint specified in X-ASR-Endpoint header
// Passes through Authorization header and FormData body unchanged
//
// Security:
//   - Requires a valid Supabase JWT on Authorization.
//   - Blocks SSRF to loopback / link-local / private ranges.
//   - Optional hostname allowlist via env.ALLOWED_ASR_DOMAINS (comma-separated).

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-ASR-Endpoint, X-Supabase-Auth',
};

function errJson(status, message) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

async function verifySupabaseJwt(env, authHeader) {
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) {
    return { ok: false, status: 500, message: 'Auth not configured on this deployment' };
  }
  if (!authHeader?.startsWith('Bearer ')) {
    return { ok: false, status: 401, message: 'Missing Authorization header' };
  }
  const jwt = authHeader.slice(7);
  try {
    const authRes = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
      headers: { 'Authorization': `Bearer ${jwt}`, 'apikey': env.SUPABASE_ANON_KEY },
    });
    if (!authRes.ok) return { ok: false, status: 401, message: 'Unauthorized' };
  } catch {
    return { ok: false, status: 502, message: 'Auth verification failed' };
  }
  return { ok: true };
}

// Block loopback, link-local, and RFC1918 ranges so attackers can't use this
// proxy to reach internal services or cloud metadata endpoints.
function isPrivateHost(hostname) {
  const h = hostname.toLowerCase();
  if (h === 'localhost' || h === '0.0.0.0' || h === '::1' || h === '[::1]') return true;
  if (h === 'metadata.google.internal') return true;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [, a, b] = m.map(Number);
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

function hostnameAllowed(env, hostname) {
  if (isPrivateHost(hostname)) return false;
  const configured = env?.ALLOWED_ASR_DOMAINS;
  if (!configured) return true; // no allowlist configured → accept any public host
  const list = configured.split(',').map(s => s.trim()).filter(Boolean);
  return list.includes(hostname);
}

export async function onRequestPost(context) {
  // Supabase session JWT arrives on X-Supabase-Auth so the caller-facing
  // Authorization header stays available for the upstream ASR provider key.
  const auth = await verifySupabaseJwt(context.env, context.request.headers.get('X-Supabase-Auth'));
  if (!auth.ok) return errJson(auth.status, auth.message);

  const endpoint = context.request.headers.get('X-ASR-Endpoint');
  if (!endpoint) return errJson(400, 'Missing X-ASR-Endpoint header');

  let parsed;
  try {
    parsed = new URL(endpoint);
  } catch {
    return errJson(400, 'Invalid X-ASR-Endpoint URL');
  }
  if (parsed.protocol !== 'https:') return errJson(400, 'X-ASR-Endpoint must use HTTPS');
  if (!hostnameAllowed(context.env, parsed.hostname)) {
    return errJson(403, 'X-ASR-Endpoint host not permitted');
  }

  try {
    const forwardHeaders = {};
    const fwdAuth = context.request.headers.get('Authorization');
    if (fwdAuth) forwardHeaders['Authorization'] = fwdAuth;
    const contentType = context.request.headers.get('Content-Type');
    if (contentType) forwardHeaders['Content-Type'] = contentType;

    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: forwardHeaders,
      body: context.request.body,
      cf: { cacheTtl: 0 },
    });

    return new Response(resp.body, {
      status: resp.status,
      headers: {
        'Content-Type': resp.headers.get('Content-Type') || 'application/json',
        ...CORS_HEADERS,
      },
    });
  } catch (err) {
    return errJson(502, err.message);
  }
}

export async function onRequestOptions() {
  return new Response(null, { headers: CORS_HEADERS });
}
