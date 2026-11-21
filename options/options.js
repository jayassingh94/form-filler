import { SCHEMA, newProfile, getPath, setPath } from '../lib/schema.js';
import { loadVault, saveVault, lock, changePin, exportBackup, importBackup, deleteAll, isSetUp, DEFAULT_MODEL } from '../lib/vault.js';
import { showLock, onLocked, addPinReveal, hideAllPins } from '../lib/lockui.js';
import { addDocument, removeDocument, docBlob, formatSize, guessTags, fileExt } from '../lib/docs.js';
import { testGemini, aiMode, quotaToday, serviceConfigured } from '../lib/ai.js';
import { demoProfile } from '../lib/demo.js';
import { openImageEditor } from '../lib/imgedit.js';
import { icon, ART, CHECK_ANIM } from '../lib/icons.js';
import { toast } from '../lib/toast.js';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let vault = null;
let currentId = null;
const objectUrls = [];

/** Fill <span data-icon="x"></span> placeholders and prepend icons to buttons/links with data-icon. */
function hydrateIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach((el) => {
    if (el.dataset.iconDone) return;
    el.dataset.iconDone = '1';
    const svg = icon(el.dataset.icon, el.classList.contains('ic') ? 20 : 17);
    if (el.tagName === 'SPAN' && !el.textContent.trim()) el.innerHTML = svg;
    else el.insertAdjacentHTML('afterbegin', svg);
  });
}
hydrateIcons();
const SECTION_ICONS = { personal: 'user', family: 'user', contact: 'globe', permanentAddress: 'pin', currentAddress: 'pin',
  category: 'shield', education: 'file', experience: 'folder', other: 'edit' };

// ---------------- boot / lock ----------------
async function boot() {
  $('#app').classList.add('hidden');
  $('#lock-now').classList.add('hidden');
  $('#tabs').classList.add('hidden');
  revokeUrls();
  vault = null;
  $('#boot-skel').classList.add('hidden');
  if (!(await isSetUp())) {
    // first run: Create PIN → Fill your profile → Try it
    await onboarding();
  }
  await showLock($('#lock'));
  try {
    vault = await loadVault();
  } catch (e) {
    return boot();
  }
  $('#app').classList.remove('hidden');
  $('#lock-now').classList.remove('hidden');
  $('#tabs').classList.remove('hidden');
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
  renderAvatar();
  renderProfileForm();
  renderCustom();
}

