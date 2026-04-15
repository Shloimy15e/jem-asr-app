import { createClient } from '@supabase/supabase-js';
import { checkAuth, signOut, getUserLibraries } from './auth.js';

const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY,
);

document.addEventListener('DOMContentLoaded', async () => {
  if (!await checkAuth()) return;
  document.getElementById('btn-logout')?.addEventListener('click', signOut);

  const libraries = await getUserLibraries();
  const adminLibs = libraries.filter(l => l.role === 'admin');

  const page = document.getElementById('admin-page');

  if (adminLibs.length === 0) {
    page.innerHTML = '<div class="empty-state"><div class="empty-state-title">No admin access</div><div class="empty-state-sub">You need admin role in at least one library to access this page.</div></div>';
    return;
  }

  renderAdmin(page, adminLibs);
});

function renderAdmin(page, adminLibs) {
  page.innerHTML = '';

  // ── Tab bar ──────────────────────────────────────────────────────────
  const tabBar = document.createElement('div');
  tabBar.className = 'admin-tabs';

  const tabs = [
    { id: 'members',   label: 'Members' },
    { id: 'upload',    label: 'Upload' },
  ];

  const panels = {};
  let activeTab = 'members';

  function switchTab(id) {
    activeTab = id;
    tabBar.querySelectorAll('.admin-tab').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tab === id);
    });
    Object.entries(panels).forEach(([key, el]) => {
      el.style.display = key === id ? '' : 'none';
    });
  }

  for (const t of tabs) {
    const btn = document.createElement('button');
    btn.className = 'admin-tab' + (t.id === activeTab ? ' active' : '');
    btn.dataset.tab = t.id;
    btn.textContent = t.label;
    btn.addEventListener('click', () => switchTab(t.id));
    tabBar.appendChild(btn);
  }

  // ── Members panel ────────────────────────────────────────────────────
  const memPanel = document.createElement('div');
  memPanel.className = 'admin-panel';
  panels['members'] = memPanel;

  renderMembersPanel(memPanel, adminLibs);

  // ── Upload panel ──────────────────────────────────────────────────────
  const uploadPanel = document.createElement('div');
  uploadPanel.className = 'admin-panel';
  uploadPanel.style.display = 'none';
  panels['upload'] = uploadPanel;

  renderUploadPanel(uploadPanel, adminLibs);

  page.appendChild(tabBar);
  page.appendChild(memPanel);
  page.appendChild(uploadPanel);
}

// ── Members panel ────────────────────────────────────────────────────────

function renderMembersPanel(container, adminLibs) {
  container.innerHTML = '';

  const heading = document.createElement('h2');
  heading.className = 'admin-section-title';
  heading.textContent = 'Members';
  container.appendChild(heading);

  // Library picker — only show if admin of multiple libraries
  const picker = document.createElement('select');
  picker.className = 'filter-select';
  for (const lib of adminLibs) {
    const opt = document.createElement('option');
    opt.value = lib.id;
    opt.textContent = lib.name;
    picker.appendChild(opt);
  }
  if (adminLibs.length > 1) {
    const pickerRow = document.createElement('div');
    pickerRow.className = 'admin-form-row';
    const pickerLabel = document.createElement('label');
    pickerLabel.textContent = 'Library:';
    pickerRow.appendChild(pickerLabel);
    pickerRow.appendChild(picker);
    container.appendChild(pickerRow);
  }

  const memberArea = document.createElement('div');
  container.appendChild(memberArea);

  async function loadMembers(libraryId) {
    memberArea.innerHTML = '<div class="text-secondary" style="padding:1rem">Loading members…</div>';
    const { data, error } = await supabase.rpc('get_library_members', { p_library_id: libraryId });
    if (error) {
      memberArea.innerHTML = `<div class="admin-error">${esc(error.message)}</div>`;
      return;
    }
    renderMemberList(memberArea, libraryId, data || []);
  }

  picker.addEventListener('change', () => loadMembers(picker.value));
  loadMembers(picker.value);
}

