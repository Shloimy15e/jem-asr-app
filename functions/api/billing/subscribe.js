// POST /api/billing/subscribe
// Body: { plan_id }
// Creates a Stripe Checkout Session for a recurring subscription.
import {
  withAuth, jsonResponse, errorResponse, sbFetch, sbRpc, stripeRequest, CORS_HEADERS,
} from './_lib.js';

export const onRequestPost = withAuth(async ({ env, accessToken, request, user }) => {
  const body = await request.json().catch(() => ({}));
  const planId = body.plan_id;
  if (!planId) return errorResponse(400, 'plan_id required');
  if (planId === 'free') return errorResponse(400, 'Free plan does not require checkout');

  const orgId = await sbRpc(env, 'resolve_billing_org', { p_org_id: body.org_id || null }, { accessToken });

  const plans = await sbFetch(env, `billing_plans?id=eq.${planId}&active=eq.true&select=*`, { accessToken });
  const plan = Array.isArray(plans) ? plans[0] : null;
  if (!plan) return errorResponse(404, 'Plan not found');
  if (!plan.stripe_price_id) {
    return errorResponse(500, 'Plan has no stripe_price_id configured — set it in billing_plans');
  }

  // Resolve / create a Stripe customer for this org.
  const customerId = await ensureStripeCustomer(env, orgId, user);

  const successUrl = `${origin(request)}/billing.html?subscribe=success&session_id={CHECKOUT_SESSION_ID}`;
  const cancelUrl = `${origin(request)}/billing.html?subscribe=canceled`;

  const session = await stripeRequest(env, '/checkout/sessions', {
    form: {
      mode: 'subscription',
      customer: customerId,
      success_url: successUrl,
      cancel_url: cancelUrl,
      'line_items[0][price]': plan.stripe_price_id,
      'line_items[0][quantity]': 1,
      'metadata[org_id]': orgId,
      'metadata[plan_id]': plan.id,
      'metadata[purpose]': 'subscribe',
      'subscription_data[metadata][org_id]': orgId,
      'subscription_data[metadata][plan_id]': plan.id,
      client_reference_id: orgId,
    },
  });

  return jsonResponse({ url: session.url, id: session.id });
});

async function ensureStripeCustomer(env, orgId, user) {
  const orgs = await sbFetch(env, `organizations?id=eq.${orgId}&select=stripe_customer_id,name`);
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
