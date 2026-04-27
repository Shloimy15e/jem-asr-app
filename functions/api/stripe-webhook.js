/**
 * Stripe Webhook — credits org wallets + tracks subscription lifecycle.
 * POST /api/stripe-webhook
 *
 * Backwards-compatible: when a session has only client_reference_id (a phone
 * number) and no metadata.purpose, we route to the legacy WhatsApp credit
 * pipeline. Org-based events use metadata.purpose='topup' or 'subscribe'.
 *
 * Cloudflare Worker secrets required
 * ───────────────────────────────────
 *   STRIPE_WEBHOOK_SECRET     Stripe signing secret (whsec_...)
 *   STRIPE_SECRET_KEY         Stripe API key (sk_…)  — used to look up Subscription
 *   SUPABASE_URL              Project URL
 *   SUPABASE_SERVICE_KEY      Service-role key
 *   CREDITS_PER_PURCHASE      Legacy WA credit count (default 50)
 *
 * Stripe Dashboard event subscriptions
 * ────────────────────────────────────
 *   checkout.session.completed
 *   invoice.payment_succeeded
 *   customer.subscription.created
 *   customer.subscription.updated
 *   customer.subscription.deleted
 */

async function sbFetch(env, path, opts = {}) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Supabase ${path}: ${res.status} ${t.slice(0, 300)}`);
  }
  const ct = res.headers.get('content-type') || '';
  return ct.includes('json') ? res.json() : res.text();
}

async function sbRpc(env, fn, args) {
  return sbFetch(env, `rpc/${fn}`, { method: 'POST', body: JSON.stringify(args || {}) });
}

async function stripeGet(env, path) {
  const res = await fetch(`https://api.stripe.com/v1${path}`, {
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Stripe-Version': '2024-09-30.acacia',
    },
  });
  if (!res.ok) throw new Error(`Stripe GET ${path}: ${res.status}`);
  return res.json();
}

async function verifyStripeSignature(payload, sigHeader, secret) {
  if (!sigHeader || !secret) return false;
  const parts = Object.fromEntries(sigHeader.split(',').map(p => p.split('=')));
  const timestamp = parts.t;
  const v1 = parts.v1;
  if (!timestamp || !v1) return false;

  const signedPayload = `${timestamp}.${payload}`;
  const keyData = new TextEncoder().encode(secret);
  const msgData = new TextEncoder().encode(signedPayload);

  const key = await crypto.subtle.importKey(
    'raw', keyData,
    { name: 'HMAC', hash: 'SHA-256' },
    false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, msgData);
  const computed = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
  if (computed.length !== v1.length) return false;
  let mismatch = 0;
  for (let i = 0; i < computed.length; i++) {
    mismatch |= computed.charCodeAt(i) ^ v1.charCodeAt(i);
  }
  return mismatch === 0;
}

// ── Event handlers ────────────────────────────────────────────────────────

async function handleCheckoutCompleted(event, env) {
  const session = event.data?.object || {};
  const purpose = session.metadata?.purpose;

  // Legacy WhatsApp flow (no purpose metadata, has phone reference)
  if (!purpose && session.client_reference_id && /^\d+$/.test(session.client_reference_id)) {
    const phone = session.client_reference_id;
    const amount = parseInt(env.CREDITS_PER_PURCHASE || '50', 10);
    await sbRpc(env, 'add_whatsapp_credits', { p_phone: phone, p_amount: amount });
    console.log(`[stripe] WA topup: +${amount} → ${phone}`);
    return;
  }

  if (purpose === 'topup') {
    const orgId = session.metadata?.org_id || session.client_reference_id;
    const creditMicroUsd = parseInt(session.metadata?.credit_micro_usd || session.amount_total * 10000, 10);
    if (!orgId || !creditMicroUsd) {
      console.warn('[stripe] topup session missing org_id or credit amount', session.id);
      return;
    }
    const result = await sbRpc(env, 'add_org_credits', {
      p_org_id: orgId,
      p_delta_micro_usd: creditMicroUsd,
      p_reason: 'topup',
      p_stripe_event_id: event.id,
      p_stripe_payment_intent_id: session.payment_intent || null,
      p_description: `Topup: ${session.metadata?.pack_id || 'custom'}`,
      p_metadata: { session_id: session.id, pack_id: session.metadata?.pack_id || null },
    });
    console.log(`[stripe] org topup: +${creditMicroUsd}μ$ → ${orgId} (${result?.idempotent ? 'idempotent' : 'applied'})`);
    return;
  }

  if (purpose === 'subscribe') {
    // Subscription is created in customer.subscription.created — but we still
    // make sure the customer↔org link is recorded.
    const orgId = session.metadata?.org_id;
    if (orgId && session.customer) {
      await sbFetch(env, `organizations?id=eq.${orgId}`, {
        method: 'PATCH',
        body: JSON.stringify({ stripe_customer_id: session.customer }),
      }).catch(err => console.error('[stripe] link customer:', err));
    }
    return;
  }
}