function renderMemberList(container, libraryId, members) {
  container.innerHTML = '';

  // Member table
  const table = document.createElement('table');
  table.className = 'admin-table';
  table.innerHTML = `
    <thead>
      <tr>
        <th>Email</th>
        <th>Role</th>
        <th></th>
      </tr>
    </thead>
  `;
  const tbody = document.createElement('tbody');

  for (const m of members) {
    const tr = document.createElement('tr');

    const tdEmail = document.createElement('td');
    tdEmail.textContent = m.email;

    const tdRole = document.createElement('td');
    const roleSelect = document.createElement('select');
    roleSelect.className = 'filter-select';
    roleSelect.style.fontSize = '0.8rem';
    for (const r of ['viewer', 'editor', 'admin']) {
      const opt = document.createElement('option');
      opt.value = r;
      opt.textContent = r;
      if (r === m.role) opt.selected = true;
      roleSelect.appendChild(opt);
    }

    const saveRoleBtn = document.createElement('button');
    saveRoleBtn.className = 'action-btn action-btn-secondary';
    saveRoleBtn.style.marginLeft = '6px';
    saveRoleBtn.textContent = 'Save';
    saveRoleBtn.style.display = 'none';

    roleSelect.addEventListener('change', () => {
      saveRoleBtn.style.display = '';
    });
    saveRoleBtn.addEventListener('click', async () => {
      saveRoleBtn.disabled = true;
      const { error } = await supabase
        .from('library_members')
        .update({ role: roleSelect.value })
        .eq('user_id', m.user_id)
        .eq('library_id', libraryId);
      if (error) { alert(error.message); saveRoleBtn.disabled = false; return; }
      m.role = roleSelect.value;
      saveRoleBtn.style.display = 'none';
      saveRoleBtn.disabled = false;
    });

    tdRole.appendChild(roleSelect);
    tdRole.appendChild(saveRoleBtn);

    const tdActions = document.createElement('td');
    const removeBtn = document.createElement('button');
    removeBtn.className = 'action-btn';
    removeBtn.style.color = 'var(--red)';
    removeBtn.textContent = 'Remove';
    removeBtn.addEventListener('click', async () => {
      if (!confirm(`Remove ${m.email} from this library?`)) return;
      const { error } = await supabase
        .from('library_members')
        .delete()
        .eq('user_id', m.user_id)
        .eq('library_id', libraryId);
      if (error) { alert(error.message); return; }
      tr.remove();
    });
    tdActions.appendChild(removeBtn);

    tr.appendChild(tdEmail);
    tr.appendChild(tdRole);
    tr.appendChild(tdActions);
    tbody.appendChild(tr);
  }

  table.appendChild(tbody);
  container.appendChild(table);

  // ── Add member form ──────────────────────────────────────────────────
  const addSection = document.createElement('div');
  addSection.className = 'admin-new-section';

  const addHeading = document.createElement('h3');
  addHeading.className = 'admin-subsection-title';
  addHeading.textContent = 'Invite / Add Member';
  addSection.appendChild(addHeading);

  const form = document.createElement('div');
  form.className = 'admin-form admin-form-inline';

  const emailInput = document.createElement('input');
  emailInput.type = 'email';
  emailInput.placeholder = 'user@example.com';
  emailInput.className = 'admin-input';

  const pwInput = document.createElement('input');
  pwInput.type = 'text';
  pwInput.placeholder = 'Temp password (optional)';
  pwInput.className = 'admin-input';
  pwInput.style.maxWidth = '180px';

  const roleSelect = document.createElement('select');
  roleSelect.className = 'filter-select';
  for (const r of ['viewer', 'editor', 'admin']) {
    const opt = document.createElement('option');
    opt.value = r;
    opt.textContent = r;
    if (r === 'editor') opt.selected = true;
    roleSelect.appendChild(opt);
  }

  const addBtn = document.createElement('button');
  addBtn.className = 'action-btn action-btn-primary';
  addBtn.textContent = 'Invite';

  const addErr = document.createElement('div');
  addErr.className = 'admin-error';

  const pwHint = document.createElement('div');
  pwHint.className = 'text-secondary';
  pwHint.style.cssText = 'font-size:0.75rem;margin-top:4px;';
  pwHint.textContent = 'Leave password blank to send an invite email instead.';

  addBtn.addEventListener('click', async () => {
    addErr.textContent = '';
    const email = emailInput.value.trim();
    if (!email) { addErr.textContent = 'Enter an email address.'; return; }

    const password = pwInput.value.trim() || undefined;

    addBtn.disabled = true;
    addBtn.textContent = password ? 'Creating…' : 'Inviting…';
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch('/api/invite', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${session.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ email, library_id: libraryId, role: roleSelect.value, password }),
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || 'Invite failed');

      emailInput.value = '';
      pwInput.value = '';
      addBtn.disabled = false;
      if (result.password_set) {
        addBtn.textContent = '✓ Created with password!';
      } else {
        addBtn.textContent = result.invited ? '✓ Invite sent!' : '✓ Added!';
      }
      setTimeout(() => { addBtn.textContent = 'Invite'; }, 2000);

      // Reload member list
      const { data, error: reloadErr } = await supabase.rpc('get_library_members', { p_library_id: libraryId });
      if (!reloadErr) renderMemberList(container, libraryId, data || []);
    } catch (err) {
      addErr.textContent = err.message;
      addBtn.disabled = false;
      addBtn.textContent = 'Invite';
    }
  });

  form.appendChild(emailInput);
  form.appendChild(pwInput);
  form.appendChild(roleSelect);
  form.appendChild(addBtn);
  addSection.appendChild(form);
  addSection.appendChild(pwHint);
  addSection.appendChild(addErr);
  container.appendChild(addSection);
}

