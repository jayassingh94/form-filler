import { SCHEMA, newProfile, getPath, setPath } from '../lib/schema.js';
import { loadVault, saveVault, lock, changePin, exportBackup, importBackup, deleteAll, isSetUp, DEFAULT_MODEL } from '../lib/vault.js';
import { showLock, onLocked, addPinReveal, hideAllPins } from '../lib/lockui.js';
import { addDocument, removeDocument, docBlob, formatSize, guessTags, fileExt } from '../lib/docs.js';
import { testGemini, aiMode, quotaToday, serviceConfigured } from '../lib/ai.js';
import { demoProfile } from '../lib/demo.js';
import { openImageEditor } from '../lib/imgedit.js';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let vault = null;
let currentId = null;
const objectUrls = [];

// ---------------- boot / lock ----------------
async function boot() {
  $('#app').classList.add('hidden');
  $('#lock-now').classList.add('hidden');
  revokeUrls();
  vault = null;
  await showLock($('#lock'));
  try {
    vault = await loadVault();
  } catch (e) {
    return boot();
  }
  $('#app').classList.remove('hidden');
  $('#lock-now').classList.remove('hidden');
  currentId = vault.profiles[0]?.id;
  renderProfiles();
  renderDocs();
  renderSettings();
  const tab = location.hash.slice(1);
  if (tab) selectTab(tab);
}

onLocked(() => { hideAllPins(); boot(); });
$('#lock-now').onclick = () => lock();
['#pin-old', '#pin-new', '#pin-new2'].forEach((s) => addPinReveal($(s)));

async function persist() {
  try {
    await saveVault(vault);
    return true;
  } catch (e) {
    if (e.message === 'LOCKED') boot();
    else alert('Could not save: ' + e.message);
    return false;
  }
}

// ---------------- tabs ----------------
function selectTab(name) {
  $$('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  $$('[data-panel]').forEach((p) => p.classList.toggle('hidden', p.dataset.panel !== name));
  history.replaceState(null, '', '#' + name);
  if (name === 'settings') renderSites();
}
$$('#tabs button').forEach((b) => (b.onclick = () => selectTab(b.dataset.tab)));

// ---------------- profiles ----------------
const profile = () => vault.profiles.find((p) => p.id === currentId);

function renderProfiles() {
  const sel = $('#profile-select');
  sel.innerHTML = vault.profiles.map((p) => `<option value="${p.id}">${esc(p.label)}</option>`).join('');
  sel.value = currentId;
  $('#profile-delete').disabled = vault.profiles.length < 2;
  renderProfileForm();
  renderCustom();
}

$('#profile-select').onchange = (e) => { currentId = e.target.value; renderProfileForm(); renderCustom(); };
$('#profile-add').onclick = async () => {
  const label = prompt('Name for the new profile (e.g. "Husband"):');
  if (!label) return;
  const p = newProfile(label.trim());
  vault.profiles.push(p);
  currentId = p.id;
  await persist();
  renderProfiles();
};
$('#profile-demo').onclick = async () => {
  const p = demoProfile();
  vault.profiles.push(p);
  currentId = p.id;
  await persist();
  renderProfiles();
};
$('#profile-rename').onclick = async () => {
  const label = prompt('Rename profile:', profile().label);
  if (!label) return;
  profile().label = label.trim();
  await persist();
  renderProfiles();
};
$('#profile-delete').onclick = async () => {
  if (vault.profiles.length < 2) return;
  if (!confirm(`Delete profile "${profile().label}"? This cannot be undone.`)) return;
  vault.profiles = vault.profiles.filter((p) => p.id !== currentId);
  currentId = vault.profiles[0].id;
  await persist();
  renderProfiles();
};

function inputFor(sec, f, val) {
  const id = `f-${sec.id}.${f.k}`.replace(/\./g, '_');
  const key = `${sec.id}.${f.k}`;
  if (f.t === 'checkbox') {
    return `<label class="check wide"><input type="checkbox" id="${id}" data-key="${key}" ${val ? 'checked' : ''}> ${esc(f.l)}</label>`;
  }
  let ctl;
  if (f.t === 'select') {
    ctl = `<select id="${id}" data-key="${key}">${f.o.map((o) => `<option value="${esc(o)}" ${o === val ? 'selected' : ''}>${o ? esc(o) : '—'}</option>`).join('')}</select>`;
  } else if (f.t === 'textarea') {
    ctl = `<textarea id="${id}" data-key="${key}" rows="2">${esc(val)}</textarea>`;
  } else {
    const type = f.t === 'date' ? 'date' : f.t === 'email' ? 'email' : f.t === 'tel' ? 'tel' : 'text';
    ctl = `<input id="${id}" type="${type}" data-key="${key}" value="${esc(val)}" autocomplete="off">`;
  }
  return `<label class="${f.t === 'textarea' ? 'wide' : ''}"><span>${esc(f.l)}</span>${ctl}</label>`;
}

function renderProfileForm() {
  const p = profile();
  const open = new Set($$('#profile-form details[open]').map((d) => d.dataset.sec));
  if (!open.size) ['personal', 'contact'].forEach((s) => open.add(s));
  $('#profile-form').innerHTML = SCHEMA.map((sec) => {
    const filled = sec.fields.filter((f) => { const v = getPath(p, `${sec.id}.${f.k}`); return v && v !== ''; }).length;
    return `<details class="card section" data-sec="${sec.id}" ${open.has(sec.id) ? 'open' : ''}>
      <summary><h3>${esc(sec.title)}</h3><span class="count">${filled}/${sec.fields.length} filled</span></summary>
      <div class="fields">${sec.fields.map((f) => inputFor(sec, f, getPath(p, `${sec.id}.${f.k}`) ?? '')).join('')}</div>
    </details>`;
  }).join('');
}

let saveTimer;
async function flushSave() {
  if (!saveTimer) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  await persist();
}
function scheduleSave() {
  $('#save-state').textContent = 'Saving…';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    if (await persist()) $('#save-state').textContent = '✓ Saved (encrypted)';
  }, 500);
}

