// GET /api/billing/plans
// Returns the list of active subscription plans and topup packs.
import { withAuth, jsonResponse, sbFetch, CORS_HEADERS } from './_lib.js';

export const onRequestGet = withAuth(async ({ env, accessToken }) => {
  const [plans, packs] = await Promise.all([
    sbFetch(env, 'billing_plans?select=*&active=eq.true&order=sort_order.asc', { accessToken }),
    sbFetch(env, 'topup_packs?select=*&active=eq.true&order=sort_order.asc', { accessToken }),
  ]);
  return jsonResponse({ plans, topup_packs: packs });
});

export async function onRequestOptions() {
  return new Response(null, { headers: CORS_HEADERS });
}
