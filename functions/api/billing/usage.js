// GET /api/billing/usage?days=30&limit=100
// Returns recent transcription_usage rows + ledger entries for the caller's org.
import { withAuth, jsonResponse, sbFetch, sbRpc, CORS_HEADERS } from './_lib.js';

export const onRequestGet = withAuth(async ({ env, accessToken, request }) => {
  const url = new URL(request.url);
  const days = Math.min(Math.max(parseInt(url.searchParams.get('days') || '30', 10), 1), 365);
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '100', 10), 1), 500);
  const orgId = url.searchParams.get('org_id') || null;

  // Use the RPC to resolve the caller's org under their JWT.
  const resolvedOrg = await sbRpc(env, 'resolve_billing_org', { p_org_id: orgId }, { accessToken });
  const since = new Date(Date.now() - days * 86400_000).toISOString();

  const [usage, ledger] = await Promise.all([
    sbFetch(
      env,
      `transcription_usage?org_id=eq.${resolvedOrg}&created_at=gte.${since}&order=created_at.desc&limit=${limit}`,
      { accessToken },
    ),
    sbFetch(
      env,
      `org_credit_ledger?org_id=eq.${resolvedOrg}&created_at=gte.${since}&order=created_at.desc&limit=${limit}`,
      { accessToken },
    ),
  ]);

  return jsonResponse({ org_id: resolvedOrg, usage, ledger });
});

export async function onRequestOptions() {
  return new Response(null, { headers: CORS_HEADERS });
}
