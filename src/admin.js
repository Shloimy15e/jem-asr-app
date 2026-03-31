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
    { id: 'libraries', label: 'Libraries' },
    { id: 'members',   label: 'Members' },
  ];

  const panels = {};
  let activeTab = 'libraries';

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

  // ── Libraries panel ──────────────────────────────────────────────────
  const libPanel = document.createElement('div');
  libPanel.className = 'admin-panel';
  panels['libraries'] = libPanel;

  renderLibrariesPanel(libPanel, adminLibs);

  // ── Members panel ────────────────────────────────────────────────────
  const memPanel = document.createElement('div');
  memPanel.className = 'admin-panel';
  memPanel.style.display = 'none';
  panels['members'] = memPanel;

  renderMembersPanel(memPanel, adminLibs);

  page.appendChild(tabBar);
  page.appendChild(libPanel);
  page.appendChild(memPanel);
}

// ── Libraries panel ──────────────────────────────────────────────────────

function renderLibrariesPanel(container, adminLibs) {
  container.innerHTML = '';

  const heading = document.createElement('h2');
  heading.className = 'admin-section-title';
  heading.textContent = 'Libraries';
  container.appendChild(heading);

  const table = document.createElement('table');
  table.className = 'admin-table';
  table.innerHTML = `
    <thead>
      <tr>
        <th>ID</th>
        <th>Name</th>
        <th>R2 Domain</th>
        <th>Transcript Path</th>
        <th></th>
      </tr>
    </thead>
  `;
  const tbody = document.createElement('tbody');

  for (const lib of adminLibs) {
    const tr = document.createElement('tr');
    tr.dataset.libId = lib.id;
    tr.innerHTML = `
      <td class="admin-cell-mono">${esc(lib.id)}</td>
      <td>${esc(lib.name)}</td>
      <td class="admin-cell-mono">${esc(lib.r2Domain)}</td>
      <td class="admin-cell-mono">${esc(lib.transcriptPathPrefix)}</td>
      <td><button class="action-btn action-btn-secondary btn-edit-lib">Edit</button></td>
    `;
    tr.querySelector('.btn-edit-lib').addEventListener('click', () => {
      openEditLibModal(lib, async (updates) => {
        const { error } = await supabase.from('libraries').update({
          name: updates.name,
          r2_domain: updates.r2Domain,
          transcript_path_prefix: updates.transcriptPathPrefix,
          audio_path_prefix: updates.audioPathPrefix,
        }).eq('id', lib.id);
        if (error) throw error;
        // Update local copy and re-render
        Object.assign(lib, updates);
        renderLibrariesPanel(container, adminLibs);
      });
    });
    tbody.appendChild(tr);
  }

  table.appendChild(tbody);
  container.appendChild(table);

  // ── New Library form ─────────────────────────────────────────────────
  const newSection = document.createElement('div');
  newSection.className = 'admin-new-section';

  const newHeading = document.createElement('h3');
  newHeading.className = 'admin-subsection-title';
  newHeading.textContent = 'Create New Library';
  newSection.appendChild(newHeading);

  const form = document.createElement('div');
  form.className = 'admin-form';

  const fields = [
    { name: 'id',     label: 'ID (slug, no spaces)', placeholder: 'my-library',        required: true },
    { name: 'name',   label: 'Display Name',          placeholder: 'My Library',         required: true },
    { name: 'r2',     label: 'R2 Domain',              placeholder: 'audio.kohnai.ai',    required: false },
    { name: 'prefix', label: 'Transcript Path Prefix', placeholder: 'transcripts-txt/',   required: false },
  ];

  const inputs = {};
  for (const f of fields) {
    const row = document.createElement('div');
    row.className = 'admin-form-row';
    const label = document.createElement('label');
    label.textContent = f.label;
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = f.placeholder;
    input.className = 'admin-input';
    inputs[f.name] = input;
    row.appendChild(label);
    row.appendChild(input);
    form.appendChild(row);
  }

  const createErr = document.createElement('div');
  createErr.className = 'admin-error';

  const createBtn = document.createElement('button');
  createBtn.className = 'action-btn action-btn-primary';
  createBtn.textContent = 'Create Library';
  createBtn.addEventListener('click', async () => {
    createErr.textContent = '';
    const id = inputs.id.value.trim();
    const name = inputs.name.value.trim();
    if (!id || !name) { createErr.textContent = 'ID and Name are required.'; return; }
    if (!/^[a-z0-9-]+$/.test(id)) { createErr.textContent = 'ID must be lowercase letters, numbers, and hyphens only.'; return; }

    createBtn.disabled = true;
    createBtn.textContent = 'Creating…';
    try {
      const { error } = await supabase.rpc('create_library', {
        p_id: id,
        p_name: name,
        p_r2_domain: inputs.r2.value.trim() || 'audio.kohnai.ai',
        p_transcript_prefix: inputs.prefix.value.trim() || 'transcripts-txt/',
        p_audio_prefix: '',
      });
      if (error) throw error;
      // Reload the page so new library appears in getUserLibraries() cache
      location.reload();
    } catch (err) {
      createErr.textContent = err.message;
      createBtn.disabled = false;
      createBtn.textContent = 'Create Library';
    }
  });

  form.appendChild(createErr);
  form.appendChild(createBtn);
  newSection.appendChild(form);
  container.appendChild(newSection);
}

