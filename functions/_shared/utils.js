/**
 * Shared utilities for JEM ASR Cloudflare Workers / Pages Functions.
 * Import with:
 *   import { ... } from '../_shared/utils.js';
 *   import { ... } from './_shared/utils.js';  // from api/ peer level
 */

// ── CORS ──────────────────────────────────────────────────────────────────────

export const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-ASR-Endpoint',
};

// ── Response helpers ──────────────────────────────────────────────────────────

/**
 * Return a JSON error response with CORS headers.
 * @param {number} status      HTTP status code
 * @param {string} message     Error message
 * @param {object} extraHeaders Additional response headers
 */
export function errorResponse(status, message, extraHeaders = {}) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS, ...extraHeaders },
  });
}

// ── Audio encoding ────────────────────────────────────────────────────────────

/**
 * Convert an ArrayBuffer to a base64 string.
 * Processes in 32 KB chunks to avoid call-stack overflow on large files.
 */
export function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

// ── Base64url (JWT) ───────────────────────────────────────────────────────────

/** Base64url-encode a UTF-8 string (for JWT header / payload). */
export function b64url(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  bytes.forEach(b => (binary += String.fromCharCode(b)));
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

/** Base64url-encode raw bytes (for JWT signature). */
export function bytesToB64url(bytes) {
  let binary = '';
  bytes.forEach(b => (binary += String.fromCharCode(b)));
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

// ── SSRF guard ────────────────────────────────────────────────────────────────

/**
 * Returns the set of allowed R2 hostnames.
 * Reads ALLOWED_R2_DOMAINS env var (comma-separated) if set; falls back to defaults.
 */
export function getAllowedDomains(env) {
  if (env?.ALLOWED_R2_DOMAINS) {
    return env.ALLOWED_R2_DOMAINS.split(',').map(d => d.trim()).filter(Boolean);
  }
  return ['audio.kohnai.ai', 'pub-c3d984b0acf3415ab61d979b1a4d9665.r2.dev'];
}

// ── Supabase auth ─────────────────────────────────────────────────────────────

/**
 * Verify a Supabase JWT by calling /auth/v1/user.
 * Returns the user object on success, or null on failure.
 * Throws if env vars are missing (caller must handle as a 500).
 */
export async function verifyJWT(token, env) {
  const res = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'apikey': env.SUPABASE_ANON_KEY,
    },
  });
  if (!res.ok) return null;
  return res.json();
}

// ── Supabase REST ─────────────────────────────────────────────────────────────

/**
 * Fetch a Supabase REST endpoint using the service-role key.
 * @param {string} url   Full URL (e.g. `${env.SUPABASE_URL}/rest/v1/table?...`)
 * @param {object} options  fetch options (method, headers, body, …)
 * @param {object} env   Cloudflare env with SUPABASE_URL + SUPABASE_SERVICE_KEY
 * @returns Parsed JSON or text depending on Content-Type
 */
export async function sbFetch(url, options = {}, env) {
  const headers = {
    'apikey': env.SUPABASE_SERVICE_KEY,
    'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
    'Content-Type': 'application/json',
    ...options.headers,
  };
  const res = await fetch(url, { ...options, headers });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Supabase ${url}: ${res.status} ${text.slice(0, 200)}`);
  }
  const ct = res.headers.get('content-type') || '';
  return ct.includes('json') ? res.json() : res.text();
}
