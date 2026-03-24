import { signIn } from './auth.js';
import { createClient } from '@supabase/supabase-js';

// If already logged in, skip the login page
const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY,
);
supabase.auth.getSession().then(({ data: { session } }) => {
  if (session) window.location.href = '/';
});

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
