// Issue a short-lived presigned R2 PUT URL so the browser can upload
// directly to R2 — bypassing both the Cloudflare Pages inbound body limit
// (~100 MB) and the Worker wall-time cap that was killing /api/upload on
// large MP3s with "closing because of goaway or rst_stream".
//
// Request:  POST /api/upload-url  { key, contentType }
// Response: { url, key, publicUrl }
//
// The client then:
//   fetch(url, { method: 'PUT', body: file, headers: { 'Content-Type': contentType } })
// and on 200 inserts the DB row.
//
// Requires three Pages env vars / secrets:
//   R2_ACCOUNT_ID          — Cloudflare account ID
//   R2_ACCESS_KEY_ID       — R2 API token access key ID (scoped to write)
//   R2_SECRET_ACCESS_KEY   — matching secret (store with `wrangler pages secret put`)
//
// R2 bucket CORS must allow PUT from the Pages origin(s). Apply via the R2
// dashboard or `wrangler r2 bucket cors put` with a policy like:
//   [{ "AllowedOrigins": ["https://*.jem-asr-app.pages.dev", "https://asr.kohnai.ai"],
//      "AllowedMethods":  ["PUT", "GET", "HEAD"],
//      "AllowedHeaders":  ["*"],
//      "ExposeHeaders":   ["ETag"],
//      "MaxAgeSeconds":   3600 }]

const BUCKET = 'jem-asr-audio';
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
  if (env.SUPABASE_URL && env.SUPABASE_ANON_KEY) {
    try {
      const authRes = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
        headers: { 'Authorization': `Bearer ${jwt}`, 'apikey': env.SUPABASE_ANON_KEY },
      });
      if (!authRes.ok) return json({ error: 'Unauthorized' }, 401);
    } catch {
      return json({ error: 'Auth verification failed' }, 500);
    }
  }

  if (!env.R2_ACCOUNT_ID || !env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY) {
    return json({
      error: 'R2 S3 credentials not configured — set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY on this Pages project',
    }, 500);
  }

  let body;
  try { body = await request.json(); } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }
  const { key, contentType } = body;
  if (!key || typeof key !== 'string' || key.length > 512) {
    return json({ error: 'Missing or invalid "key" field' }, 400);
  }
  const sanitizedKey = key.replace(/\.\./g, '_').replace(/^\/+/, '');
  if (!sanitizedKey) {
    return json({ error: 'Key is empty after sanitization' }, 400);
  }

  try {
    const url = await signPresignedPut({
      bucket: BUCKET,
      key: sanitizedKey,
      accountId: env.R2_ACCOUNT_ID,
      accessKey: env.R2_ACCESS_KEY_ID,
      secretKey: env.R2_SECRET_ACCESS_KEY,
      expiresIn: 3600,
    });
    return json({
      url,
      key: sanitizedKey,
      publicUrl: `${R2_PUBLIC_BASE}/${sanitizedKey}`,
      contentType: contentType || 'application/octet-stream',
    });
  } catch (err) {
    return json({ error: 'Failed to sign URL: ' + err.message }, 500);
  }
}

// ── AWS SigV4 presigned URL for R2 S3-compatible PUT ──────────────────
// Query-string signing with UNSIGNED-PAYLOAD so the client can send the
// body without pre-computing a SHA-256 hash. Only `host` is signed, so
// the browser can send any Content-Type it wants.

async function signPresignedPut({ bucket, key, accountId, accessKey, secretKey, expiresIn }) {
  const host   = `${accountId}.r2.cloudflarestorage.com`;
  const region = 'auto';
  const service = 's3';
  const method = 'PUT';

  const now       = new Date();
  const amzDate   = now.toISOString().replace(/[:-]|\.\d{3}/g, '');  // YYYYMMDDTHHMMSSZ
  const dateStamp = amzDate.slice(0, 8);

  const credential    = `${accessKey}/${dateStamp}/${region}/${service}/aws4_request`;
  const signedHeaders = 'host';
  const canonicalUri  = '/' + bucket + '/' + encodeKeyPath(key);

  // SigV4 requires the query string sorted by key, then value.
  const params = [
    ['X-Amz-Algorithm',     'AWS4-HMAC-SHA256'],
    ['X-Amz-Credential',    credential],
    ['X-Amz-Date',          amzDate],
    ['X-Amz-Expires',       String(expiresIn)],
    ['X-Amz-SignedHeaders', signedHeaders],
  ].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const canonicalQuery = params
    .map(([k, v]) => encodeRfc3986(k) + '=' + encodeRfc3986(v))
    .join('&');

  const canonicalHeaders = `host:${host}\n`;
  const payloadHash      = 'UNSIGNED-PAYLOAD';

  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const enc = new TextEncoder();
  const canonicalRequestHash = await sha256Hex(enc.encode(canonicalRequest));

  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    canonicalRequestHash,
  ].join('\n');

  const kDate    = await hmac(enc.encode(`AWS4${secretKey}`), enc.encode(dateStamp));
  const kRegion  = await hmac(kDate,    enc.encode(region));
  const kService = await hmac(kRegion,  enc.encode(service));
  const kSigning = await hmac(kService, enc.encode('aws4_request'));

  const sigBytes  = await hmac(kSigning, enc.encode(stringToSign));
  const signature = [...sigBytes].map(b => b.toString(16).padStart(2, '0')).join('');

  return `https://${host}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

// Encode each path segment per RFC 3986 (SigV4 spec) while keeping the `/`
// separators that split bucket/key segments.
function encodeKeyPath(key) {
  return key.split('/').map(encodeRfc3986).join('/');
}

// encodeURIComponent almost matches RFC 3986 except for !'()*, which must
// also be percent-encoded for SigV4 signature agreement.
function encodeRfc3986(s) {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) =>
    '%' + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

async function hmac(keyBytes, dataBytes) {
  const cryptoKey = await crypto.subtle.importKey(
    'raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, dataBytes);
  return new Uint8Array(sig);
}

async function sha256Hex(bytes) {
  const buf = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