// ── Members panel ────────────────────────────────────────────────────────

function renderMembersPanel(container, adminLibs) {
  container.innerHTML = '';

  const heading = document.createElement('h2');
  heading.className = 'admin-section-title';
  heading.textContent = 'Members';
  container.appendChild(heading);

  // Library picker
  const pickerRow = document.createElement('div');
  pickerRow.className = 'admin-form-row';
  const pickerLabel = document.createElement('label');
  pickerLabel.textContent = 'Library:';
  const picker = document.createElement('select');
  picker.className = 'filter-select';
  for (const lib of adminLibs) {
    const opt = document.createElement('option');
    opt.value = lib.id;
    opt.textContent = lib.name;
    picker.appendChild(opt);
  }
  pickerRow.appendChild(pickerLabel);
  pickerRow.appendChild(picker);
  container.appendChild(pickerRow);

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
  addHeading.textContent = 'Add Member';
  addSection.appendChild(addHeading);

  const form = document.createElement('div');
  form.className = 'admin-form admin-form-inline';

  const emailInput = document.createElement('input');
  emailInput.type = 'email';
  emailInput.placeholder = 'user@example.com';
  emailInput.className = 'admin-input';

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
  addBtn.textContent = 'Add';

  const addErr = document.createElement('div');
  addErr.className = 'admin-error';

  addBtn.addEventListener('click', async () => {
    addErr.textContent = '';
    const email = emailInput.value.trim();
    if (!email) { addErr.textContent = 'Enter an email address.'; return; }

    addBtn.disabled = true;
    addBtn.textContent = 'Adding…';
    try {
      const { data: userId, error } = await supabase.rpc('add_library_member', {
        p_library_id: libraryId,
        p_email: email,
        p_role: roleSelect.value,
      });
      if (error) throw error;
      emailInput.value = '';
      addBtn.disabled = false;
      addBtn.textContent = 'Add';
      // Reload member list
      const { data, error: reloadErr } = await supabase.rpc('get_library_members', { p_library_id: libraryId });
      if (!reloadErr) renderMemberList(container, libraryId, data || []);
    } catch (err) {
      addErr.textContent = err.message;
      addBtn.disabled = false;
      addBtn.textContent = 'Add';
    }
  });

  form.appendChild(emailInput);
  form.appendChild(roleSelect);
  form.appendChild(addBtn);
  addSection.appendChild(form);
  addSection.appendChild(addErr);
  container.appendChild(addSection);
}

// ── Edit library modal ────────────────────────────────────────────────────

function openEditLibModal(lib, onSave) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.hidden = false;

  const modal = document.createElement('div');
  modal.className = 'modal';
  modal.style.maxWidth = '480px';

  const closeBtn = document.createElement('button');
  closeBtn.className = 'modal-close';
  closeBtn.innerHTML = '&times;';

  const content = document.createElement('div');
  content.className = 'modal-content';

  const title = document.createElement('h2');
  title.style.marginBottom = '1rem';
  title.textContent = `Edit Library: ${lib.id}`;

  const fields = [
    { key: 'name',                 label: 'Display Name',          value: lib.name },
    { key: 'r2Domain',             label: 'R2 Domain',              value: lib.r2Domain },
    { key: 'transcriptPathPrefix', label: 'Transcript Path Prefix', value: lib.transcriptPathPrefix },
    { key: 'audioPathPrefix',      label: 'Audio Path Prefix',      value: lib.audioPathPrefix },
  ];

  const inputs = {};
  content.appendChild(title);

  for (const f of fields) {
    const row = document.createElement('div');
    row.className = 'admin-form-row';
    const label = document.createElement('label');
    label.textContent = f.label;
    const input = document.createElement('input');
    input.type = 'text';
    input.value = f.value || '';
    input.className = 'admin-input';
    inputs[f.key] = input;
    row.appendChild(label);
    row.appendChild(input);
    content.appendChild(row);
  }

  const err = document.createElement('div');
  err.className = 'admin-error';

  const saveBtn = document.createElement('button');
  saveBtn.className = 'action-btn action-btn-primary';
  saveBtn.style.marginTop = '1rem';
  saveBtn.textContent = 'Save Changes';

  saveBtn.addEventListener('click', async () => {
    err.textContent = '';
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';
    try {
      await onSave({
        name: inputs.name.value.trim(),
        r2Domain: inputs.r2Domain.value.trim(),
        transcriptPathPrefix: inputs.transcriptPathPrefix.value.trim(),
        audioPathPrefix: inputs.audioPathPrefix.value.trim(),
      });
      overlay.remove();
    } catch (e) {
      err.textContent = e.message;
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save Changes';
    }
  });

  content.appendChild(err);
  content.appendChild(saveBtn);

  closeBtn.addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

  modal.appendChild(closeBtn);
  modal.appendChild(content);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
}

// ── Utils ─────────────────────────────────────────────────────────────────

function esc(str) {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
