// Runs inside an extension iframe on the web page. The page cannot read this frame (different origin).
import { loadVault } from '../lib/vault.js';
import { showLock, onLocked } from '../lib/lockui.js';
import { formatSize, fileExt, resizeImage } from '../lib/docs.js';
import { toB64, fromB64 } from '../lib/crypto.js';

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
  if (req.width || req.height) bits.push(`${req.width || '?'}×${req.height || '?'} px`);
  if (accept) bits.push(`types: ${accept}`);
  return bits.length ? `Form asks for: <b>${esc(bits.join(' · '))}</b> <span class="muted">(read from the page text; please verify)</span>` : '';
}

function problems(d) {
  const p = [];
  const kb = d.size / 1024;
  if (req.maxKB && kb > req.maxKB) p.push(`larger than ${req.maxKB} KB`);
  if (req.minKB && kb < req.minKB) p.push(`smaller than ${req.minKB} KB`);
  if (d.width && req.width && req.height && (d.width !== req.width || d.height !== req.height)) p.push(`not ${req.width}×${req.height}px`);
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
        ${isImg ? '<button data-act="resize">Resize…</button>' : ''}
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
    showResize(d);
  }
});

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

function showResize(d) {
  const box = $('#resize');
  box.classList.remove('hidden');
  box.innerHTML = `
    <h3>Resize "${esc(d.name)}"</h3>
    <p class="small muted">Currently ${formatSize(d.size)} · ${d.width}×${d.height} px. Output is JPEG. Leave width/height empty to keep the shape and only compress.</p>
    <div class="grid">
      <label><span>Width (px)</span><input type="number" id="rw" min="16" value="${req.width || ''}"></label>
      <label><span>Height (px)</span><input type="number" id="rh" min="16" value="${req.height || ''}"></label>
      <label><span>Min KB</span><input type="number" id="rmin" min="0" value="${req.minKB || ''}"></label>
      <label><span>Max KB</span><input type="number" id="rmax" min="1" value="${req.maxKB || ''}"></label>
      <label><span>Fit</span><select id="rfit"><option value="cover">Crop to fill</option><option value="contain">Fit (white borders)</option><option value="stretch">Stretch</option></select></label>
    </div>
    <div class="row" style="margin-top:10px"><button id="rgo" class="primary">Preview</button><span id="rinfo" class="small"></span></div>
    <img id="preview" class="hidden" alt="Resized preview">
    <div class="row hidden" id="rdone" style="margin-top:8px">
      <button class="primary" id="rattach">Attach resized</button>
      <label class="row small"><input type="checkbox" id="rsave"> Also save this copy to my locker</label>
    </div>`;
  box.scrollIntoView({ behavior: 'smooth' });
  let result = null;
  const num = (id) => Number($(id).value) || undefined;
  $('#rgo').onclick = async () => {
    $('#rinfo').className = 'small muted';
    $('#rinfo').textContent = 'Working…';
    try {
      result = await resizeImage(await docBlob(d), {
        width: num('#rw'), height: num('#rh'), minKB: num('#rmin'), maxKB: num('#rmax'), fit: $('#rfit').value
      });
      const url = URL.createObjectURL(result.blob);
      urls.push(url);
      $('#preview').src = url;
      $('#preview').classList.remove('hidden');
      $('#rdone').classList.remove('hidden');
      const notes = [];
      if (result.overMax) notes.push(`still above ${num('#rmax')} KB; try smaller dimensions`);
      if (result.underMin) notes.push(`below the ${num('#rmin')} KB minimum; the image has too little detail at this size`);
      $('#rinfo').className = notes.length ? 'small warn' : 'small';
      $('#rinfo').textContent = `${formatSize(result.blob.size)} · ${result.width}×${result.height} px${notes.length ? ' · ⚠ ' + notes.join('; ') : ' ✓'}`;
    } catch (e) {
      $('#rinfo').className = 'small err';
      $('#rinfo').textContent = e.message;
    }
  };
  $('#rattach').onclick = async () => {
    if (!result) return;
    const name = d.name.replace(/\.[^.]+$/, '') + `_${result.width}x${result.height}.jpg`;
    if ($('#rsave').checked) {
      const b64 = toB64(new Uint8Array(await result.blob.arrayBuffer()));
      const r = await chrome.runtime.sendMessage({ type: 'ff-doc-add', name, tags: [...d.tags, 'resized'], mime: 'image/jpeg', b64 });
      if (r?.ok) vault = await loadVault();
    }
    await deliver(result.blob, name);
  };
}

boot();
