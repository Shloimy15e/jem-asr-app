// POST /api/billing/portal
// Returns a Stripe Customer Portal URL where the user can update payment
// method, view invoices, or cancel their subscription.
import {
  withAuth, jsonResponse, errorResponse, sbFetch, sbRpc, stripeRequest, CORS_HEADERS,
} from './_lib.js';

export const onRequestPost = withAuth(async ({ env, accessToken, request }) => {
  const body = await request.json().catch(() => ({}));
  const orgId = await sbRpc(env, 'resolve_billing_org', { p_org_id: body.org_id || null }, { accessToken });

  const orgs = await sbFetch(env, `organizations?id=eq.${orgId}&select=stripe_customer_id`);
  const customerId = orgs[0]?.stripe_customer_id;
  if (!customerId) {
    return errorResponse(404, 'No Stripe customer for this org — make a purchase first');
  }

  const url = new URL(request.url);
  const returnUrl = `${url.protocol}//${url.host}/billing.html`;

  const session = await stripeRequest(env, '/billing_portal/sessions', {
    form: { customer: customerId, return_url: returnUrl },
  });

  return jsonResponse({ url: session.url });
});

export async function onRequestOptions() {
  return new Response(null, { headers: CORS_HEADERS });
}
