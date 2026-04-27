// GET /api/billing/summary
// Returns balance, active subscription, last-30-day usage in one round-trip.
import { withAuth, jsonResponse, sbRpc, CORS_HEADERS } from './_lib.js';

export const onRequestGet = withAuth(async ({ env, accessToken, request }) => {
  const url = new URL(request.url);
  const orgId = url.searchParams.get('org_id') || null;
  const summary = await sbRpc(env, 'org_billing_summary', { p_org_id: orgId }, { accessToken });
  return jsonResponse(summary);
});

export async function onRequestOptions() {
  return new Response(null, { headers: CORS_HEADERS });
}
