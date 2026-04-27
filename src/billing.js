// Billing page — balance, subscription, topup packs, plan picker, usage history.
import { checkAuth, getAccessToken } from './auth.js';

const els = {
  balance: document.getElementById('balance-display'),
  balanceSub: document.getElementById('balance-sub'),
  planDisplay: document.getElementById('plan-display'),
  planFill: document.getElementById('plan-meter-fill'),
  planUsed: document.getElementById('plan-meta-used'),
  planRenew: document.getElementById('plan-meta-renew'),
  manageBtn: document.getElementById('manage-billing-btn'),
  packGrid: document.getElementById('pack-grid'),
  planGrid: document.getElementById('plan-grid'),
  usageTbody: document.getElementById('usage-tbody'),
  alertZone: document.getElementById('alert-zone'),
};

function fmtUsd(microUsd) {
  if (microUsd == null) return '$0.00';
  const dollars = Number(microUsd) / 1_000_000;
  return dollars.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 });
}

function fmtUsdFine(microUsd) {
  if (microUsd == null) return '$0.0000';
  const dollars = Number(microUsd) / 1_000_000;
  return '$' + dollars.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 });
}

function fmtMinutes(seconds) {
  if (seconds == null) return '—';
  const min = Number(seconds) / 60;
  if (min < 1) return `${Math.round(seconds)}s`;
  return `${min.toFixed(1)}m`;
}

function fmtRelative(iso) {
  const d = new Date(iso);
  const now = Date.now();
  const diff = (now - d.getTime()) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return d.toLocaleDateString();
}

function showAlert(type, message) {
  const div = document.createElement('div');
  div.className = `alert alert-${type}`;
  div.textContent = message;
  els.alertZone.appendChild(div);
  setTimeout(() => div.remove(), 6000);
}

async function api(path, opts = {}) {
  const token = await getAccessToken();
  if (!token) throw new Error('not signed in');
  const resp = await fetch(path, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data.error || `${path}: ${resp.status}`);
  return data;
}

async function loadSummary() {
  const summary = await api('/api/billing/summary');
  els.balance.textContent = fmtUsd(summary.balance_micro_usd);
  els.balanceSub.textContent = `Lifetime spent: ${fmtUsd(summary.lifetime_used_micro_usd)} · Lifetime topped up: ${fmtUsd(summary.lifetime_topup_micro_usd)}`;

  if (summary.subscription) {
    const s = summary.subscription;
    els.planDisplay.textContent = s.plan_name + (s.cancel_at_period_end ? ' (canceling)' : '');
    const pct = Math.min(100, (Number(s.period_minutes_used) / Math.max(s.included_minutes, 1)) * 100);
    els.planFill.style.width = `${pct}%`;
    els.planUsed.textContent = `${Number(s.period_minutes_used).toFixed(1)} / ${s.included_minutes} minutes`;
    if (s.current_period_end) {
      els.planRenew.textContent = `Renews ${new Date(s.current_period_end).toLocaleDateString()}`;
    }
    els.manageBtn.style.display = 'inline-block';
  } else {
    els.planDisplay.textContent = 'No active subscription';
    els.planUsed.textContent = '0 / 0 minutes';
    els.planRenew.textContent = '';
    els.planFill.style.width = '0%';
  }
}

