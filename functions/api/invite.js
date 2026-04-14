// Invite a user to a library.
// POST /api/invite
// Headers: Authorization: Bearer <supabase-jwt>
// Body JSON: { email, library_id, role }
//
// If the user doesn't have a Supabase account, one is created via the
// Auth Admin invite endpoint and they receive an email with a link to
// set their password.  If the account already exists, they are simply
// added to the library (no email sent).

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

/** Supabase REST helper (service-role key). */
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

export async function onRequestOptions() {
  return new Response(null, { headers: CORS_HEADERS });
}

export async function onRequestPost(context) {
  const { request, env } = context;

  // ── Verify caller JWT ──────────────────────────────────────────────
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return json({ error: 'Missing Authorization header' }, 401);
  }
  const jwt = authHeader.slice(7);

  let caller;
  try {
    const authRes = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
      headers: {
        'Authorization': `Bearer ${jwt}`,
        'apikey': env.SUPABASE_ANON_KEY,
      },
    });
    if (!authRes.ok) return json({ error: 'Unauthorized' }, 401);
    caller = await authRes.json();
  } catch {
    return json({ error: 'Auth verification failed' }, 500);
  }

  // ── Parse body ─────────────────────────────────────────────────────
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const { email, library_id, role } = body;
  if (!email || !library_id) {
    return json({ error: 'email and library_id are required' }, 400);
  }
  const validRoles = ['viewer', 'editor', 'admin'];
  const memberRole = validRoles.includes(role) ? role : 'editor';

  // ── Verify caller is admin of the library ──────────────────────────
  try {
    const rows = await sbFetch(
      env,
      `library_members?user_id=eq.${caller.id}&library_id=eq.${library_id}&role=eq.admin&select=user_id`,
    );
    if (!rows || rows.length === 0) {
      return json({ error: 'You must be an admin of this library to invite users' }, 403);
    }
  } catch (err) {
    return json({ error: 'Failed to verify admin status: ' + err.message }, 500);
  }

  // ── Invite or look up user ─────────────────────────────────────────
  let userId;
  let invited = false;

  // Try to create + invite via Supabase Auth Admin API
  try {
    const inviteRes = await fetch(`${env.SUPABASE_URL}/auth/v1/invite`, {
      method: 'POST',
      headers: {
        'apikey': env.SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email }),
    });

    if (inviteRes.ok) {
      const inviteData = await inviteRes.json();
      userId = inviteData.id;
      invited = true;
    } else if (inviteRes.status === 422) {
      // User already exists — look up their ID
      const lookupRes = await fetch(
        `${env.SUPABASE_URL}/auth/v1/admin/users?page=1&per_page=1`,
        {
          method: 'GET',
          headers: {
            'apikey': env.SUPABASE_SERVICE_KEY,
            'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
          },
        },
      );
      if (!lookupRes.ok) {
        return json({ error: 'Failed to look up existing user' }, 500);
      }
      // The admin users endpoint doesn't support email filter via query param,
      // so we search through users.  For a better approach, use the RPC.
      // Fall back: look up via library_members RPC which queries auth.users.
      const usersData = await lookupRes.json();
      const users = usersData.users || usersData;
      const match = Array.isArray(users) && users.find(u => u.email === email);
      if (match) {
        userId = match.id;
      } else {
        // Fallback: query auth.users via service-role REST
        // The admin/users endpoint is paginated; use a direct query instead
        const directRes = await fetch(
          `${env.SUPABASE_URL}/auth/v1/admin/users?page=1&per_page=50`,
          {
            headers: {
              'apikey': env.SUPABASE_SERVICE_KEY,
              'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
            },
          },
        );
        if (directRes.ok) {
          const allData = await directRes.json();
          const allUsers = allData.users || allData;
          const found = Array.isArray(allUsers) && allUsers.find(u => u.email === email);
          if (found) userId = found.id;
        }
        if (!userId) {
          return json({ error: `User exists but could not resolve ID for ${email}` }, 500);
        }
      }
    } else {
      const errText = await inviteRes.text().catch(() => '');
      return json({ error: `Invite failed: ${inviteRes.status} ${errText.slice(0, 200)}` }, 500);
    }
  } catch (err) {
    return json({ error: 'Invite request failed: ' + err.message }, 500);
  }

  // ── Add to library_members (upsert) ────────────────────────────────
  try {
    await sbFetch(env, 'library_members', {
      method: 'POST',
      headers: {
        'Prefer': 'resolution=merge-duplicates',
      },
      body: JSON.stringify({
        user_id: userId,
        library_id,
        role: memberRole,
      }),
    });
  } catch (err) {
    return json({
      error: 'User was invited but failed to add to library: ' + err.message,
      user_id: userId,
      invited,
    }, 500);
  }

  return json({ success: true, user_id: userId, email, role: memberRole, invited });
}