$('#profile-form').addEventListener('input', (e) => {
  const key = e.target.dataset.key;
  if (!key) return;
  setPath(profile(), key, e.target.type === 'checkbox' ? e.target.checked : e.target.value);
  scheduleSave();
});
$('#profile-form').addEventListener('change', (e) => {
  if (e.target.type === 'checkbox' || e.target.tagName === 'SELECT') {
    setPath(profile(), e.target.dataset.key, e.target.type === 'checkbox' ? e.target.checked : e.target.value);
    scheduleSave();
  }
});

function renderCustom() {
  const list = profile().custom;
  $('#custom-list').innerHTML = list.map((c, i) => `
    <div class="custom-row" data-i="${i}">
      <input placeholder="Field name, e.g. Employee ID" data-f="label" value="${esc(c.label)}">
      <input placeholder="Value" data-f="value" value="${esc(c.value)}">
      <button class="danger" data-del="${i}" title="Remove">✕</button>
    </div>`).join('') || '<p class="muted small">No custom fields yet.</p>';
}
$('#custom-list').addEventListener('input', (e) => {
  const row = e.target.closest('.custom-row');
  if (!row) return;
  profile().custom[Number(row.dataset.i)][e.target.dataset.f] = e.target.value;
  scheduleSave();
});
$('#custom-list').addEventListener('click', (e) => {
  const i = e.target.dataset.del;
  if (i === undefined) return;
  profile().custom.splice(Number(i), 1);
  renderCustom();
  scheduleSave();
});
$('#custom-add').onclick = () => {
  profile().custom.push({ label: '', value: '' });
  renderCustom();
  $$('#custom-list .custom-row input[data-f=label]').pop()?.focus();
};

// ---------------- documents ----------------
function revokeUrls() {
  while (objectUrls.length) URL.revokeObjectURL(objectUrls.pop());
}

