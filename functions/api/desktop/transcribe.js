/**
 * POST /api/desktop/transcribe
 * Desktop app transcription endpoint — validates API key, deducts 1 credit, returns text.
 *
 * Request headers:
 *   Authorization: Bearer ak_live_...
 *   Content-Type: application/json
 *
 * Request body:
 *   { audio_base64: string, audio_format: string, provider?: string }
 *
 * Response:
 *   { text: string, credits_remaining: number }
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

// ── Supabase ──────────────────────────────────────────────────────────

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

async function logUsage(env, apiKey, status, provider) {
  await fetch(`${env.SUPABASE_URL}/rest/v1/api_key_usage`, {
    method: 'POST',
    headers: {
      'apikey': env.SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ api_key: apiKey, status, provider, credits_used: status === 'ok' ? 1 : 0 }),
  }).catch(err => console.error('logUsage failed:', err));
}

// ── Transcription (mirrors /api/transcribe) ───────────────────────────

function b64url(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  bytes.forEach(b => (bin += String.fromCharCode(b)));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}
function bytesToB64url(bytes) {
  let bin = '';
  bytes.forEach(b => (bin += String.fromCharCode(b)));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}
async function getVertexToken(saJson) {
  const sa = typeof saJson === 'string' ? JSON.parse(saJson) : saJson;
  const now = Math.floor(Date.now() / 1000);
  const hdr = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const pay = b64url(JSON.stringify({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/cloud-platform', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }));
  const input = `${hdr}.${pay}`;
  const pemBody = sa.private_key.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, '');
  const keyDer = Uint8Array.from(atob(pemBody), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', keyDer, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(input));
  const jwt = `${input}.${bytesToB64url(new Uint8Array(sig))}`;
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}` });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Vertex auth: ${d.error_description || d.error}`);
  return d.access_token;
}

const MIME = { '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.webm': 'audio/webm', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.flac': 'audio/flac' };

function geminiBody(audio) {
  return {
    contents: [{ role: 'user', parts: [
      { inline_data: { mime_type: MIME[audio.format] || 'audio/webm', data: audio.base64 } },
      { text: 'Transcribe this Yiddish audio accurately. Output only the transcription text, nothing else.' },
    ]}],
    generationConfig: { temperature: 0, maxOutputTokens: 8192 },
  };
}

async function doTranscribe(audio, env) {
  if (env.GEMINI_SA_JSON) {
    const sa = JSON.parse(env.GEMINI_SA_JSON);
    const project = env.GEMINI_PROJECT_ID || sa.project_id;
    const region = env.GEMINI_REGION || 'us-central1';
    const endpoint = env.GEMINI_ENDPOINT_ID;
    if (!endpoint) throw new Error('Set GEMINI_ENDPOINT_ID');
    const token = await getVertexToken(env.GEMINI_SA_JSON);
    const url = `https://${region}-aiplatform.googleapis.com/v1/projects/${project}/locations/${region}/endpoints/${endpoint}:generateContent`;
    const res = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(geminiBody(audio)) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error?.message || `Vertex ${res.status}`);
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (typeof text !== 'string') throw new Error('No text in Vertex response');
    return { text: text.trim(), provider: 'gemini' };
  }
  if (env.GEMINI_API_KEY) {
    const modelId = env.GEMINI_MODEL_ID || 'gemini-1.5-flash';
    const prefix = /^\d+$/.test(modelId) ? 'tunedModels' : 'models';
    const url = `https://generativelanguage.googleapis.com/v1beta/${prefix}/${modelId}:generateContent?key=${env.GEMINI_API_KEY}`;
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(geminiBody(audio)) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error?.message || `Gemini ${res.status}`);
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (typeof text !== 'string') throw new Error('No text in Gemini response');
    return { text: text.trim(), provider: 'gemini' };
  }
  if (env.YL_API_KEY) {
    const boundary = '----DT' + Date.now().toString(36);
    const enc = new TextEncoder();
    const mimeType = MIME[audio.format] || 'audio/webm';
    const filename = 'audio' + (audio.format || '.webm');
    const audioBytes = Uint8Array.from(atob(audio.base64), c => c.charCodeAt(0));
    const parts = [
      enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n`),
      audioBytes,
      enc.encode(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\nyi\r\n`),
      enc.encode(`--${boundary}--\r\n`),
    ];
    const total = parts.reduce((s, p) => s + p.length, 0);
    const body = new Uint8Array(total);
    let off = 0;
    for (const p of parts) { body.set(p, off); off += p.length; }
    const res = await fetch(env.YL_ENDPOINT || 'https://app.yiddishlabs.com/api/v1/transcriptions/sync', { method: 'POST', headers: { 'X-API-KEY': env.YL_API_KEY, 'Content-Type': `multipart/form-data; boundary=${boundary}` }, body });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || `YL ${res.status}`);
    if (typeof data.text !== 'string') throw new Error('No text in YL response');
    return { text: data.text.trim(), provider: 'yiddish-labs' };
  }
  throw new Error('No ASR provider configured');
}

// ── Handler ────────────────────────────────────────────────────────────

export async function onRequestPost(context) {
  const env = context.env;

  // Auth
  const auth = context.request.headers.get('Authorization') || '';
  const apiKey = auth.replace(/^Bearer\s+/i, '').trim();
  if (!apiKey.startsWith('ak_')) {
    return json({ error: 'Missing or invalid Authorization header' }, 401);
  }

  // Parse body
  let payload;
  try {
    payload = await context.request.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const { audio_base64, audio_format } = payload;
  if (!audio_base64) {
    return json({ error: 'Missing audio_base64' }, 400);
  }

  // Validate key + deduct credit
  let creditResult;
  try {
    creditResult = await sbRpc(env, 'use_api_key_credit', { p_key: apiKey });
  } catch (err) {
    return json({ error: 'Database error: ' + err.message }, 500);
  }

  if (!creditResult.valid) {
    return json({
      error: creditResult.error || 'Unauthorized',
      credits_remaining: creditResult.credits_remaining ?? 0,
    }, creditResult.error === 'Invalid API key' ? 401 : 402);
  }

  // Transcribe
  try {
    const audio = { base64: audio_base64, format: audio_format || '.webm' };
    const { text, provider } = await doTranscribe(audio, env);
    await logUsage(env, apiKey, 'ok', provider);
    return json({ text, provider, credits_remaining: creditResult.credits_remaining });
  } catch (err) {
    await logUsage(env, apiKey, 'error', null);
    return json({ error: err.message }, 502);
  }
}

export async function onRequestOptions() {
  return new Response(null, { headers: CORS });
}
