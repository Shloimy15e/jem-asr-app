/**
 * WhatsApp Bot — JEM ASR Workbench  (with per-user Stripe billing)
 * ================================================================
 * Endpoint:  https://asr.kohnai.ai/api/whatsapp
 * Protocol:  Meta Cloud API (WhatsApp Business Platform)
 *
 * Required Cloudflare Worker secrets
 * ────────────────────────────────────────────────────────────────
 *  WHATSAPP_TOKEN          Meta permanent access token
 *  WHATSAPP_PHONE_ID       Phone Number ID (Meta > WhatsApp > API Setup)
 *  WHATSAPP_VERIFY_TOKEN   Any secret string; paste same into Meta webhook config
 *
 *  SUPABASE_URL            e.g. https://xxxx.supabase.co
 *  SUPABASE_SERVICE_KEY    Service-role key (has full table access)
 *
 *  STRIPE_PAYMENT_LINK     e.g. https://buy.stripe.com/xxxx
 *                          Create in Stripe Dashboard → Payment Links
 *                          Set price to whatever you want (e.g. $5 = 50 credits)
 *  STRIPE_WEBHOOK_SECRET   From Stripe Dashboard → Webhooks → Signing secret
 *  CREDITS_PER_PURCHASE    How many credits to add per payment  (default: 50)
 *  FREE_CREDITS            Credits given on first message        (default: 5)
 *
 *  ASR provider (same as /api/transcribe):
 *  GEMINI_API_KEY  or  GEMINI_SA_JSON + GEMINI_ENDPOINT_ID  or  YL_API_KEY
 *  GEMINI_MODEL_ID   optional model override (default: gemini-1.5-flash)
 *
 * Webhook to register in Meta Dashboard
 * ────────────────────────────────────────────────────────────────
 *  URL:    https://asr.kohnai.ai/api/whatsapp
 *  Fields: messages
 */

// ── Supabase REST helpers ────────────────────────────────────────────

async function sbFetch(env, path, opts = {}) {
  const headers = {
    'apikey': env.SUPABASE_SERVICE_KEY,
    'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
    'Content-Type': 'application/json',
    ...opts.headers,
  };
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, { ...opts, headers });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Supabase ${path}: ${res.status} ${text.slice(0, 200)}`);
  }
  const ct = res.headers.get('content-type') || '';
  return ct.includes('json') ? res.json() : res.text();
}

/** Get or create a whatsapp_users row. Returns the row. */
async function getOrCreateUser(env, phone) {
  // Try to fetch existing user
  const rows = await sbFetch(env, `whatsapp_users?phone=eq.${phone}&select=*&limit=1`);
  if (rows.length > 0) return rows[0];

  // Create new user with free credits
  const freeCredits = parseInt(env.FREE_CREDITS || '5', 10);
  const newRows = await sbFetch(env, 'whatsapp_users', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ phone, credits: freeCredits }),
  });
  return newRows[0];
}

/** Deduct credits atomically via RPC. Returns updated credits balance. */
async function deductCredit(env, phone) {
  const result = await sbFetch(env, 'rpc/decrement_whatsapp_credits', {
    method: 'POST',
    body: JSON.stringify({ p_phone: phone }),
  });
  return result; // returns { credits: N } after decrement
}

/** Add credits (called from Stripe webhook). */
async function addCredits(env, phone, amount) {
  await sbFetch(env, 'rpc/add_whatsapp_credits', {
    method: 'POST',
    body: JSON.stringify({ p_phone: phone, p_amount: amount }),
  });
}

/** Log a usage event. */
async function logUsage(env, phone, status, provider = null) {
  await sbFetch(env, 'whatsapp_usage', {
    method: 'POST',
    body: JSON.stringify({ phone, credits_used: status === 'ok' ? 1 : 0, provider, status }),
  }).catch(err => console.error('logUsage failed:', err));
}

// ── WhatsApp API helpers ─────────────────────────────────────────────

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function mimeToExt(mimeType = '') {
  const m = mimeType.toLowerCase();
  if (m.startsWith('audio/ogg')) return '.ogg';
  if (m.startsWith('audio/mpeg')) return '.mp3';
  if (m.startsWith('audio/mp4')) return '.m4a';
  if (m.startsWith('audio/wav')) return '.wav';
  if (m.startsWith('audio/webm')) return '.webm';
  if (m.startsWith('audio/flac')) return '.flac';
  if (m.startsWith('audio/amr')) return '.amr';
  return '.ogg'; // WhatsApp voice notes default
}

async function downloadWhatsAppMedia(mediaId, token) {
  // Step 1 — resolve URL + mime type
  const meta = await fetch(`https://graph.facebook.com/v19.0/${mediaId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!meta.ok) throw new Error(`Media lookup failed: ${meta.status}`);
  const { url, mime_type } = await meta.json();
  if (!url) throw new Error('Meta returned no media URL');

  // Step 2 — download binary
  const dl = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!dl.ok) throw new Error(`Media download failed: ${dl.status}`);

  const buffer = await dl.arrayBuffer();
  return {
    base64: arrayBufferToBase64(buffer),
    format: mimeToExt(mime_type),
    mime_type,
  };
}

