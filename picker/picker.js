// Runs inside an extension iframe on the web page. The page cannot read this frame (different origin).
import { loadVault } from '../lib/vault.js';
import { showLock, onLocked } from '../lib/lockui.js';
import { formatSize, fileExt } from '../lib/docs.js';
import { toB64, fromB64 } from '../lib/crypto.js';
import { openImageEditor } from '../lib/imgedit.js';
import { extractUploadRules } from '../lib/ai.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const params = new URLSearchParams(location.search);
const token = params.get('token');
const accept = params.get('accept') || '';
let req = {};
try { req = JSON.parse(params.get('req') || '{}'); } catch { /* ignore */ }

let vault = null;
const urls = [];

$('#close').onclick = () => chrome.runtime.sendMessage({ type: 'ff-close', token });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('#close').click(); });
onLocked(() => boot());

async function docBlob(meta) {
  const r = await chrome.runtime.sendMessage({ type: 'ff-doc-get', id: meta.id });
  if (!r?.ok) throw new Error(r?.error || 'Could not read document');
  return new Blob([fromB64(r.b64)], { type: meta.type });
}

function accepts(meta) {
  if (!accept.trim()) return true;
  return accept.split(',').map((a) => a.trim().toLowerCase()).filter(Boolean).some((a) => {
    if (a.startsWith('.')) return meta.name.toLowerCase().endsWith(a) || (a === '.jpg' && meta.type === 'image/jpeg') || (a === '.jpeg' && meta.type === 'image/jpeg');
    if (a.endsWith('/*')) return meta.type.startsWith(a.slice(0, -1));
    return meta.type === a;
  });
}

function reqText() {
  const bits = [];
  if (req.minKB || req.maxKB) bits.push(`size ${req.minKB ? req.minKB + '–' : 'up to '}${req.maxKB ? req.maxKB + ' KB' : ''}`);
  if (req.width || req.height) bits.push(`${req.width || '?'}×${req.height || '?'} px${req.fromCm ? ' (from cm)' : ''}`);
  if (req.minWidth || req.maxWidth) bits.push(`${req.minWidth}–${req.maxWidth} × ${req.minHeight}–${req.maxHeight} px`);
  if (accept) bits.push(`types: ${accept}`);
  return bits.length ? `Form asks for: <b>${esc(bits.join(' · '))}</b> <span class="muted">(read from the page text; please verify)</span>` : '';
}

function problems(d) {
  const p = [];
  const kb = d.size / 1024;
  if (req.maxKB && kb > req.maxKB) p.push(`larger than ${req.maxKB} KB`);
  if (req.minKB && kb < req.minKB) p.push(`smaller than ${req.minKB} KB`);
  if (d.width && req.width && req.height && !req.fromCm && (d.width !== req.width || d.height !== req.height)) p.push(`not ${req.width}×${req.height}px`);
  if (d.width && req.minWidth && (d.width < req.minWidth || d.width > req.maxWidth || d.height < req.minHeight || d.height > req.maxHeight)) p.push('outside the allowed pixel range');
  if (!accepts(d)) p.push('file type not accepted');
  return p;
}

async function boot() {
  $('#main').classList.add('hidden');
  await showLock($('#lock'), { compact: true });
  try { vault = await loadVault(); } catch { return boot(); }
  $('#main').classList.remove('hidden');
  $('#field').textContent = params.get('label') ? `Upload field: ${params.get('label')}` : '';
  $('#req').innerHTML = reqText();
  renderList();
}

$('#search').oninput = () => renderList();