async function handleSubscriptionUpsert(event, env) {
  const sub = event.data?.object || {};
  const orgId = sub.metadata?.org_id;
  const planId = sub.metadata?.plan_id;
  if (!orgId || !planId) {
    // Try resolving via customer
    if (sub.customer) {
      const orgs = await sbFetch(env, `organizations?stripe_customer_id=eq.${sub.customer}&select=id`);
      if (orgs[0]) {
        sub.metadata = { ...(sub.metadata || {}), org_id: orgs[0].id };
      } else {
        console.warn('[stripe] subscription with no resolvable org', sub.id);
        return;
      }
    } else {
      return;
    }
  }

  const finalOrgId = sub.metadata.org_id;
  // Plan resolution: prefer metadata; otherwise fall back to looking up the price
  let finalPlanId = sub.metadata.plan_id;
  if (!finalPlanId) {
    const priceId = sub.items?.data?.[0]?.price?.id;
    if (priceId) {
      const plans = await sbFetch(env, `billing_plans?stripe_price_id=eq.${priceId}&select=id`);
      finalPlanId = plans[0]?.id;
    }
  }
  if (!finalPlanId) {
    console.warn('[stripe] subscription has no plan_id', sub.id);
    return;
  }

  const periodStart = sub.current_period_start ? new Date(sub.current_period_start * 1000).toISOString() : null;
  const periodEnd = sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null;

  const status = sub.status; // active | trialing | past_due | canceled | incomplete | paused
  const result = await sbRpc(env, 'upsert_org_subscription', {
    p_org_id: finalOrgId,
    p_plan_id: finalPlanId,
    p_stripe_sub_id: sub.id,
    p_status: status,
    p_period_start: periodStart,
    p_period_end: periodEnd,
    p_cancel_at_period_end: !!sub.cancel_at_period_end,
  });
  console.log(`[stripe] subscription upserted ${sub.id} → org ${finalOrgId} status=${status} renewal=${result?.renewal}`);
}

async function handleInvoicePaid(event, env) {
  const inv = event.data?.object || {};
  if (inv.billing_reason !== 'subscription_cycle' && inv.billing_reason !== 'subscription_create') return;
  if (!inv.subscription) return;

  // Refresh the Stripe subscription so dates are current.
  const sub = await stripeGet(env, `/subscriptions/${inv.subscription}`);
  await handleSubscriptionUpsert({ id: event.id, data: { object: sub } }, env);
}

async function handleSubscriptionDeleted(event, env) {
  const sub = event.data?.object || {};
  await sbFetch(env, `org_subscriptions?stripe_subscription_id=eq.${sub.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ status: 'canceled' }),
  }).catch(err => console.error('[stripe] cancel sub:', err));
}

// ── Entry point ───────────────────────────────────────────────────────────

export async function onRequestPost(context) {
  const { request, env } = context;
  const rawBody = await request.text();
  const sigHeader = request.headers.get('stripe-signature') || '';
  const secret = env.STRIPE_WEBHOOK_SECRET;

  if (!secret) {
    console.error('STRIPE_WEBHOOK_SECRET not configured');
    return new Response('Server error', { status: 500 });
  }
  if (!await verifyStripeSignature(rawBody, sigHeader, secret)) {
    return new Response('Unauthorized', { status: 401 });
  }

  let event;
  try { event = JSON.parse(rawBody); } catch { return new Response('Bad JSON', { status: 400 }); }

  try {
    switch (event.type) {
      case 'checkout.session.completed':
        await handleCheckoutCompleted(event, env);
        break;
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
        await handleSubscriptionUpsert(event, env);
        break;
      case 'customer.subscription.deleted':
        await handleSubscriptionDeleted(event, env);
        break;
      case 'invoice.payment_succeeded':
        await handleInvoicePaid(event, env);
        break;
      default:
        // Ignore other events
        break;
    }
  } catch (err) {
    console.error(`[stripe] handler ${event.type}:`, err.message || err);
    // Return 200 so Stripe doesn't retry forever for non-recoverable errors.
    // Keep 500 only for transient failures we want retried.
    if (err.message?.includes('Supabase') && err.message.includes('5')) {
      return new Response('Internal error', { status: 500 });
    }
  }

  return new Response('OK', { status: 200 });
}