async function renderDocs() {
  revokeUrls();
  const q = $('#doc-search').value.trim().toLowerCase();
  const docs = vault.docs.filter((d) => !q || d.name.toLowerCase().includes(q) || d.tags.some((t) => t.includes(q)));
  const grid = $('#doc-grid');
  if (!vault.docs.length) {
    grid.innerHTML = '<p class="muted">No documents yet. Add your photo, signature, marksheets and certificates.</p>';
    return;
  }
  grid.innerHTML = docs.map((d) => `
    <div class="card doc" data-id="${d.id}">
      <div class="thumb">${/^image\//.test(d.type) ? '<img alt="">' : `<span class="ext">${esc(fileExt(d))}</span>`}</div>
      <b>${esc(d.name)}</b>
      <div class="meta">${formatSize(d.size)}${d.width ? ` · ${d.width}×${d.height} px` : ''} · ${esc(d.type)}</div>
      <div>${d.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>
      <div class="actions">
        ${/^image\//.test(d.type) ? '<button data-act="crop">Crop &amp; resize…</button>' : ''}
        <button data-act="edit">Rename / tags</button>
        <button data-act="download">Download</button>
        <button data-act="delete" class="danger">Delete</button>
      </div>
    </div>`).join('');
  for (const d of docs) {
    if (!/^image\//.test(d.type)) continue;
    try {
      const url = URL.createObjectURL(await docBlob(d));
      objectUrls.push(url);
      const img = $(`.doc[data-id="${d.id}"] img`, grid);
      if (img) img.src = url;
    } catch { /* locked meanwhile */ }
  }
}

$('#doc-search').oninput = () => renderDocs();
$('#doc-input').onchange = async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  await flushSave();
  for (const f of files) {
    const name = prompt(`Name for "${f.name}":`, f.name.replace(/\.[^.]+$/, ''));
    if (name === null) continue;
    const tags = prompt('Tags (comma separated, e.g. photo, signature, marksheet, class10):', guessTags(f.name).join(', '));
    try {
      const ext = (f.name.match(/\.[a-z0-9]+$/i) || [''])[0];
      const meta = await addDocument(f, { name: (name.trim() || f.name).replace(/(\.[a-z0-9]+)?$/i, ext || '$1'), tags: splitTags(tags) });
      vault.docs.push(meta);
    } catch (err) {
      alert(err.message === 'LOCKED' ? 'Locked. Unlock and try again.' : err.message);
    }
  }
  vault = await loadVault();
  renderDocs();
};
const splitTags = (s) => String(s || '').split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);

