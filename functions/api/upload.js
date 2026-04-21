// Upload audio or transcript files to R2 for any library.
// POST /api/upload
// Headers: Authorization: Bearer <supabase-jwt>
// Body: multipart/form-data
//   file     — the File blob
//   key      — R2 object key, e.g. "satmar/hoshana-5710.mp3"

const R2_PUBLIC_BASE = 'https://pub-c3d984b0acf3415ab61d979b1a4d9665.r2.dev';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

export async function onRequestOptions() {
  return new Response(null, { headers: CORS_HEADERS });
}

export async function onRequestPost(context) {
  const { request, env } = context;

  // ── Auth: verify Supabase JWT ─────────────────────────────────────────
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return json({ error: 'Missing Authorization header' }, 401);
  }
  const jwt = authHeader.slice(7);

  // Verify against Supabase if secrets are configured
  if (env.SUPABASE_URL && env.SUPABASE_ANON_KEY) {
    try {
      const authRes = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
        headers: {
          'Authorization': `Bearer ${jwt}`,
          'apikey': env.SUPABASE_ANON_KEY,
        },
      });
      if (!authRes.ok) return json({ error: 'Unauthorized' }, 401);
    } catch {
      return json({ error: 'Auth verification failed' }, 500);
    }
  }

  // ── R2 binding check ──────────────────────────────────────────────────
  if (!env.R2_BUCKET) {
    return json({ error: 'R2 bucket not configured on this deployment' }, 500);
  }

  // ── Parse form data ───────────────────────────────────────────────────
  let formData;
  try {
    formData = await request.formData();
  } catch {
    return json({ error: 'Invalid multipart form data' }, 400);
  }

  const file = formData.get('file');
  const key  = formData.get('key');

  if (!file || !(file instanceof File)) {
    return json({ error: 'Missing "file" field' }, 400);
  }
  if (!key || typeof key !== 'string' || key.length > 512) {
    return json({ error: 'Missing or invalid "key" field' }, 400);
  }

  // Sanitize key: allowlist safe chars, block path traversal, normalize slashes.
  // R2 keys look like "library/audio/song.mp3" — only [A-Za-z0-9._/-] are valid.
  const sanitizedKey = key
    .replace(/^\/+/, '')
    .replace(/\.\./g, '_')
    .replace(/[^A-Za-z0-9._/-]/g, '_')
    .replace(/\/+/g, '/')
    .replace(/^\/+/, '');
  if (!sanitizedKey) {
    return json({ error: 'Key is empty after sanitization' }, 400);
  }

  // ── Upload to R2 ──────────────────────────────────────────────────────
  try {
    await env.R2_BUCKET.put(sanitizedKey, file.stream(), {
      httpMetadata: {
        contentType: file.type || 'application/octet-stream',
      },
    });
  } catch (err) {
    return json({ error: 'R2 upload failed: ' + err.message }, 500);
  }

  const url = `${R2_PUBLIC_BASE}/${sanitizedKey}`;
  return json({ url, key: sanitizedKey });
}
