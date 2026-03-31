// Proxy transcript text from R2 to avoid CORS issues
// GET /api/transcript?name=filename.txt[&domain=other.example.com]
const DEFAULT_R2_BASE = 'https://audio.kohnai.ai/transcripts-txt/';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function getAllowedDomains(env) {
  if (env?.ALLOWED_R2_DOMAINS) {
    return env.ALLOWED_R2_DOMAINS.split(',').map(d => d.trim()).filter(Boolean);
  }
  return ['audio.kohnai.ai'];
}

export async function onRequestOptions() {
  return new Response(null, { headers: CORS_HEADERS });
}

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const name = url.searchParams.get('name');
  const domainParam = url.searchParams.get('domain');

  if (!name) {
    return new Response('Missing ?name= parameter', { status: 400 });
  }

  // Validate the optional domain parameter against the allowlist
  let r2Url;
  if (domainParam) {
    const allowedDomains = getAllowedDomains(context.env);
    if (!allowedDomains.includes(domainParam)) {
      return new Response('Forbidden: domain not in allowed list', { status: 403 });
    }
    // name is the full path when domain is provided
    r2Url = `https://${domainParam}/${name}`;
  } else {
    r2Url = DEFAULT_R2_BASE + encodeURIComponent(name);
  }

  try {
    const resp = await fetch(r2Url, { cf: { cacheTtl: 0 } });
    if (!resp.ok) {
      return new Response('Transcript not found', { status: 404 });
    }
    // Stream raw bytes through to preserve UTF-8 encoding
    return new Response(resp.body, {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch (err) {
    return new Response('Failed to fetch transcript', { status: 500 });
  }
}