// ── Upload panel ─────────────────────────────────────────────────────────────

function renderUploadPanel(container, adminLibs) {
  container.innerHTML = '';

  const heading = document.createElement('h2');
  heading.className = 'admin-section-title';
  heading.textContent = 'Upload Files';
  container.appendChild(heading);

  const desc = document.createElement('p');
  desc.className = 'text-secondary';
  desc.style.marginBottom = '1.5rem';
  desc.textContent = 'Upload audio or transcript files directly to a library\'s R2 bucket. Uploaded files are immediately available in the library.';
  container.appendChild(desc);

  const form = document.createElement('div');
  form.className = 'admin-form';
  form.style.maxWidth = '560px';

  // ── Library picker ────────────────────────────────────────────────────
  const libRow = document.createElement('div');
  libRow.className = 'admin-form-row';
  const libLabel = document.createElement('label');
  libLabel.textContent = 'Library';
  const libSelect = document.createElement('select');
  libSelect.className = 'filter-select';
  for (const lib of adminLibs) {
    const opt = document.createElement('option');
    opt.value = lib.id;
    opt.textContent = lib.name;
    libSelect.appendChild(opt);
  }
  libRow.appendChild(libLabel);
  libRow.appendChild(libSelect);
  form.appendChild(libRow);

  // ── File type ─────────────────────────────────────────────────────────
  const typeRow = document.createElement('div');
  typeRow.className = 'admin-form-row';
  const typeLabel = document.createElement('label');
  typeLabel.textContent = 'File Type';
  const typeSelect = document.createElement('select');
  typeSelect.className = 'filter-select';
  for (const [val, label] of [['audio', 'Audio'], ['transcript', 'Transcript (text)']]) {
    const opt = document.createElement('option');
    opt.value = val;
    opt.textContent = label;
    typeSelect.appendChild(opt);
  }
  typeRow.appendChild(typeLabel);
  typeRow.appendChild(typeSelect);
  form.appendChild(typeRow);

  // ── File input ────────────────────────────────────────────────────────
  const fileRow = document.createElement('div');
  fileRow.className = 'admin-form-row';
  const fileLabel = document.createElement('label');
  fileLabel.textContent = 'File';
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.className = 'admin-input';
  fileInput.accept = '.mp3,.wav,.m4a,.ogg,.flac,.txt';
  fileRow.appendChild(fileLabel);
  fileRow.appendChild(fileInput);
  form.appendChild(fileRow);

  // ── Display name ──────────────────────────────────────────────────────
  const nameRow = document.createElement('div');
  nameRow.className = 'admin-form-row';
  const nameLabel = document.createElement('label');
  nameLabel.textContent = 'Display Name';
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.className = 'admin-input';
  nameInput.placeholder = 'Auto-filled from filename';
  nameRow.appendChild(nameLabel);
  nameRow.appendChild(nameInput);
  form.appendChild(nameRow);

  // ── Record ID ─────────────────────────────────────────────────────────
  const idRow = document.createElement('div');
  idRow.className = 'admin-form-row';
  const idLabel = document.createElement('label');
  idLabel.textContent = 'Record ID';
  const idInput = document.createElement('input');
  idInput.type = 'text';
  idInput.className = 'admin-input';
  idInput.placeholder = 'Auto-generated (editable)';
  const idHint = document.createElement('div');
  idHint.className = 'text-secondary';
  idHint.style.cssText = 'font-size:0.75rem;margin-top:2px;';
  idHint.textContent = 'Unique ID used in the database. Leave blank to auto-generate.';
  idRow.appendChild(idLabel);
  const idWrap = document.createElement('div');
  idWrap.style.flex = '1';
  idWrap.appendChild(idInput);
  idWrap.appendChild(idHint);
  idRow.appendChild(idWrap);
  form.appendChild(idRow);

  // Auto-fill name + ID when file is picked
  fileInput.addEventListener('change', () => {
    const f = fileInput.files?.[0];
    if (!f) return;
    const basename = f.name.replace(/\.[^.]+$/, '');
    if (!nameInput.value) nameInput.value = basename;
    if (!idInput.value) {
      const libId = libSelect.value;
      const slug = basename.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
      idInput.value = `${libId}-${slug}-${Date.now().toString(36)}`;
    }
  });

  // Update accept attr when type changes
  typeSelect.addEventListener('change', () => {
    fileInput.accept = typeSelect.value === 'audio' ? '.mp3,.wav,.m4a,.ogg,.flac' : '.txt';
    fileInput.value = '';
    nameInput.value = '';
    idInput.value = '';
  });

  // ── Upload button + progress ──────────────────────────────────────────
  const uploadBtn = document.createElement('button');
  uploadBtn.className = 'action-btn action-btn-primary';
  uploadBtn.style.marginTop = '0.5rem';
  uploadBtn.textContent = 'Upload';

  const statusEl = document.createElement('div');
  statusEl.style.marginTop = '0.75rem';

  form.appendChild(uploadBtn);
  form.appendChild(statusEl);
  container.appendChild(form);

  uploadBtn.addEventListener('click', async () => {
    statusEl.textContent = '';
    statusEl.style.color = '';

    const file = fileInput.files?.[0];
    if (!file) { statusEl.style.color = 'var(--red)'; statusEl.textContent = 'Select a file first.'; return; }

    const libId   = libSelect.value;
    const type    = typeSelect.value;
    const name    = nameInput.value.trim() || file.name.replace(/\.[^.]+$/, '');
    const recId   = idInput.value.trim() || `${libId}-${Date.now().toString(36)}`;

    // Build R2 key: libraryId/filename
    const ext = file.name.includes('.') ? file.name.slice(file.name.lastIndexOf('.')) : '';
    const safeFilename = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
    const key = `${libId}/${safeFilename}`;

    // Get Supabase session JWT for auth
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) {
      statusEl.style.color = 'var(--red)';
      statusEl.textContent = 'Not authenticated. Please sign in again.';
      return;
    }

    uploadBtn.disabled = true;
    uploadBtn.textContent = 'Uploading…';
    statusEl.textContent = 'Uploading to R2…';

    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('key', key);

      const res = await fetch('/api/upload', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${session.access_token}` },
        body: fd,
      });

      const result = await res.json();
      if (!res.ok) throw new Error(result.error || `HTTP ${res.status}`);

      const { url } = result;
      statusEl.textContent = 'Saving to database…';

      // Insert into Supabase
      if (type === 'audio') {
        const { error } = await supabase.from('audio_files').insert({
          id: recId,
          name,
          r2_link: url,
          library_id: libId,
          is_selected_50hr: false,
          is_benchmark: false,
        });
        if (error) throw new Error('DB insert failed: ' + error.message);
      } else {
        const { error } = await supabase.from('transcripts').insert({
          id: recId,
          name,
          r2_transcript_link: url,
          library_id: libId,
        });
        if (error) throw new Error('DB insert failed: ' + error.message);
      }

      statusEl.style.color = 'var(--green)';
      statusEl.innerHTML = `Uploaded successfully!<br>
        <span class="text-secondary" style="font-size:0.8rem">
          ID: <code>${esc(recId)}</code> &bull;
          <a href="${esc(url)}" target="_blank" rel="noopener">View in R2</a>
        </span>`;

      // Reset form for next upload
      fileInput.value = '';
      nameInput.value = '';
      idInput.value = '';
    } catch (err) {
      statusEl.style.color = 'var(--red)';
      statusEl.textContent = 'Error: ' + err.message;
    } finally {
      uploadBtn.disabled = false;
      uploadBtn.textContent = 'Upload';
    }
  });
}

// ── Utils ─────────────────────────────────────────────────────────────────

function esc(str) {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
