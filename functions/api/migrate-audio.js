// Auto-migrate audio from Google Drive to R2.
// POST /api/migrate-audio
// Headers: Authorization: Bearer <supabase-jwt>
// Body: JSON { audioId, driveLink, fileName }
//
// Downloads the file from Google Drive and uploads it to R2,
// then updates the audio_files.r2_link in Supabase.

import { CORS_HEADERS, errorResponse, verifyJWT } from '../_shared/utils.js';

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

  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) {
    return errorResponse(500, 'Auth service not configured');
  }
  try {
    const user = await verifyJWT(jwt, env);
    if (!user) return json({ error: 'Unauthorized' }, 401);
  } catch {
    return json({ error: 'Auth verification failed' }, 500);
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
  // Google Drive shows a virus scan warning for larger files.
  // Strategy: try direct download, if HTML is returned, extract the
  // confirmation token from cookies and retry with it.

  let driveResp;
  try {
    // Attempt 1: direct download
    const url1 = `https://drive.google.com/uc?export=download&id=${driveId}`;
    const resp1 = await fetch(url1, { redirect: 'follow' });
    if (!resp1.ok) {
      return json({ error: `Google Drive download failed: ${resp1.status}` }, 502);
    }

    const ct1 = resp1.headers.get('content-type') || '';
    if (!ct1.includes('text/html')) {
      // Got the file directly
      driveResp = resp1;
    } else {
      // Got HTML warning page — extract confirm token from cookies or page
      const cookies = resp1.headers.get('set-cookie') || '';
      // Forward all cookies and add confirm=t
      const url2 = `https://drive.google.com/uc?export=download&id=${driveId}&confirm=t`;
      const cookieHeader = cookies.split(',').map(c => c.split(';')[0].trim()).filter(Boolean).join('; ');

      const resp2 = await fetch(url2, {
        redirect: 'follow',
        headers: cookieHeader ? { 'Cookie': cookieHeader } : {},
      });

      if (!resp2.ok) {
        return json({ error: `Google Drive confirm download failed: ${resp2.status}` }, 502);
      }

      const ct2 = resp2.headers.get('content-type') || '';
      if (ct2.includes('text/html')) {
        // Still HTML — try one more approach: direct webContentLink format
        const url3 = `https://drive.google.com/u/0/uc?id=${driveId}&export=download&confirm=t&authuser=0`;
        const resp3 = await fetch(url3, { redirect: 'follow' });
        if (!resp3.ok || (resp3.headers.get('content-type') || '').includes('text/html')) {
          return json({ error: 'Google Drive file cannot be downloaded automatically — it may require manual sharing or is restricted. Try making it publicly accessible.' }, 502);
        }
        driveResp = resp3;
      } else {
        driveResp = resp2;
      }
    }
  } catch (err) {
    return json({ error: 'Failed to fetch from Google Drive: ' + err.message }, 502);
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
