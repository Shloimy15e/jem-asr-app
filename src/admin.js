import { createClient } from '@supabase/supabase-js';
import { checkAuth, signOut, getUserLibraries, getActiveLibrary } from './auth.js';
import { logActivity } from './db.js';

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
    { id: 'activity',  label: 'Activity' },
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

  // ── Activity panel ────────────────────────────────────────────────────
  const activityPanel = document.createElement('div');
  activityPanel.className = 'admin-panel';
  activityPanel.style.display = 'none';
  panels['activity'] = activityPanel;

  renderActivityPanel(activityPanel, adminLibs);

  page.appendChild(tabBar);
  page.appendChild(memPanel);
  page.appendChild(uploadPanel);
  page.appendChild(activityPanel);
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
      logActivity('role_changed', null, m.email, { newRole: roleSelect.value, libraryId });
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
      logActivity('member_removed', null, m.email, { libraryId });
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

      logActivity('member_invited', null, email, { role: roleSelect.value, libraryId });
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

  // ── Sub-tab switcher: Single | Bulk ────────────────────────────────────
  const subTabs = document.createElement('div');
  subTabs.className = 'admin-tabs';
  subTabs.style.marginBottom = '1rem';

  const singleTabBtn = document.createElement('button');
  singleTabBtn.className = 'admin-tab active';
  singleTabBtn.textContent = 'Single File';

  const bulkTabBtn = document.createElement('button');
  bulkTabBtn.className = 'admin-tab';
  bulkTabBtn.textContent = 'Bulk Audio + Transcripts';

  subTabs.appendChild(singleTabBtn);
  subTabs.appendChild(bulkTabBtn);
  container.appendChild(subTabs);

  const singlePanel = document.createElement('div');
  const bulkPanel = document.createElement('div');
  bulkPanel.style.display = 'none';
  container.appendChild(singlePanel);
  container.appendChild(bulkPanel);

  singleTabBtn.addEventListener('click', () => {
    singleTabBtn.classList.add('active');
    bulkTabBtn.classList.remove('active');
    singlePanel.style.display = '';
    bulkPanel.style.display = 'none';
  });
  bulkTabBtn.addEventListener('click', () => {
    bulkTabBtn.classList.add('active');
    singleTabBtn.classList.remove('active');
    bulkPanel.style.display = '';
    singlePanel.style.display = 'none';
  });

  renderSingleUploadForm(singlePanel, adminLibs);
  renderBulkUploadForm(bulkPanel, adminLibs);
}

function renderSingleUploadForm(container, adminLibs) {
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
      // Upload goes browser → R2 directly via a presigned PUT URL. We avoid
      // the Worker path entirely because CF Pages caps both the inbound
      // request body (~100 MB) and the Worker wall time (~30s), which
      // blew up large MP3 uploads with "closing because of goaway or
      // rst_stream" even after switching to streaming request.body.

      const signRes = await fetch('/api/upload-url', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${session.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ key, contentType: file.type || 'application/octet-stream' }),
      });
      const signText = await signRes.text();
      let signed;
      try { signed = JSON.parse(signText); } catch {
        throw new Error(`sign URL HTTP ${signRes.status}: ${signText.slice(0, 200)}`);
      }
      if (!signRes.ok) throw new Error(signed.error || `sign URL HTTP ${signRes.status}`);

      statusEl.textContent = `Uploading ${(file.size / 1024 / 1024).toFixed(1)} MB directly to R2…`;
      const putRes = await fetch(signed.url, {
        method: 'PUT',
        headers: { 'Content-Type': signed.contentType },
        body: file,
      });
      if (!putRes.ok) {
        const body = await putRes.text().catch(() => '');
        throw new Error(`R2 PUT failed HTTP ${putRes.status}: ${body.slice(0, 200)}`);
      }
      const result = { url: signed.publicUrl, key: signed.key };

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

      logActivity('file_uploaded', recId, name, { type, libraryId: libId });
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

// ── Bulk upload form ─────────────────────────────────────────────────────────
//
// Lets an admin pick many audio files at once and, per-row, attach a transcript
// via:
//   - File upload (.docx → parsed via mammoth, .txt → used as-is)
//   - Pasted text
//   - None
// On "Upload All": each audio is uploaded to R2 (presigned PUT), each transcript
// is uploaded as a UTF-8 .txt to R2, then audio_files + transcripts rows are
// inserted and a mapping is created linking them.

