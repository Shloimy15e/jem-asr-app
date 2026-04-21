/**
 * Stripe Webhook — adds credits to a WhatsApp user after payment
 * POST /api/stripe-webhook
 *
 * Required Cloudflare Worker secrets:
 *   STRIPE_WEBHOOK_SECRET   Stripe signing secret (whsec_...)
 *   SUPABASE_URL            Your Supabase project URL
 *   SUPABASE_SERVICE_KEY    Supabase service-role key
 *   CREDITS_PER_PURCHASE    Credits to add per successful payment (default: 50)
 *
 * Stripe Dashboard setup:
 *   1. Stripe Dashboard → Developers → Webhooks → Add endpoint
 *   2. URL: https://asr.kohnai.ai/api/stripe-webhook
 *   3. Events: checkout.session.completed
 *   4. Copy the signing secret → paste as STRIPE_WEBHOOK_SECRET
 *
 * Payment Link setup:
 *   1. Stripe Dashboard → Payment Links → Create
 *   2. Add your product/price
 *   3. Under "After payment" → Redirect to: https://asr.kohnai.ai/topup-success
 *   4. Copy the URL → paste as STRIPE_PAYMENT_LINK in worker secrets
 *   The bot appends ?client_reference_id=PHONE_NUMBER to the link automatically.
 */

async function sbFetch(env, path, opts = {}) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      'apikey': env.SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      ...opts.headers,
    },
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Supabase ${path}: ${res.status} ${t.slice(0, 200)}`);
  }
  const ct = res.headers.get('content-type') || '';
  return ct.includes('json') ? res.json() : res.text();
}

/**
 * Verify the Stripe webhook signature.
 * Stripe uses HMAC-SHA256 over "timestamp.payload".
 */
async function verifyStripeSignature(payload, sigHeader, secret) {
  const parts = Object.fromEntries(
    sigHeader.split(',').map(p => p.split('='))
  );
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
  const computed = Array.from(new Uint8Array(sig))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  // Constant-time comparison
  if (computed.length !== v1.length) return false;
  let mismatch = 0;
  for (let i = 0; i < computed.length; i++) {
    mismatch |= computed.charCodeAt(i) ^ v1.charCodeAt(i);
  }
  return mismatch === 0;
}

export async function onRequestPost(context) {
  const req = context.request;
  const env = context.env;

  const rawBody = await req.text();
  const sigHeader = req.headers.get('stripe-signature') || '';
  const secret = env.STRIPE_WEBHOOK_SECRET;

  if (!secret) {
    console.error('STRIPE_WEBHOOK_SECRET not configured');
    return new Response('Server error', { status: 500 });
  }

  // Verify signature
  const valid = await verifyStripeSignature(rawBody, sigHeader, secret);
  if (!valid) {
    console.error('Stripe signature mismatch');
    return new Response('Unauthorized', { status: 401 });
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return new Response('Bad JSON', { status: 400 });
  }

  // Only handle successful checkout
  if (event.type === 'checkout.session.completed') {
    const session = event.data?.object;
    const phone = session?.client_reference_id; // WhatsApp number we passed in the link
    const amount = parseInt(env.CREDITS_PER_PURCHASE || '50', 10);

    if (!phone) {
      console.warn('checkout.session.completed with no client_reference_id — skipping');
      return new Response('OK', { status: 200 });
    }
    // E.164 without the leading + (the WhatsApp API and our DB store it this way).
    // Reject anything else so a malformed client_reference_id can't poison the DB
    // or flow into the WhatsApp API call below.
    if (!/^[1-9]\d{6,14}$/.test(phone)) {
      console.warn(`checkout.session.completed with malformed client_reference_id: ${phone}`);
      return new Response('OK', { status: 200 });
    }

    try {
      // Add credits via Postgres RPC (handles upsert + increment atomically)
      await sbFetch(env, 'rpc/add_whatsapp_credits', {
        method: 'POST',
        body: JSON.stringify({ p_phone: phone, p_amount: amount }),
      });

      console.log(`Added ${amount} credits to ${phone} (session ${session.id})`);

      // Optionally send a WhatsApp confirmation
      if (env.WHATSAPP_TOKEN && env.WHATSAPP_PHONE_ID) {
        const msg = `✅ Payment received! *${amount} credits* have been added to your account.\n\nSend a voice note to start transcribing.`;
        await fetch(`https://graph.facebook.com/v19.0/${env.WHATSAPP_PHONE_ID}/messages`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${env.WHATSAPP_TOKEN}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            to: phone,
            type: 'text',
            text: { body: msg },
          }),
        }).catch(err => console.error('WA confirmation failed:', err));
      }
    } catch (err) {
      console.error('Failed to add credits:', err);
      return new Response('Internal error', { status: 500 });
    }
  }

  return new Response('OK', { status: 200 });
}
