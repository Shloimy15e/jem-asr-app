// GET /api/vertex-endpoints
// Returns the global registry of fine-tuned Vertex AI endpoints. Read-only for
// authenticated users; admins manage the list directly via SQL or future
// admin UI.
import { withAuth, jsonResponse, sbFetch, CORS_HEADERS } from './billing/_lib.js';

export const onRequestGet = withAuth(async ({ env, accessToken }) => {
  const rows = await sbFetch(
    env,
    'vertex_endpoints?select=*&is_active=eq.true&order=is_default.desc,tuning_version.desc,checkpoint.desc',
    { accessToken },
  );
  return jsonResponse({ endpoints: rows });
});

export async function onRequestOptions() {
  return new Response(null, { headers: CORS_HEADERS });
}
