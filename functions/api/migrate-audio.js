// Auto-migrate audio from Google Drive to R2.
// POST /api/migrate-audio
// Headers: Authorization: Bearer <supabase-jwt>
// Body: JSON { audioId, driveLink, fileName }
//
// Downloads the file from Google Drive and uploads it to R2,
// then updates the audio_files.r2_link in Supabase.

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

// Extract Google Drive file ID from various URL formats
function extractDriveId(url) {
  // https://drive.google.com/file/d/{ID}/view
  const match1 = url.match(/\/file\/d\/([^/]+)/);
  if (match1) return match1[1];
  // https://drive.google.com/open?id={ID}
  const match2 = url.match(/[?&]id=([^&]+)/);
  if (match2) return match2[1];
  return null;
}

export async function onRequestOptions() {
  return new Response(null, { headers: CORS_HEADERS });
}

export async function onRequestPost(context) {
  const { request, env } = context;

  // ── Auth ──────────────────────────────────────────────────────────────
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

  if (!env.R2_BUCKET) {
    return json({ error: 'R2 bucket not configured' }, 500);
  }

  // ── Parse request ─────────────────────────────────────────────────────
  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const { audioId, driveLink, fileName, libraryId } = payload;
  if (!audioId || !driveLink || !fileName) {
    return json({ error: 'Missing audioId, driveLink, or fileName' }, 400);
  }

  const driveId = extractDriveId(driveLink);
  if (!driveId) {
    return json({ error: 'Could not extract Google Drive file ID from link' }, 400);
  }

  // ── Download from Google Drive ────────────────────────────────────────
  // Use the direct download URL with confirm=t to bypass virus scan warning
  const downloadUrl = `https://drive.google.com/uc?export=download&id=${driveId}&confirm=t`;

  let driveResp;
  try {
    driveResp = await fetch(downloadUrl, { redirect: 'follow' });
    if (!driveResp.ok) {
      return json({ error: `Google Drive download failed: ${driveResp.status}` }, 502);
    }
  } catch (err) {
    return json({ error: 'Failed to fetch from Google Drive: ' + err.message }, 502);
  }

  // Verify we got audio, not an HTML warning page
  const contentType = driveResp.headers.get('content-type') || '';
  if (contentType.includes('text/html')) {
    return json({ error: 'Google Drive returned HTML instead of audio — file may be too large or restricted' }, 502);
  }

  // ── Upload to R2 ──────────────────────────────────────────────────────
  const safeFileName = fileName.replace(/[^a-zA-Z0-9._\- ]/g, '_');
  const lib = libraryId || 'jemedia';
  const r2Key = `${lib}/${safeFileName}`;

  try {
    await env.R2_BUCKET.put(r2Key, driveResp.body, {
      httpMetadata: { contentType: 'audio/mpeg' },
    });
  } catch (err) {
    return json({ error: 'R2 upload failed: ' + err.message }, 500);
  }

  // ── Update Supabase ───────────────────────────────────────────────────
  const r2Link = `https://audio.kohnai.ai/${encodeURIComponent(r2Key).replace(/%2F/g, '/')}`;

  if (env.SUPABASE_URL && env.SUPABASE_SERVICE_KEY) {
    try {
      const updateRes = await fetch(
        `${env.SUPABASE_URL}/rest/v1/audio_files?id=eq.${encodeURIComponent(audioId)}`,
        {
          method: 'PATCH',
          headers: {
            'apikey': env.SUPABASE_SERVICE_KEY,
            'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
            'Content-Type': 'application/json',
            'Prefer': 'return=minimal',
          },
          body: JSON.stringify({ r2_link: r2Link }),
        },
      );
      if (!updateRes.ok) {
        const errText = await updateRes.text().catch(() => '');
        console.warn('[migrate-audio] Supabase update failed:', updateRes.status, errText);
      }
    } catch (err) {
      console.warn('[migrate-audio] Supabase update error:', err.message);
    }
  }

  return json({ r2Link, r2Key });
}