function renderBulkUploadForm(container, adminLibs) {
  container.innerHTML = '';

  const intro = document.createElement('p');
  intro.className = 'text-secondary';
  intro.style.cssText = 'font-size:0.85rem;margin-bottom:0.75rem;';
  intro.textContent = 'Pick multiple audio files. For each one, optionally attach a transcript by uploading a Word/.docx, .txt, or pasting the text.';
  container.appendChild(intro);

  // ── Library picker ──────────────────────────────────────────────────────
  const libRow = document.createElement('div');
  libRow.className = 'admin-form-row';
  libRow.style.maxWidth = '320px';
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
  container.appendChild(libRow);

  // ── Audio multi-file picker ─────────────────────────────────────────────
  const audioRow = document.createElement('div');
  audioRow.className = 'admin-form-row';
  audioRow.style.marginTop = '12px';
  const audioLabel = document.createElement('label');
  audioLabel.textContent = 'Audio Files (select multiple)';
  const audioInput = document.createElement('input');
  audioInput.type = 'file';
  audioInput.className = 'admin-input';
  audioInput.multiple = true;
  audioInput.accept = '.mp3,.wav,.m4a,.ogg,.flac';
  audioRow.appendChild(audioLabel);
  audioRow.appendChild(audioInput);
  container.appendChild(audioRow);

  // ── Rows container (one per audio file) ─────────────────────────────────
  const rowsList = document.createElement('div');
  rowsList.style.cssText = 'display:flex;flex-direction:column;gap:10px;margin-top:14px;';
  container.appendChild(rowsList);

  // Each row state lives in `rowEntries`. fileEntry shape:
  //   { audioFile, displayName, recId, mode: 'none'|'file'|'paste',
  //     transcriptFile, transcriptFileName, pastedText, parsedText, parseStatus, rowEl }
  const rowEntries = [];

  audioInput.addEventListener('change', () => {
    rowEntries.length = 0;
    rowsList.innerHTML = '';
    const files = Array.from(audioInput.files || []);
    if (files.length === 0) return;

    for (const f of files) {
      const entry = createBulkRow(f, libSelect.value);
      rowEntries.push(entry);
      rowsList.appendChild(entry.rowEl);
    }
  });

  // Re-stamp rec IDs when library changes (because IDs are prefixed with library)
  libSelect.addEventListener('change', () => {
    for (const e of rowEntries) {
      const basename = e.audioFile.name.replace(/\.[^.]+$/, '');
      const slug = basename.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
      e.recId = `${libSelect.value}-${slug}-${Date.now().toString(36)}`;
      if (e.idInput) e.idInput.value = e.recId;
    }
  });

  // ── Upload All button + status ──────────────────────────────────────────
  const uploadBtn = document.createElement('button');
  uploadBtn.className = 'action-btn action-btn-primary';
  uploadBtn.style.marginTop = '14px';
  uploadBtn.textContent = 'Upload All';
  container.appendChild(uploadBtn);

  const statusEl = document.createElement('div');
  statusEl.style.marginTop = '10px';
  container.appendChild(statusEl);

  uploadBtn.addEventListener('click', async () => {
    statusEl.textContent = '';
    statusEl.style.color = '';

    if (rowEntries.length === 0) {
      statusEl.style.color = 'var(--red)';
      statusEl.textContent = 'Select audio files first.';
      return;
    }

    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) {
      statusEl.style.color = 'var(--red)';
      statusEl.textContent = 'Not authenticated. Please sign in again.';
      return;
    }

    const libId = libSelect.value;
    uploadBtn.disabled = true;

    let okCount = 0;
    const errors = [];

    for (let i = 0; i < rowEntries.length; i++) {
      const entry = rowEntries[i];
      uploadBtn.textContent = `Uploading ${i + 1} / ${rowEntries.length}…`;
      entry.setStatus('Uploading audio…', 'work');

      try {
        // 1) Get the transcript text up front (so we fail fast before audio upload)
        let transcriptText = null;
        if (entry.mode === 'paste') {
          transcriptText = (entry.pastedText || '').trim();
          if (!transcriptText) throw new Error('Pasted transcript is empty');
        } else if (entry.mode === 'file') {
          if (!entry.transcriptFile) throw new Error('No transcript file selected');
          transcriptText = await extractTextFromFile(entry.transcriptFile);
          if (!transcriptText.trim()) throw new Error('Transcript file produced empty text');
        }

        // 2) Upload audio
        const audioName = entry.displayName.value.trim() || entry.audioFile.name.replace(/\.[^.]+$/, '');
        const audioRecId = entry.idInput.value.trim() || entry.recId;
        const audioUrl = await uploadFileToR2(entry.audioFile, libId, session.access_token);

        // 3) Insert audio_files row
        {
          const { error } = await supabase.from('audio_files').insert({
            id: audioRecId,
            name: audioName,
            r2_link: audioUrl,
            library_id: libId,
            is_selected_50hr: false,
            is_benchmark: false,
          });
          if (error) throw new Error('Audio DB insert failed: ' + error.message);
        }
        logActivity('file_uploaded', audioRecId, audioName, { type: 'audio', libraryId: libId });

        // 4) If a transcript was provided, upload it + insert + map
        if (transcriptText) {
          entry.setStatus('Uploading transcript…', 'work');
          const transcriptRecId = `${audioRecId}-transcript`;
          const transcriptName = `${audioName} — transcript`;
          const txtBlob = new Blob([transcriptText], { type: 'text/plain; charset=utf-8' });
          const txtFile = new File([txtBlob], `${audioRecId}.txt`, { type: 'text/plain; charset=utf-8' });
          const transcriptUrl = await uploadFileToR2(txtFile, libId, session.access_token);

          {
            const { error } = await supabase.from('transcripts').insert({
              id: transcriptRecId,
              name: transcriptName,
              r2_transcript_link: transcriptUrl,
              text: transcriptText,
              library_id: libId,
            });
            if (error) throw new Error('Transcript DB insert failed: ' + error.message);
          }
          logActivity('file_uploaded', transcriptRecId, transcriptName, { type: 'transcript', libraryId: libId });

          // Mapping: link audio → transcript at confidence 1 (manually paired)
          {
            const { error } = await supabase.from('mappings').insert({
              audio_id: audioRecId,
              transcript_id: transcriptRecId,
              confidence: 1,
              match_reason: 'bulk-upload paired',
              confirmed_by: session.user?.email || null,
              library_id: libId,
            });
            if (error) throw new Error('Mapping insert failed: ' + error.message);
          }
          logActivity('mapping_confirmed', audioRecId, audioName, { transcriptId: transcriptRecId });
        }

        entry.setStatus('Done', 'ok');
        okCount++;
      } catch (err) {
        entry.setStatus('Error: ' + err.message, 'err');
        errors.push(`${entry.audioFile.name}: ${err.message}`);
      }
    }

    uploadBtn.disabled = false;
    uploadBtn.textContent = 'Upload All';
    if (errors.length === 0) {
      statusEl.style.color = 'var(--green)';
      statusEl.textContent = `All ${okCount} files uploaded successfully.`;
    } else {
      statusEl.style.color = okCount > 0 ? 'var(--orange)' : 'var(--red)';
      statusEl.innerHTML = `${okCount} succeeded, ${errors.length} failed.<br><span class="text-secondary" style="font-size:0.8rem">${esc(errors.join('  •  '))}</span>`;
    }
  });
}