$('#doc-grid').addEventListener('click', async (e) => {
  const act = e.target.dataset.act;
  const card = e.target.closest('.doc');
  if (!act || !card) return;
  const d = vault.docs.find((x) => x.id === card.dataset.id);
  await flushSave();
  if (act === 'delete') {
    if (!confirm(`Delete "${d.name}"?`)) return;
    await removeDocument(d.id);
    vault = await loadVault();
    renderDocs();
  } else if (act === 'edit') {
    const name = prompt('Name:', d.name);
    if (name === null) return;
    const tags = prompt('Tags (comma separated):', d.tags.join(', '));
    d.name = name.trim() || d.name;
    if (tags !== null) d.tags = splitTags(tags);
    await persist();
    renderDocs();
  } else if (act === 'crop') {
    const dlg = $('#edit-dialog');
    const host = $('#edit-host');
    dlg.showModal();
    const close = () => { dlg.close(); host.innerHTML = ''; };
    try {
      await openImageEditor(host, {
        blob: await docBlob(d), name: d.name, rule: {}, primaryLabel: 'Save to locker',
        onCancel: close,
        onDone: async (out, info) => {
          await addDocument(out, { name: info.name, tags: [...new Set([...d.tags, info.kind, 'resized'])] });
          vault = await loadVault();
          close();
          renderDocs();
        }
      });
    } catch (err) {
      close();
      alert('Could not open this image: ' + err.message);
    }
  } else if (act === 'download') {
    const url = URL.createObjectURL(await docBlob(d));
    const a = Object.assign(document.createElement('a'), { href: url, download: d.name });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
});

// ---------------- settings ----------------
function renderSettings() {
  $('#api-key').value = vault.settings.apiKey || '';
  $('#model').value = vault.settings.model || DEFAULT_MODEL;
  $('#highlight').checked = !!vault.settings.highlight;
  const mode = aiMode(vault.settings);
  document.querySelectorAll('input[name=ai-mode]').forEach((r) => { r.checked = r.value === mode; });
  showModeFields();
  quotaToday().then((left) => { $('#quota-note').textContent = left != null ? `${left} left today.` : ''; });
}
const msg = (el, text, cls = 'muted') => { el.className = 'small ' + cls; el.textContent = text; };

$('#highlight').onchange = async (e) => {
  vault.settings.highlight = e.target.checked;
  if (await persist()) msg($('#fill-msg'), e.target.checked ? '✓ Fields will be highlighted on the page.' : '✓ No highlighting: the summary appears in the popup.', 'ok');
};

const selectedMode = () => document.querySelector('input[name=ai-mode]:checked')?.value || 'service';
function showModeFields() {
  $('#own-key').classList.toggle('hidden', selectedMode() !== 'own');
  $('#service-missing').classList.toggle('hidden', !(selectedMode() === 'service' && !serviceConfigured()));
}
document.querySelectorAll('input[name=ai-mode]').forEach((r) => r.addEventListener('change', showModeFields));

$('#api-key-show').onclick = () => {
  const i = $('#api-key');
  i.type = i.type === 'password' ? 'text' : 'password';
  $('#api-key-show').textContent = i.type === 'password' ? 'Show' : 'Hide';
};
$('#settings-save').onclick = async () => {
  vault.settings.aiMode = selectedMode();
  vault.settings.apiKey = $('#api-key').value.trim();
  vault.settings.model = $('#model').value.trim() || DEFAULT_MODEL;
  if (await persist()) msg($('#settings-msg'), '✓ Saved (encrypted)', 'ok');
};
$('#api-test').onclick = async () => {
  msg($('#settings-msg'), 'Testing…');
  try {
    const mode = selectedMode();
    if (mode === 'off') return msg($('#settings-msg'), 'AI is off: nothing to test.');
    await testGemini({ aiMode: mode, apiKey: $('#api-key').value.trim(), model: $('#model').value.trim() || DEFAULT_MODEL });
    msg($('#settings-msg'), mode === 'service' ? "✓ Form Filler's AI service is working. Remember to Save." : '✓ Gemini responded. Remember to Save.', 'ok');
  } catch (e) {
    msg($('#settings-msg'), e.message, 'err');
  }
};
$('#pin-change').onclick = async () => {
  const o = $('#pin-old').value, n = $('#pin-new').value, n2 = $('#pin-new2').value;
  if (n !== n2) return msg($('#pin-msg'), 'New PINs do not match.', 'err');
  msg($('#pin-msg'), 'Re-encrypting…');
  try {
    await changePin(o, n);
    ['#pin-old', '#pin-new', '#pin-new2'].forEach((s) => ($(s).value = ''));
    hideAllPins();
    msg($('#pin-msg'), '✓ PIN changed. Old backups still need the old PIN.', 'ok');
  } catch (e) {
    msg($('#pin-msg'), e.message, 'err');
  }
};

async function renderSites() {
  const { origins = [] } = await chrome.permissions.getAll();
  const sites = origins.filter((o) => !o.includes('generativelanguage.googleapis.com'));
  $('#sites').innerHTML = sites.length
    ? sites.map((o) => `<div class="site"><code>${esc(o)}</code><button class="danger" data-origin="${esc(o)}">Remove access</button></div>`).join('')
    : '<p class="muted small">No sites yet.</p>';
}
$('#sites').addEventListener('click', async (e) => {
  const o = e.target.dataset.origin;
  if (!o) return;
  await chrome.permissions.remove({ origins: [o] });
  renderSites();
});

// ---------------- backup & delete ----------------
$('#export').onclick = async () => {
  try {
    const data = await exportBackup();
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement('a'), { href: url, download: `form-filler-backup-${new Date().toISOString().slice(0, 10)}.json` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  } catch (e) {
    if (e.message === 'LOCKED') boot(); else alert(e.message);
  }
};
$('#import').onchange = async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  let data;
  try { data = JSON.parse(await f.text()); } catch { return msg($('#import-msg'), 'Not a valid backup file.', 'err'); }
  if (!confirm('Importing replaces ALL current profiles, documents and settings. Continue?')) return;
  try {
    await importBackup(data);
    boot();
  } catch (err) {
    msg($('#import-msg'), err.message, 'err');
  }
};
$('#delete-all').onclick = async () => {
  if ($('#delete-confirm').value !== 'DELETE') return alert('Type DELETE in the box to confirm.');
  await deleteAll();
  const { origins = [] } = await chrome.permissions.getAll();
  const sites = origins.filter((o) => !o.includes('generativelanguage.googleapis.com'));
  if (sites.length) await chrome.permissions.remove({ origins: sites }).catch(() => {});
  $('#delete-confirm').value = '';
  alert('All Form Filler data has been deleted.');
  boot();
};

if (!(await isSetUp())) selectTab('profiles');
boot();