function renderAvatar() {
  const words = (profile()?.label || '?').replace(/\(.*?\)/g, '').trim().split(/\s+/);
  $('#profile-avatar').textContent = (words[0]?.[0] || '?').toUpperCase() + (words[1]?.[0] || '').toUpperCase();
}
$('#profile-select').onchange = (e) => { currentId = e.target.value; renderAvatar(); renderProfileForm(); renderCustom(); };
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
      <summary><span class="sec-ic">${icon(SECTION_ICONS[sec.id] || 'file', 16)}</span><h3>${esc(sec.title)}</h3>
        <span class="count"><span class="meter" aria-hidden="true"><i style="width:${Math.round(100 * filled / sec.fields.length)}%"></i></span>${filled}/${sec.fields.length} filled</span></summary>
      <div class="sec-body"><div class="fields">${sec.fields.map((f) => inputFor(sec, f, getPath(p, `${sec.id}.${f.k}`) ?? '')).join('')}</div></div>
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
  $('#save-state').classList.remove('saved');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    if (await persist()) { $('#save-state').textContent = 'Saved · encrypted'; $('#save-state').classList.add('saved'); }
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
      <button class="ghost danger-text" data-del="${i}" title="Remove" aria-label="Remove">${icon('trash', 16)}</button>
    </div>`).join('') || `<div class="empty-state compact">${ART.fields}<div><b>No custom fields yet</b><p>Add any detail a form asks for that isn't above.</p></div></div>`;
}
$('#custom-list').addEventListener('input', (e) => {
  const row = e.target.closest('.custom-row');
  if (!row) return;
  profile().custom[Number(row.dataset.i)][e.target.dataset.f] = e.target.value;
  scheduleSave();
});
$('#custom-list').addEventListener('click', (e) => {
  const i = e.target.closest('[data-del]')?.dataset.del;
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
    grid.innerHTML = `<div class="empty-state">${ART.locker}<h3>Your locker is empty</h3>
      <p>Add your photo, signature, marksheets and certificates once. Then attach them to any form with one click,
        resized to the size the form asks for.</p>
      <div class="row"><label class="btn primary">${icon('upload', 17)}Add documents<input type="file" multiple hidden data-proxy="doc-input"></label></div></div>`;
    grid.querySelector('[data-proxy]').onchange = (e) => $('#doc-input').onchange(e);
    return;
  }
  if (!docs.length) {
    grid.innerHTML = `<div class="empty-state compact">${ART.docs}<div><b>No matches</b><p>Nothing matches “${esc(q)}”. Try a name or a tag like photo or signature.</p></div></div>`;
    return;
  }
  grid.innerHTML = docs.map((d) => `
    <div class="card doc fade-in" data-id="${d.id}">
      <div class="thumb${/^image\//.test(d.type) ? ' loading' : ''}">${/^image\//.test(d.type) ? '<img alt="">' : `<span class="ext">${esc(fileExt(d))}</span>`}</div>
      <b class="doc-name">${esc(d.name)}</b>
      <div class="meta">${formatSize(d.size)}${d.width ? ` · ${d.width}×${d.height} px` : ''} · ${esc(d.type)}</div>
      <div class="tags">${d.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>
      <div class="actions">
        ${/^image\//.test(d.type) ? `<button class="ghost" data-act="crop">${icon('crop', 15)}Crop &amp; resize</button>` : ''}
        <button class="ghost" data-act="edit">${icon('edit', 15)}Edit</button>
        <button class="ghost" data-act="download" title="Download" aria-label="Download">${icon('download', 15)}</button>
        <button class="ghost danger-text" data-act="delete" title="Delete" aria-label="Delete">${icon('trash', 15)}</button>
      </div>
    </div>`).join('');
  for (const d of docs) {
    if (!/^image\//.test(d.type)) continue;
    try {
      const url = URL.createObjectURL(await docBlob(d));
      objectUrls.push(url);
      const img = $(`.doc[data-id="${d.id}"] img`, grid);
      if (img) {
        img.onload = () => { img.classList.add('loaded'); img.parentElement.classList.remove('loading'); };
        img.src = url;
      }
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
  const act = e.target.closest('[data-act]')?.dataset.act;
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
// Inline status next to a control; successes also show as a toast (the inline text stays for screen readers).
const msg = (el, text, cls = 'muted') => {
  el.className = 'small ' + (cls === 'ok' ? 'sr-only' : cls);
  el.textContent = text;
  if (cls === 'ok') toast(text.replace(/^✓\s*/, ''));
};

// Appearance (display preference only: localStorage, read by lib/theme.js before paint)
{
  let cur = 'dark';
  try { cur = localStorage.getItem('ff_theme') || 'dark'; } catch { /* blocked */ }
  const r = $(`#theme input[value="${cur}"]`) || $('#theme input[value="dark"]');
  r.checked = true;
  $('#theme').addEventListener('change', (e) => {
    const t = e.target.value;
    try { localStorage.setItem('ff_theme', t); } catch { /* blocked: applies to this page only */ }
    document.documentElement.dataset.theme = t;
    toast(`Theme: ${{ dark: 'Dark', light: 'Light', system: 'Match system' }[t]}`);
  });
}

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
  const required = chrome.runtime.getManifest().host_permissions || []; // Gemini and the AI server: not sites you fill
  const sites = origins.filter((o) => !required.includes(o));
  $('#sites').innerHTML = sites.length
    ? sites.map((o) => `<div class="site"><span class="site-name">${icon('globe', 16)}<span>${esc(o.replace(/\/\*$/, ''))}</span></span>
        <button class="sm danger" data-origin="${esc(o)}">Remove access</button></div>`).join('')
    : `<div class="empty-state compact">${ART.sites}<div><b>No sites yet</b><p>When you click Fill this form on a site, it appears here.</p></div></div>`;
}
$('#sites').addEventListener('click', async (e) => {
  const o = e.target.closest('[data-origin]')?.dataset.origin;
  if (!o) return;
  await chrome.permissions.remove({ origins: [o] });
  toast('Site access removed');
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
  toast('All Form Filler data has been deleted.');
  boot();
};

// ---------------- first-run onboarding ----------------
async function onboarding() {
  const ob = $('#onboard');
  $('#top').classList.add('hidden');
  ob.classList.remove('hidden');
  const STEPS = ['Create PIN', 'Your details', 'Try it'];
  const shell = (n, body, wide = false) => {
    ob.innerHTML = `<div class="ob-brand">
        <span class="wordmark"><img src="../icons/icon128.png" width="44" height="44" alt=""><span class="name">Form <span>Filler</span></span></span>
        <div class="ob-steps"><div class="dots" role="progressbar" aria-label="Setup progress" aria-valuemin="1" aria-valuemax="3" aria-valuenow="${n}">
          ${STEPS.map((_, i) => `<span class="${i + 1 === n ? 'on' : i + 1 < n ? 'done' : ''}"></span>`).join('')}</div>
          <span class="lbl">Step ${n} of 3 · <b>${STEPS[n - 1]}</b></span></div></div>
      <div class="card ob-card fade-in${wide ? ' wide' : ''}">${body}</div>`;
  };

  // 1. Create PIN
  shell(1, '<div id="ob-slot"></div>');
  await showLock($('#ob-slot'), { bare: true });

  // 2. Basic details
  vault = await loadVault();
  const p = vault.profiles[0];
  const F = [['ob-first', 'personal.firstName', 'First name', 'text'], ['ob-last', 'personal.lastName', 'Last name', 'text'],
    ['ob-father', 'family.fatherName', "Father's name", 'text', 'wide'], ['ob-dob', 'personal.dob', 'Date of birth', 'date'],
    ['ob-mobile', 'contact.mobile', 'Mobile number', 'tel'], ['ob-email', 'contact.email', 'Email', 'email', 'wide']];
  shell(2, `<h2>Add your basic details</h2>
    <p>Start with the essentials. Addresses, education, category and more can be added later in My Profile.</p>
    <form id="ob-form" class="ob-form" autocomplete="off">
      ${F.map(([id, , l, t, w]) => `<label class="${w || ''}"><span>${l}</span><input id="${id}" type="${t}" autocomplete="off"></label>`).join('')}
    </form>
    <div class="ob-actions"><button class="ghost" id="ob-demo">Use demo data</button><button class="ghost" id="ob-skip2">Skip for now</button>
      <button class="primary" id="ob-next2">Continue${icon('arrowRight', 16)}</button></div>
    <div class="ob-foot">${icon('lock', 13)} Saved encrypted on this computer. Never sent anywhere.</div>`, true);
  $('#ob-first').focus();
  await new Promise((done) => {
    $('#ob-form').onsubmit = (e) => { e.preventDefault(); $('#ob-next2').click(); };
    $('#ob-next2').onclick = async () => {
      for (const [id, key] of F) { const v = $('#' + id).value.trim(); if (v) setPath(p, key, v); }
      if (await persist()) done();
    };
    $('#ob-skip2').onclick = () => done();
    $('#ob-demo').onclick = async () => {
      const d = demoProfile();
      vault.profiles = [d];
      if (await persist()) { toast('Demo profile added (fake data)'); done(); }
    };
  });

  // 3. Try it
  shell(3, `<div class="ob-done">${CHECK_ANIM()}<div><h2>You're all set</h2><p class="muted" style="margin:0">Here's how to fill your first form.</p></div></div>
    <ol class="ob-try">
      <li><span class="n">${icon('puzzle', 18)}</span><div><b>Pin Form Filler to your toolbar</b>
        <span class="help">Click the puzzle-piece icon next to the address bar, then the pin next to Form Filler.</span></div></li>
      <li><span class="n">${icon('globe', 18)}</span><div><b>Open an application form</b>
        <span class="help">Any job, exam or admission form on the web.</span></div></li>
      <li><span class="n">${icon('sparkle', 18)}</span><div><b>Click Fill this form</b>
        <span class="help">Form Filler fills what it can and lists anything left for you. It never submits a form.</span></div></li>
    </ol>
    <div class="ob-actions"><a class="btn ghost" href="../pdf/pdf.html">${icon('pdf', 16)}Fill a PDF instead</a>
      <button class="primary" id="ob-finish">Go to My Profile${icon('arrowRight', 16)}</button></div>`, true);
  $('#ob-finish').focus();
  await new Promise((done) => { $('#ob-finish').onclick = done; });
  ob.classList.add('hidden');
  ob.innerHTML = '';
  $('#top').classList.remove('hidden');
  location.hash = 'profiles';
}

if (!(await isSetUp())) selectTab('profiles');
boot();
