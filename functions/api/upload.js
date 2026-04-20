// Upload audio or transcript files to R2.
// PUT /api/upload
// Headers:
//   Authorization: Bearer <supabase-jwt>
//   x-upload-key:  "<libraryId>/<safe-filename>"
//   Content-Type:  <MIME type of the file>
// Body: raw file bytes (streamed straight to R2, never buffered in the Worker)
//
// Earlier revision accepted multipart/form-data and called request.formData(),
// which buffered the whole file in Worker memory before the R2 put could start
// — that blew past the 128 MB Worker memory cap on ~40+ MB MP3s and returned
// Cloudflare's 1102 HTML error page (which the client then failed to parse as
// JSON). Streaming request.body directly into R2.put() keeps memory flat.

const R2_PUBLIC_BASE = 'https://pub-c3d984b0acf3415ab61d979b1a4d9665.r2.dev';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-upload-key',
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

export async function onRequestPut(context) {
  return handle(context);
}

// Keep POST working too so older clients don't break mid-deploy.
export async function onRequestPost(context) {
  return handle(context);
}

async function handle(context) {
  const { request, env } = context;

  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return json({ error: 'Missing Authorization header' }, 401);
  }
  const jwt = authHeader.slice(7);

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

  if (!env.R2_BUCKET) {
    return json({ error: 'R2 bucket not configured on this deployment' }, 500);
  }

  const rawKey = request.headers.get('x-upload-key');
  if (!rawKey || rawKey.length > 512) {
    return json({ error: 'Missing or invalid x-upload-key header' }, 400);
  }
  // Strip path-traversal, drop leading slashes.
  const key = rawKey.replace(/\.\./g, '_').replace(/^\/+/, '');
  if (!key) {
    return json({ error: 'Key is empty after sanitization' }, 400);
  }

  if (!request.body) {
    return json({ error: 'Missing request body' }, 400);
  }

  const contentType = request.headers.get('Content-Type') || 'application/octet-stream';

  try {
    await env.R2_BUCKET.put(key, request.body, {
      httpMetadata: { contentType },
    });
  } catch (err) {
    return json({ error: 'R2 upload failed: ' + err.message }, 500);
  }

  return json({ url: `${R2_PUBLIC_BASE}/${key}`, key });
}