async function sendText(env, to, text) {
  const res = await fetch(
    `https://graph.facebook.com/v19.0/${env.WHATSAPP_PHONE_ID}/messages`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { body: text },
      }),
    }
  );
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    console.error('WhatsApp send failed:', res.status, err.slice(0, 300));
  }
}

// ── Transcription (mirrors /api/transcribe) ──────────────────────────

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
  const pay = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/cloud-platform',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now, exp: now + 3600,
  }));
  const input = `${hdr}.${pay}`;
  const pemBody = sa.private_key.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, '');
  const keyDer = Uint8Array.from(atob(pemBody), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', keyDer, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(input));
  const jwt = `${input}.${bytesToB64url(new Uint8Array(sig))}`;
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Vertex auth: ${d.error_description || d.error}`);
  return d.access_token;
}

const MIME_MAP = {
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.webm': 'audio/webm',
  '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.flac': 'audio/flac', '.amr': 'audio/amr',
};

function geminiBody(audio) {
  return {
    contents: [{ role: 'user', parts: [
      { inline_data: { mime_type: MIME_MAP[audio.format] || 'audio/ogg', data: audio.base64 } },
      { text: 'Transcribe this Yiddish audio accurately. Output only the transcription text, nothing else.' },
    ]}],
    generationConfig: { temperature: 0, maxOutputTokens: 8192 },
  };
}

async function transcribeAudio(audio, env) {
  if (env.GEMINI_SA_JSON) {
    const sa = JSON.parse(env.GEMINI_SA_JSON);
    const project = env.GEMINI_PROJECT_ID || sa.project_id;
    const region = env.GEMINI_REGION || 'us-central1';
    const endpoint = env.GEMINI_ENDPOINT_ID;
    if (!endpoint) throw new Error('Set GEMINI_ENDPOINT_ID in Worker secrets');
    const token = await getVertexToken(env.GEMINI_SA_JSON);
    const url = `https://${region}-aiplatform.googleapis.com/v1/projects/${project}/locations/${region}/endpoints/${endpoint}:generateContent`;
    const res = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(geminiBody(audio)) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error?.message || `Vertex ${res.status}`);
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (typeof text !== 'string') throw new Error('No text in Vertex response');
    return { text: text.trim(), provider: 'gemini-vertex' };
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
    const boundary = '----WA' + Date.now().toString(36);
    const enc = new TextEncoder();
    const mimeType = MIME_MAP[audio.format] || 'audio/ogg';
    const filename = 'audio' + (audio.format || '.ogg');
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
    const res = await fetch(env.YL_ENDPOINT || 'https://app.yiddishlabs.com/api/v1/transcriptions/sync', {
      method: 'POST',
      headers: { 'X-API-KEY': env.YL_API_KEY, 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || `Yiddish Labs ${res.status}`);
    if (typeof data.text !== 'string') throw new Error('No text in Yiddish Labs response');
    return { text: data.text.trim(), provider: 'yiddish-labs' };
  }

  throw new Error('No ASR provider configured. Set GEMINI_API_KEY or YL_API_KEY in Worker secrets.');
}

// ── Message handler ──────────────────────────────────────────────────