async function loadPlans() {
  const { plans, topup_packs } = await api('/api/billing/plans');
  const summary = await api('/api/billing/summary');
  const currentPlanId = summary.subscription?.plan_id;

  // Topup packs
  els.packGrid.innerHTML = '';
  for (const pack of topup_packs) {
    const div = document.createElement('div');
    div.className = 'pack' + (pack.highlight ? ' highlight' : '');
    div.innerHTML = `
      <div class="pack-name">${pack.name}</div>
      <div class="pack-price">$${(pack.price_cents / 100).toFixed(0)}</div>
      <div class="pack-credit">${fmtUsd(pack.credit_micro_usd)} credit${pack.credit_micro_usd > pack.price_cents * 10000 ? ' (bonus)' : ''}</div>
    `;
    div.addEventListener('click', () => buyPack(pack.id));
    els.packGrid.appendChild(div);
  }

  // Subscription plans
  els.planGrid.innerHTML = '';
  for (const plan of plans) {
    const div = document.createElement('div');
    div.className = 'plan' + (plan.id === currentPlanId ? ' current' : '');
    const features = Object.entries(plan.features || {})
      .map(([k, v]) => `<div class="plan-feature">• ${k.replace(/_/g, ' ')}: ${v}</div>`).join('');
    div.innerHTML = `
      <div class="plan-name">${plan.name}</div>
      <div class="plan-price">$${(plan.monthly_price_cents / 100).toFixed(0)}<span class="per"> / mo</span></div>
      <div class="plan-feature">${plan.included_minutes} minutes / month</div>
      <div class="plan-feature">${plan.overage_markup_pct}% overage markup</div>
      ${features}
      ${plan.id === currentPlanId
        ? '<button class="btn btn-secondary btn-block" disabled>Current plan</button>'
        : `<button class="btn btn-block" data-plan="${plan.id}">${plan.id === 'free' ? 'Free tier (default)' : 'Subscribe'}</button>`}
    `;
    const btn = div.querySelector('button[data-plan]');
    if (btn && plan.id !== 'free') {
      btn.addEventListener('click', () => subscribePlan(plan.id));
    }
    els.planGrid.appendChild(div);
  }
}

async function loadUsage() {
  const { usage } = await api('/api/billing/usage?days=30&limit=50');
  els.usageTbody.innerHTML = '';
  if (!usage.length) {
    els.usageTbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:#6c6c70;">No transcriptions yet.</td></tr>';
    return;
  }
  for (const row of usage) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${fmtRelative(row.created_at)}</td>
      <td>${row.provider}${row.model_id ? ' · ' + row.model_id.slice(0, 24) : ''}</td>
      <td>${fmtMinutes(row.audio_seconds)}</td>
      <td class="num">${fmtUsdFine(row.charged_cost_micro_usd)}</td>
    `;
    if (row.status === 'failed') tr.style.opacity = 0.5;
    if (row.status === 'refunded') tr.style.textDecoration = 'line-through';
    els.usageTbody.appendChild(tr);
  }
}

async function buyPack(packId) {
  try {
    const { url } = await api('/api/billing/topup', {
      method: 'POST',
      body: JSON.stringify({ pack_id: packId }),
    });
    window.location.href = url;
  } catch (err) {
    showAlert('error', err.message);
  }
}

async function subscribePlan(planId) {
  try {
    const { url } = await api('/api/billing/subscribe', {
      method: 'POST',
      body: JSON.stringify({ plan_id: planId }),
    });
    window.location.href = url;
  } catch (err) {
    showAlert('error', err.message);
  }
}

els.manageBtn?.addEventListener('click', async () => {
  try {
    const { url } = await api('/api/billing/portal', { method: 'POST' });
    window.location.href = url;
  } catch (err) {
    showAlert('error', err.message);
  }
});

(async function init() {
  const session = await checkAuth();
  if (!session) return;

  // Pick up Stripe redirect query params
  const params = new URLSearchParams(window.location.search);
  if (params.get('topup') === 'success') showAlert('success', 'Payment received. Credits will appear within a few seconds.');
  if (params.get('topup') === 'canceled') showAlert('info', 'Topup canceled — no charge made.');
  if (params.get('subscribe') === 'success') showAlert('success', 'Subscription active. Welcome aboard!');
  if (params.get('subscribe') === 'canceled') showAlert('info', 'Subscription canceled — no charge made.');
  // Clean URL
  if (params.toString()) window.history.replaceState({}, '', '/billing.html');

  try {
    await Promise.all([loadSummary(), loadPlans(), loadUsage()]);
  } catch (err) {
    showAlert('error', `Failed to load billing data: ${err.message}`);
  }

  // Refresh balance after a delay if we just topped up
  if (params.get('topup') === 'success') {
    setTimeout(async () => {
      try { await loadSummary(); } catch {}
    }, 3000);
  }
})();
