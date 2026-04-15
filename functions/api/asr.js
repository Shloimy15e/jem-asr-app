// Proxy ASR model requests to avoid CORS issues
// POST /api/asr -> forwards to endpoint specified in X-ASR-Endpoint header
// Passes through Authorization header and FormData body unchanged

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-ASR-Endpoint',
};

export async function onRequestPost(context) {
  const endpoint = context.request.headers.get('X-ASR-Endpoint');

  if (!endpoint) {
    return new Response(JSON.stringify({ error: 'Missing X-ASR-Endpoint header' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
    });
  }

  // Validate URL
  let parsed;
  try {
    parsed = new URL(endpoint);
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid X-ASR-Endpoint URL' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
    });
  }

  if (parsed.protocol !== 'https:') {
    return new Response(JSON.stringify({ error: 'X-ASR-Endpoint must use HTTPS' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
    });
  }

  try {
    // Build headers to forward
    const forwardHeaders = {};
    const auth = context.request.headers.get('Authorization');
    if (auth) {
      forwardHeaders['Authorization'] = auth;
    }
    const contentType = context.request.headers.get('Content-Type');
    if (contentType) {
      forwardHeaders['Content-Type'] = contentType;
    }

    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: forwardHeaders,
      body: context.request.body,
      cf: { cacheTtl: 0 },
    });

    // Stream the response body directly
    return new Response(resp.body, {
      status: resp.status,
      headers: {
        'Content-Type': resp.headers.get('Content-Type') || 'application/json',
        ...CORS_HEADERS,
      },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 502,
      headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
    });
  }
}

export async function onRequestOptions() {
  return new Response(null, { headers: CORS_HEADERS });
}
