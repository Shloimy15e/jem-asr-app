// POST /api/billing/topup
// Body: { pack_id }
// Creates a Stripe Checkout Session for a one-time credit pack purchase.
// Stripe webhook (/api/stripe-webhook) credits the wallet on success.
import {
  withAuth, jsonResponse, errorResponse, sbFetch, sbRpc, stripeRequest, CORS_HEADERS,
} from './_lib.js';

export const onRequestPost = withAuth(async ({ env, accessToken, request, user }) => {
  const body = await request.json().catch(() => ({}));
  const packId = body.pack_id;
  if (!packId) return errorResponse(400, 'pack_id required');

  const orgId = await sbRpc(env, 'resolve_billing_org', { p_org_id: body.org_id || null }, { accessToken });

  const packs = await sbFetch(env, `topup_packs?id=eq.${packId}&active=eq.true&select=*`, { accessToken });
  const pack = Array.isArray(packs) ? packs[0] : null;
  if (!pack) return errorResponse(404, 'Topup pack not found');

  // Resolve / create a Stripe customer for this org.
  const customerId = await ensureStripeCustomer(env, orgId, user);

  const successUrl = `${origin(request)}/billing.html?topup=success&session_id={CHECKOUT_SESSION_ID}`;
  const cancelUrl = `${origin(request)}/billing.html?topup=canceled`;

  const session = await stripeRequest(env, '/checkout/sessions', {
    form: {
      mode: 'payment',
      customer: customerId,
      success_url: successUrl,
      cancel_url: cancelUrl,
      'line_items[0][price_data][currency]': 'usd',
      'line_items[0][price_data][product_data][name]': pack.name,
      'line_items[0][price_data][unit_amount]': pack.price_cents,
      'line_items[0][quantity]': 1,
      'metadata[org_id]': orgId,
      'metadata[pack_id]': pack.id,
      'metadata[credit_micro_usd]': pack.credit_micro_usd,
      'metadata[purpose]': 'topup',
      client_reference_id: orgId,
    },
  });

  return jsonResponse({ url: session.url, id: session.id });
});

async function ensureStripeCustomer(env, orgId, user) {
  const orgs = await sbFetch(env, `organizations?id=eq.${orgId}&select=stripe_customer_id,name,owner_user_id`);
  const org = orgs[0];
  if (org?.stripe_customer_id) return org.stripe_customer_id;

  const customer = await stripeRequest(env, '/customers', {
    form: {
      email: user.email,
      name: org?.name || user.email,
      'metadata[org_id]': orgId,
      'metadata[user_id]': user.id,
    },
  });

  await sbFetch(env, `organizations?id=eq.${orgId}`, {
    method: 'PATCH',
    body: JSON.stringify({ stripe_customer_id: customer.id }),
  });

  return customer.id;
}

function origin(request) {
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
}

export async function onRequestOptions() {
  return new Response(null, { headers: CORS_HEADERS });
}