async function handleMessage(message, env) {
  const from = message.from; // phone number e.g. "12125551234"
  const type = message.type;

  // ── Text commands ────────────────────────────────────────────────
  if (type === 'text') {
    const body = message.text?.body?.trim() || '';
    const lower = body.toLowerCase();

    if (lower === 'balance' || lower === 'credits') {
      const user = await getOrCreateUser(env, from);
      await sendText(env, from,
        `💳 *Your balance:* ${user.credits} transcription credit${user.credits !== 1 ? 's' : ''}\n\n` +
        (user.credits === 0 ? `Top up → ${env.STRIPE_PAYMENT_LINK}?client_reference_id=${from}` : '')
      );
      return;
    }

    if (lower === 'topup' || lower === 'buy' || lower === 'pay') {
      const link = `${env.STRIPE_PAYMENT_LINK}?client_reference_id=${from}`;
      const amount = parseInt(env.CREDITS_PER_PURCHASE || '50', 10);
      await sendText(env, from,
        `💳 *Add ${amount} credits:*\n${link}\n\n` +
        `Credits are added automatically after payment.`
      );
      return;
    }

    if (lower === 'help' || lower === '/help' || lower === '?') {
      await sendText(env, from,
        `🎙️ *JEM Yiddish ASR Bot*\n\n` +
        `Send me a *voice note* or *audio file* and I'll transcribe it to Yiddish text.\n\n` +
        `*Commands:*\n` +
        `• *balance* — check your credits\n` +
        `• *topup* — buy more credits\n` +
        `• *help* — show this message\n\n` +
        `New users get ${env.FREE_CREDITS || 5} free transcriptions. Each audio message uses 1 credit.`
      );
      return;
    }

    // Any other text
    await sendText(env, from,
      `Send a *voice note* or *audio file* to transcribe it.\n\nType *help* for commands.`
    );
    return;
  }

  // ── Audio / voice note ────────────────────────────────────────────
  if (type === 'audio' || type === 'voice') {
    const mediaId = (message.audio || message.voice)?.id;
    if (!mediaId) {
      await sendText(env, from, `Couldn't read that audio. Please try again.`);
      return;
    }

    // Get or create user, check credits
    const user = await getOrCreateUser(env, from);

    if (user.credits <= 0) {
      const link = `${env.STRIPE_PAYMENT_LINK}?client_reference_id=${from}`;
      const amount = parseInt(env.CREDITS_PER_PURCHASE || '50', 10);
      await sendText(env, from,
        `❌ *No credits remaining.*\n\n` +
        `Add ${amount} credits to continue:\n${link}\n\n` +
        `Credits are added automatically after payment.`
      );
      await logUsage(env, from, 'no_credits');
      return;
    }

    // Acknowledge
    await sendText(env, from, `⏳ Transcribing… (${user.credits} credit${user.credits !== 1 ? 's' : ''} remaining)`);

    try {
      const audio = await downloadWhatsAppMedia(mediaId, env.WHATSAPP_TOKEN);
      const { text, provider } = await transcribeAudio(audio, env);

      // Deduct credit
      await sbFetch(env, 'rpc/decrement_whatsapp_credits', {
        method: 'POST',
        body: JSON.stringify({ p_phone: from }),
      });

      const newBalance = user.credits - 1;
      const balanceLine = newBalance <= 2
        ? `\n\n_(${newBalance} credit${newBalance !== 1 ? 's' : ''} left — type *topup* to add more)_`
        : '';

      await sendText(env, from,
        `📝 *Transcription:*\n\n${text || '_(empty)_'}${balanceLine}`
      );

      await logUsage(env, from, 'ok', provider);
    } catch (err) {
      console.error('Transcription error:', err);
      await sendText(env, from, `❌ Transcription failed: ${err.message}`);
      await logUsage(env, from, 'error');
    }
    return;
  }

  // Unsupported type
  await sendText(env, from, `Please send a *voice note* or *audio file* to transcribe.`);
}

// ── Cloudflare Pages Function handlers ───────────────────────────────

/** GET /api/whatsapp — Meta webhook verification */
export async function onRequestGet(context) {
  const { searchParams } = new URL(context.request.url);
  const mode = searchParams.get('hub.mode');
  const token = searchParams.get('hub.verify_token');
  const challenge = searchParams.get('hub.challenge');

  if (mode === 'subscribe' && token === context.env.WHATSAPP_VERIFY_TOKEN) {
    return new Response(challenge, { status: 200 });
  }
  return new Response('Forbidden', { status: 403 });
}

/** POST /api/whatsapp — incoming messages */
export async function onRequestPost(context) {
  const body = await context.request.json().catch(() => null);

  if (body?.object === 'whatsapp_business_account') {
    context.waitUntil(processWebhook(body, context.env));
  }

  return new Response('OK', { status: 200 }); // always 200 fast
}

async function processWebhook(body, env) {
  try {
    for (const entry of body?.entry || []) {
      for (const change of entry?.changes || []) {
        for (const message of change?.value?.messages || []) {
          await handleMessage(message, env).catch(err =>
            console.error('handleMessage error:', err)
          );
        }
      }
    }
  } catch (err) {
    console.error('processWebhook error:', err);
  }
}