// Build a single row in the bulk-upload list. Returns an entry object with
// references to its inputs and a setStatus(text, kind) helper.
function createBulkRow(audioFile, libId) {
  const entry = {
    audioFile,
    displayName: null,
    idInput: null,
    recId: '',
    mode: 'none',
    transcriptFile: null,
    pastedText: '',
    rowEl: null,
    setStatus: () => {},
  };

  const wrap = document.createElement('div');
  wrap.style.cssText = 'border:1px solid var(--border);border-radius:var(--radius-lg);padding:12px 14px;background:var(--surface);';

  const head = document.createElement('div');
  head.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px;';
  const title = document.createElement('div');
  title.style.cssText = 'font-weight:600;font-size:0.9rem;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
  title.textContent = `🎵 ${audioFile.name}`;
  title.title = audioFile.name;
  const sizeLabel = document.createElement('span');
  sizeLabel.className = 'text-secondary';
  sizeLabel.style.fontSize = '0.78rem';
  sizeLabel.textContent = `${(audioFile.size / 1024 / 1024).toFixed(1)} MB`;
  head.appendChild(title);
  head.appendChild(sizeLabel);
  wrap.appendChild(head);

  // Display name + Record ID inputs (compact two-column)
  const metaRow = document.createElement('div');
  metaRow.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px;';

  const nameWrap = document.createElement('div');
  const nameLab = document.createElement('label');
  nameLab.textContent = 'Display Name';
  nameLab.style.cssText = 'font-size:0.74rem;font-weight:600;color:var(--text-secondary);display:block;margin-bottom:3px;';
  const nameInput = document.createElement('input');
  nameInput.className = 'admin-input';
  const baseName = audioFile.name.replace(/\.[^.]+$/, '');
  nameInput.value = baseName;
  nameWrap.appendChild(nameLab);
  nameWrap.appendChild(nameInput);

  const idWrap = document.createElement('div');
  const idLab = document.createElement('label');
  idLab.textContent = 'Record ID';
  idLab.style.cssText = 'font-size:0.74rem;font-weight:600;color:var(--text-secondary);display:block;margin-bottom:3px;';
  const idInput = document.createElement('input');
  idInput.className = 'admin-input';
  const slug = baseName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const recId = `${libId}-${slug}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
  idInput.value = recId;
  idWrap.appendChild(idLab);
  idWrap.appendChild(idInput);

  metaRow.appendChild(nameWrap);
  metaRow.appendChild(idWrap);
  wrap.appendChild(metaRow);

  entry.displayName = nameInput;
  entry.idInput = idInput;
  entry.recId = recId;

  // ── Transcript section ──────────────────────────────────────────────────
  const trWrap = document.createElement('div');
  trWrap.style.cssText = 'border-top:1px dashed var(--border);padding-top:10px;';

  const trHead = document.createElement('div');
  trHead.style.cssText = 'display:flex;align-items:center;gap:14px;margin-bottom:8px;flex-wrap:wrap;';
  const trLabel = document.createElement('span');
  trLabel.style.cssText = 'font-size:0.78rem;font-weight:600;color:var(--text-secondary);';
  trLabel.textContent = 'Transcript:';
  trHead.appendChild(trLabel);

  const radioGroupName = `tr-mode-${recId}`;
  const modes = [
    { value: 'none',  label: 'None' },
    { value: 'file',  label: 'Upload .docx / .txt' },
    { value: 'paste', label: 'Paste text' },
  ];
  for (const m of modes) {
    const radioLab = document.createElement('label');
    radioLab.style.cssText = 'display:inline-flex;align-items:center;gap:4px;font-size:0.82rem;cursor:pointer;';
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = radioGroupName;
    radio.value = m.value;
    if (m.value === 'none') radio.checked = true;
    radio.addEventListener('change', () => {
      if (radio.checked) {
        entry.mode = m.value;
        fileBlock.style.display = m.value === 'file' ? '' : 'none';
        pasteBlock.style.display = m.value === 'paste' ? '' : 'none';
      }
    });
    radioLab.appendChild(radio);
    radioLab.appendChild(document.createTextNode(m.label));
    trHead.appendChild(radioLab);
  }
  trWrap.appendChild(trHead);

  // File picker block
  const fileBlock = document.createElement('div');
  fileBlock.style.display = 'none';
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.className = 'admin-input';
  fileInput.accept = '.docx,.txt,.doc';
  const fileInfo = document.createElement('div');
  fileInfo.className = 'text-secondary';
  fileInfo.style.cssText = 'font-size:0.75rem;margin-top:4px;';
  fileInput.addEventListener('change', async () => {
    const f = fileInput.files?.[0];
    entry.transcriptFile = f || null;
    if (!f) { fileInfo.textContent = ''; return; }
    fileInfo.textContent = 'Parsing…';
    try {
      const text = await extractTextFromFile(f);
      const wordCount = text.trim().split(/\s+/).filter(Boolean).length;
      fileInfo.style.color = 'var(--green)';
      fileInfo.textContent = `✓ Parsed ${wordCount.toLocaleString()} words from ${f.name}`;
    } catch (err) {
      fileInfo.style.color = 'var(--red)';
      fileInfo.textContent = '✗ ' + err.message;
    }
  });
  fileBlock.appendChild(fileInput);
  fileBlock.appendChild(fileInfo);
  trWrap.appendChild(fileBlock);

  // Paste block
  const pasteBlock = document.createElement('div');
  pasteBlock.style.display = 'none';
  const pasteArea = document.createElement('textarea');
  pasteArea.className = 'admin-input';
  pasteArea.rows = 6;
  pasteArea.placeholder = 'Paste transcript text here…';
  pasteArea.style.cssText = 'font-family:inherit;resize:vertical;direction:rtl;text-align:right;';
  pasteArea.addEventListener('input', () => {
    entry.pastedText = pasteArea.value;
  });
  pasteBlock.appendChild(pasteArea);
  trWrap.appendChild(pasteBlock);

  wrap.appendChild(trWrap);

  // Status line
  const statusLine = document.createElement('div');
  statusLine.style.cssText = 'margin-top:8px;font-size:0.78rem;min-height:1em;';
  wrap.appendChild(statusLine);

  entry.setStatus = (text, kind) => {
    statusLine.textContent = text || '';
    if (kind === 'ok')   statusLine.style.color = 'var(--green)';
    else if (kind === 'err')  statusLine.style.color = 'var(--red)';
    else if (kind === 'work') statusLine.style.color = 'var(--accent)';
    else statusLine.style.color = '';
  };

  entry.rowEl = wrap;
  return entry;
}

// Read text from a Word/.docx, .txt, or .doc file. Word docs are parsed via
// mammoth (loaded on demand to keep the admin bundle small). .txt files are
// read as UTF-8.
async function extractTextFromFile(file) {
  const lower = file.name.toLowerCase();
  if (lower.endsWith('.docx')) {
    const { default: mammoth } = await import('mammoth');
    const buf = await file.arrayBuffer();
    const result = await mammoth.extractRawText({ arrayBuffer: buf });
    return result.value || '';
  }
  if (lower.endsWith('.txt')) {
    return await file.text();
  }
  if (lower.endsWith('.doc')) {
    throw new Error('Legacy .doc not supported — please save as .docx or .txt');
  }
  return await file.text();
}

// Upload a File or Blob to R2 via the presigned-PUT flow used by the single
// upload form. Returns the public R2 URL of the uploaded object.
async function uploadFileToR2(file, libId, accessToken) {
  const safeFilename = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
  const key = `${libId}/${safeFilename}`;

  const signRes = await fetch('/api/upload-url', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ key, contentType: file.type || 'application/octet-stream' }),
  });
  const signText = await signRes.text();
  let signed;
  try { signed = JSON.parse(signText); } catch {
    throw new Error(`sign URL HTTP ${signRes.status}: ${signText.slice(0, 200)}`);
  }
  if (!signRes.ok) throw new Error(signed.error || `sign URL HTTP ${signRes.status}`);

  const putRes = await fetch(signed.url, {
    method: 'PUT',
    headers: { 'Content-Type': signed.contentType },
    body: file,
  });
  if (!putRes.ok) {
    const body = await putRes.text().catch(() => '');
    throw new Error(`R2 PUT failed HTTP ${putRes.status}: ${body.slice(0, 200)}`);
  }
  return signed.publicUrl;
}

// ── Activity panel ───────────────────────────────────────────────────────────

const ACTION_LABELS = {
  mapping_confirmed: 'Mapping confirmed',
  mapping_removed: 'Mapping removed',
  cleaning_run: 'Cleaning run',
  transcript_edited: 'Transcript edited',
  alignment_completed: 'Alignment completed',
  review_approved: 'Review approved',
  review_rejected: 'Review rejected',
  segment_approved: 'Segment approved',
  segment_unapproved: 'Segment unapproved',
  file_uploaded: 'File uploaded',
  member_invited: 'Member invited',
  member_removed: 'Member removed',
  role_changed: 'Role changed',
};

const ACTION_COLORS = {
  mapping_confirmed: 'blue',
  mapping_removed: 'red',
  cleaning_run: 'cyan',
  transcript_edited: 'gray',
  alignment_completed: 'orange',
  review_approved: 'green',
  review_rejected: 'red',
  segment_approved: 'green',
  segment_unapproved: 'red',
  file_uploaded: 'gray',
  member_invited: 'blue',
  member_removed: 'red',
  role_changed: 'gray',
};

const PAGE_SIZE = 50;

function renderActivityPanel(container, adminLibs) {
  container.innerHTML = '';

  const heading = document.createElement('h2');
  heading.className = 'admin-section-title';
  heading.textContent = 'Activity Log';
  container.appendChild(heading);

  // ── Filter row ────────────────────────────────────────────────────────
  const filterRow = document.createElement('div');
  filterRow.className = 'admin-form admin-form-inline';
  filterRow.style.marginBottom = '1rem';

  // Library picker
  const libSelect = document.createElement('select');
  libSelect.className = 'filter-select';
  for (const lib of adminLibs) {
    const opt = document.createElement('option');
    opt.value = lib.id;
    opt.textContent = lib.name;
    libSelect.appendChild(opt);
  }

  // User filter
  const userSelect = document.createElement('select');
  userSelect.className = 'filter-select';
  userSelect.innerHTML = '<option value="">All users</option>';

  // Action filter
  const actionSelect = document.createElement('select');
  actionSelect.className = 'filter-select';
  actionSelect.innerHTML = '<option value="">All actions</option>';
  for (const [val, label] of Object.entries(ACTION_LABELS)) {
    const opt = document.createElement('option');
    opt.value = val;
    opt.textContent = label;
    actionSelect.appendChild(opt);
  }

  // Date range filter
  const dateSelect = document.createElement('select');
  dateSelect.className = 'filter-select';
  for (const [val, label] of [['7', 'Last 7 days'], ['30', 'Last 30 days'], ['90', 'Last 90 days'], ['', 'All time']]) {
    const opt = document.createElement('option');
    opt.value = val;
    opt.textContent = label;
    dateSelect.appendChild(opt);
  }

  if (adminLibs.length > 1) filterRow.appendChild(libSelect);
  filterRow.appendChild(userSelect);
  filterRow.appendChild(actionSelect);
  filterRow.appendChild(dateSelect);
  container.appendChild(filterRow);

  // ── Results area ──────────────────────────────────────────────────────
  const resultsArea = document.createElement('div');
  container.appendChild(resultsArea);

  let currentPage = 0;

  async function loadActivity() {
    resultsArea.innerHTML = '<div class="text-secondary" style="padding:1rem">Loading activity…</div>';

    const libraryId = libSelect.value;
    let query = supabase
      .from('activity_log')
      .select('*', { count: 'exact' })
      .eq('library_id', libraryId)
      .order('created_at', { ascending: false })
      .range(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE - 1);

    if (userSelect.value) query = query.eq('user_email', userSelect.value);
    if (actionSelect.value) query = query.eq('action', actionSelect.value);
    if (dateSelect.value) {
      const d = new Date();
      d.setDate(d.getDate() - parseInt(dateSelect.value));
      query = query.gte('created_at', d.toISOString());
    }

    const { data, error, count } = await query;
    if (error) {
      resultsArea.innerHTML = `<div class="admin-error">${esc(error.message)}</div>`;
      return;
    }

    renderActivityTable(resultsArea, data || [], count || 0);
  }

  // Populate user filter from distinct emails
  async function loadUsers() {
    const { data } = await supabase
      .from('activity_log')
      .select('user_email')
      .eq('library_id', libSelect.value);
    const emails = [...new Set((data || []).map(r => r.user_email))].sort();
    userSelect.innerHTML = '<option value="">All users</option>';
    for (const email of emails) {
      const opt = document.createElement('option');
      opt.value = email;
      opt.textContent = email;
      userSelect.appendChild(opt);
    }
  }

  function renderActivityTable(container, rows, totalCount) {
    container.innerHTML = '';

    if (rows.length === 0) {
      container.innerHTML = '<div class="empty-state"><div class="empty-state-title">No activity yet</div><div class="empty-state-sub">Actions will appear here as users work in the app.</div></div>';
      return;
    }

    const table = document.createElement('table');
    table.className = 'admin-table';
    table.innerHTML = `
      <thead>
        <tr>
          <th>Time</th>
          <th>User</th>
          <th>Action</th>
          <th>Target</th>
          <th>Details</th>
        </tr>
      </thead>
    `;
    const tbody = document.createElement('tbody');

    for (const row of rows) {
      const tr = document.createElement('tr');

      const tdTime = document.createElement('td');
      tdTime.style.whiteSpace = 'nowrap';
      tdTime.style.fontSize = '0.8rem';
      tdTime.textContent = formatTime(row.created_at);

      const tdUser = document.createElement('td');
      tdUser.textContent = row.user_email;
      tdUser.style.fontSize = '0.8rem';

      const tdAction = document.createElement('td');
      const badge = document.createElement('span');
      badge.className = 'status-badge';
      const color = ACTION_COLORS[row.action] || 'gray';
      badge.style.background = `var(--${color}-dim, var(--gray-dim))`;
      badge.style.color = `var(--${color}, var(--gray))`;
      badge.textContent = ACTION_LABELS[row.action] || row.action;
      tdAction.appendChild(badge);

      const tdTarget = document.createElement('td');
      tdTarget.style.fontSize = '0.8rem';
      tdTarget.className = 'admin-cell-mono';
      if (row.target_name) {
        tdTarget.textContent = row.target_name;
        tdTarget.title = row.target_id || '';
      } else if (row.target_id) {
        tdTarget.textContent = row.target_id;
      }

      const tdDetails = document.createElement('td');
      tdDetails.style.fontSize = '0.78rem';
      tdDetails.style.color = 'var(--text-secondary)';
      const d = row.details || {};
      const parts = Object.entries(d).map(([k, v]) => `${k}: ${v}`);
      tdDetails.textContent = parts.join(', ');

      tr.appendChild(tdTime);
      tr.appendChild(tdUser);
      tr.appendChild(tdAction);
      tr.appendChild(tdTarget);
      tr.appendChild(tdDetails);
      tbody.appendChild(tr);
    }

    table.appendChild(tbody);
    container.appendChild(table);

    // ── Pagination ──────────────────────────────────────────────────────
    const totalPages = Math.ceil(totalCount / PAGE_SIZE);
    if (totalPages > 1) {
      const pag = document.createElement('div');
      pag.style.cssText = 'display:flex;align-items:center;gap:8px;padding:12px 0;font-size:0.82rem;';

      const prevBtn = document.createElement('button');
      prevBtn.className = 'action-btn action-btn-secondary';
      prevBtn.textContent = 'Prev';
      prevBtn.disabled = currentPage === 0;
      prevBtn.addEventListener('click', () => { currentPage--; loadActivity(); });

      const info = document.createElement('span');
      info.className = 'text-secondary';
      info.textContent = `Page ${currentPage + 1} of ${totalPages} (${totalCount} total)`;

      const nextBtn = document.createElement('button');
      nextBtn.className = 'action-btn action-btn-secondary';
      nextBtn.textContent = 'Next';
      nextBtn.disabled = currentPage >= totalPages - 1;
      nextBtn.addEventListener('click', () => { currentPage++; loadActivity(); });

      pag.appendChild(prevBtn);
      pag.appendChild(info);
      pag.appendChild(nextBtn);
      container.appendChild(pag);
    }
  }

  // Wire up filter changes
  libSelect.addEventListener('change', () => { currentPage = 0; loadUsers(); loadActivity(); });
  userSelect.addEventListener('change', () => { currentPage = 0; loadActivity(); });
  actionSelect.addEventListener('change', () => { currentPage = 0; loadActivity(); });
  dateSelect.addEventListener('change', () => { currentPage = 0; loadActivity(); });

  // Initial load
  loadUsers();
  loadActivity();
}

function formatTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now - d;
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDays = Math.floor(diffHr / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: d.getFullYear() !== now.getFullYear() ? 'numeric' : undefined });
}

// ── Utils ─────────────────────────────────────────────────────────────────

function esc(str) {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
