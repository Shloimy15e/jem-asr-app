// POST /api/send-to-kolyid
//
// Forwards a single audio + transcript + alignment bundle to the KolYid
// (yiddish-cleaner) inbound import endpoint. The browser builds the payload
// from the data it already has loaded (audio_files row, transcript_edits,
// alignments) — this Worker only adds the cross-app bearer token and writes
// back the import tracking columns on success.
//
// Auth: caller passes their Supabase session JWT. The Worker verifies the
// JWT, then uses the same JWT to write back to audio_files so RLS enforces
// library membership. KOLYID_IMPORT_TOKEN is a separate Pages secret used
// only on the outbound POST to KolYid.
//
// Pages secrets required:
//   SUPABASE_URL          — already set
//   SUPABASE_ANON_KEY     — already set
//   KOLYID_BASE_URL       — e.g. https://kolyid.example.test (no trailing slash)
//   KOLYID_IMPORT_TOKEN   — bearer token shared with KolYid

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

  if (!env.KOLYID_BASE_URL || !env.KOLYID_IMPORT_TOKEN) {
    return json({ error: 'KolYid integration not configured on this deployment' }, 503);
  }
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) {
    return json({ error: 'Supabase not configured on this deployment' }, 503);
  }

  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return json({ error: 'Missing Authorization header' }, 401);
  }
  const jwt = authHeader.slice(7);

  // Verify the caller against Supabase Auth and capture their email — used
  // both to fill kolyid_imported_by on success and to pass to KolYid as the
  // exporter identity.
  let callerEmail = null;
  try {
    const authRes = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
      headers: { 'Authorization': `Bearer ${jwt}`, 'apikey': env.SUPABASE_ANON_KEY },
    });
    if (!authRes.ok) {
      return json({ error: 'Unauthorized' }, 401);
    }
    const user = await authRes.json();
    callerEmail = user?.email || null;
  } catch {
    return json({ error: 'Auth verification failed' }, 500);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const audioId = String(body?.audio_id || '').trim();
  const libraryId = String(body?.library_id || '').trim();
  const payload = body?.payload;

  if (!audioId || !libraryId || !payload || typeof payload !== 'object') {
    return json({ error: 'Missing audio_id, library_id, or payload' }, 400);
  }

  // Stamp the exporter identity onto the payload from the verified JWT
  // rather than trusting whatever the browser sent — prevents a user from
  // claiming to be someone else on KolYid's side.
  payload.source = payload.source || {};
  payload.source.exported_by = callerEmail;

  // Forward to KolYid.
  let kolyidResp;
  try {
    kolyidResp = await fetch(`${env.KOLYID_BASE_URL}/api/imports/jem-asr`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${env.KOLYID_IMPORT_TOKEN}`,
        'Accept': 'application/json',
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    return json({ error: 'Failed to reach KolYid: ' + err.message }, 502);
  }

  const kolyidBody = await kolyidResp.text();
  let kolyidParsed = null;
  try { kolyidParsed = kolyidBody ? JSON.parse(kolyidBody) : null; } catch { /* ignore */ }

  if (!kolyidResp.ok) {
    return json(
      {
        error: `KolYid rejected the import (${kolyidResp.status})`,
        kolyid_status: kolyidResp.status,
        kolyid_body: kolyidParsed ?? kolyidBody,
      },
      // Surface auth failures distinctly so the UI can prompt the operator.
      kolyidResp.status === 401 || kolyidResp.status === 503 ? kolyidResp.status : 502,
    );
  }

  const transcriptUrl = kolyidParsed?.url || null;

  // Write back to audio_files using the caller's JWT — RLS enforces that
  // they can only update rows in libraries they belong to. PostgREST PATCH
  // syntax with filter via query string.
  try {
    const patchUrl = `${env.SUPABASE_URL}/rest/v1/audio_files`
      + `?id=eq.${encodeURIComponent(audioId)}`
      + `&library_id=eq.${encodeURIComponent(libraryId)}`;

    const patchRes = await fetch(patchUrl, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${jwt}`,
        'apikey': env.SUPABASE_ANON_KEY,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify({
        kolyid_imported_at: new Date().toISOString(),
        kolyid_imported_by: callerEmail,
        kolyid_transcript_url: transcriptUrl,
      }),
    });

    if (!patchRes.ok) {
      // The import succeeded on KolYid's side but we failed to record it
      // locally. Surface this to the caller so they know the row exists on
      // KolYid even though the badge won't show — they can re-send to retry
      // the bookkeeping write (idempotent on KolYid's side).
      const detail = await patchRes.text().catch(() => '');
      return json({
        warning: 'Imported to KolYid but failed to record locally',
        transcript_url: transcriptUrl,
        record_error: detail,
      }, 207);
    }
  } catch (err) {
    return json({
      warning: 'Imported to KolYid but failed to record locally',
      transcript_url: transcriptUrl,
      record_error: err.message,
    }, 207);
  }

  return json({
    ok: true,
    transcript_url: transcriptUrl,
    kolyid_response: kolyidParsed,
  });
}