async function renderList() {
  while (urls.length) URL.revokeObjectURL(urls.pop());
  const q = $('#search').value.trim().toLowerCase();
  const docs = vault.docs
    .filter((d) => !q || d.name.toLowerCase().includes(q) || d.tags.some((t) => t.includes(q)))
    .sort((a, b) => accepts(b) - accepts(a));
  if (!vault.docs.length) {
    $('#list').innerHTML = '<p class="muted">Your locker is empty. Add documents under Form Filler → Document Locker.</p>';
    return;
  }
  $('#list').innerHTML = docs.map((d) => {
    const p = problems(d);
    const isImg = /^image\//.test(d.type);
    return `<div class="item ${accepts(d) ? '' : 'dim'}" data-id="${d.id}">
      <div class="th">${isImg ? '<img alt="">' : esc(fileExt(d))}</div>
      <div>
        <b>${esc(d.name)}</b>
        <div class="small muted">${formatSize(d.size)}${d.width ? ` · ${d.width}×${d.height} px` : ''}</div>
        <div>${d.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>
        ${p.length ? `<div class="small warn">⚠ ${esc(p.join(', '))}</div>` : ''}
      </div>
      <div class="row" style="flex-direction:column;align-items:stretch">
        <button class="primary" data-act="attach">Attach</button>
        ${isImg ? '<button data-act="resize">Crop &amp; resize…</button>' : ''}
      </div>
    </div>`;
  }).join('');
  for (const d of docs) {
    if (!/^image\//.test(d.type)) continue;
    const url = URL.createObjectURL(await docBlob(d));
    urls.push(url);
    const img = document.querySelector(`.item[data-id="${d.id}"] img`);
    if (img) img.src = url;
  }
}

$('#list').addEventListener('click', async (e) => {
  const act = e.target.dataset.act;
  const item = e.target.closest('.item');
  if (!act || !item) return;
  const d = vault.docs.find((x) => x.id === item.dataset.id);
  if (act === 'attach') {
    const p = problems(d);
    if (p.length && !confirm(`This file may not meet the form's requirements (${p.join(', ')}). Attach anyway?`)) return;
    await deliver(await docBlob(d), d.name);
  } else if (act === 'resize') {
    editImage(await docBlob(d), d.name, d.tags);
  }
});

// Prepare a new photo/signature straight from this computer (saved to the locker only if you tick the box).
$('#from-file').onchange = async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (f) editImage(f, f.name, []);
};

async function deliver(blob, name) {
  const msg = $('#msg');
  msg.className = 'small muted';
  msg.textContent = 'Attaching…';
  const b64 = toB64(new Uint8Array(await blob.arrayBuffer()));
  const r = await chrome.runtime.sendMessage({ type: 'ff-deliver', token, name, mime: blob.type, b64 });
  if (!r?.ok) {
    msg.className = 'small err';
    msg.textContent = 'Could not attach: ' + (r?.error || 'unknown error');
  }
}

async function editImage(blob, name, tags) {
  const box = $('#resize');
  $('#browse').classList.add('hidden');
  box.classList.remove('hidden');
  const back = () => { box.classList.add('hidden'); box.innerHTML = ''; $('#browse').classList.remove('hidden'); };
  const ai = vault.settings.apiKey ? {
    // Text snippets come from the content script on the page (filtered and redacted there).
    preview: async () => {
      const r = await chrome.runtime.sendMessage({ type: 'ff-rule-text', token });
      if (!r?.ok) throw new Error(r?.error || 'Could not read the page text.');
      return r;
    },
    run: (prev) => extractUploadRules(vault.settings.apiKey, vault.settings.model, prev)
  } : null;
  try {
    await openImageEditor(box, {
      blob, name, rule: req, kind: req.kind, ai,
      primaryLabel: 'Attach to the form', allowSaveCopy: true,
      onCancel: back,
      onDone: async (out, info, { saveCopy }) => {
        if (saveCopy) {
          const b64 = toB64(new Uint8Array(await out.arrayBuffer()));
          const r = await chrome.runtime.sendMessage({ type: 'ff-doc-add', name: info.name, tags: [...new Set([...tags, info.kind, 'resized'])], mime: out.type, b64 });
          if (r?.ok) vault = await loadVault();
        }
        await deliver(out, info.name);
      }
    });
  } catch (err) {
    back();
    $('#msg').className = 'small err';
    $('#msg').textContent = 'Could not open this image: ' + err.message;
  }
}

boot();
