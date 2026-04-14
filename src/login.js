import { signIn } from './auth.js';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY,
);

// ── Detect invite / recovery token in URL hash ──────────────────────
const hash = window.location.hash;
const isInviteOrRecovery = hash.includes('type=invite') || hash.includes('type=recovery');

if (isInviteOrRecovery) {
  // Supabase client auto-processes the hash tokens via onAuthStateChange
  supabase.auth.onAuthStateChange((event, session) => {
    if (session && (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED' || event === 'PASSWORD_RECOVERY')) {
      showSetPasswordForm();
    }
  });
} else {
  // Normal flow: redirect if already logged in
  supabase.auth.getSession().then(({ data: { session } }) => {
    if (session) window.location.href = '/';
  });
}

// ── Login form ──────────────────────────────────────────────────────
const form = document.getElementById('login-form');
const emailInput = document.getElementById('login-email');
const passwordInput = document.getElementById('login-password');
const errorMsg = document.getElementById('login-error');
const submitBtn = document.getElementById('login-submit');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  errorMsg.textContent = '';
  submitBtn.disabled = true;
  submitBtn.textContent = 'Signing in…';
  try {
    await signIn(emailInput.value.trim(), passwordInput.value);
    window.location.href = '/';
  } catch (err) {
    errorMsg.textContent = err.message || 'Invalid email or password.';
    submitBtn.disabled = false;
    submitBtn.textContent = 'Sign In';
  }
});

// ── Set-password form (for invited users) ───────────────────────────
function showSetPasswordForm() {
  // Hide login card, show set-password card
  const loginCard = document.querySelector('.login-card:not(#set-password-card)');
  if (loginCard) loginCard.style.display = 'none';

  const setPasswordCard = document.getElementById('set-password-card');
  if (setPasswordCard) setPasswordCard.style.display = '';

  const spForm = document.getElementById('set-password-form');
  const newPw = document.getElementById('new-password');
  const confirmPw = document.getElementById('confirm-password');
  const spError = document.getElementById('set-password-error');
  const spBtn = document.getElementById('set-password-submit');

  spForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    spError.textContent = '';

    if (newPw.value !== confirmPw.value) {
      spError.textContent = 'Passwords do not match.';
      return;
    }
    if (newPw.value.length < 6) {
      spError.textContent = 'Password must be at least 6 characters.';
      return;
    }

    spBtn.disabled = true;
    spBtn.textContent = 'Setting password…';
    try {
      const { error } = await supabase.auth.updateUser({ password: newPw.value });
      if (error) throw error;
      window.location.href = '/';
    } catch (err) {
      spError.textContent = err.message || 'Failed to set password.';
      spBtn.disabled = false;
      spBtn.textContent = 'Set Password & Continue';
    }
  });
}
