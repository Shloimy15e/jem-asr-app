// Signup — creates an auth.users row; the on_auth_user_created_org trigger
// auto-provisions a personal organization + welcome credit.
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY,
);

const form = document.getElementById('signup-form');
const errorEl = document.getElementById('signup-error');
const successEl = document.getElementById('signup-success');
const submitBtn = document.getElementById('signup-submit');

// Already signed in? Send them home.
supabase.auth.getSession().then(({ data: { session } }) => {
  if (session) window.location.href = '/billing.html';
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  errorEl.textContent = '';
  successEl.textContent = '';
  submitBtn.disabled = true;
  submitBtn.textContent = 'Creating account…';

  const email = document.getElementById('signup-email').value.trim();
  const password = document.getElementById('signup-password').value;
  const workspaceName = document.getElementById('signup-name').value.trim();

  try {
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: window.location.origin + '/login.html',
        data: workspaceName ? { workspace_name: workspaceName } : undefined,
      },
    });
    if (error) throw error;

    if (data.session) {
      // Email confirmation disabled — straight to billing
      window.location.href = '/billing.html';
    } else {
      // Email confirmation enabled
      successEl.textContent = 'Account created! Check your inbox to confirm your email.';
      submitBtn.textContent = 'Confirmation sent';
    }
  } catch (err) {
    errorEl.textContent = err.message || 'Signup failed.';
    submitBtn.disabled = false;
    submitBtn.textContent = 'Create Account';
  }
});
