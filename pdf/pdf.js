// "Fill a PDF": fill real form fields (AcroForm) directly, or find blanks on flat/scanned forms and
// write values onto the page. Values are resolved and written locally; only labels / page images go to AI.
import * as pdfjs from '../vendor/pdfjs/pdf.min.mjs';
import { PDFDocument, StandardFonts, rgb, degrees, drawSvgPath, drawRectangle, pushGraphicsState, popGraphicsState, PDFTextField, PDFCheckBox, PDFRadioGroup, PDFDropdown, PDFOptionList } from '../vendor/pdf-lib/pdf-lib.esm.min.js';
import '../content/fillcore.js';
import { loadVault, lock, isUnlocked } from '../lib/vault.js';
import { showLock, onLocked } from '../lib/lockui.js';
import { keyCatalog, resolveValue, resolveFirst, addressPartsFor } from '../lib/schema.js';
import { mapFieldsWithGemini, detectFlatPage, lastModelUsed } from '../lib/ai.js';
import { addDocument } from '../lib/docs.js';
import { toB64 } from '../lib/crypto.js';
import * as G from '../lib/pdfgeom.js';
import { createTextWriter, graphemes, hasDevanagari, DEVA_FONT_PATH } from '../lib/pdftext.js';

const C = globalThis.FFCore;
pdfjs.GlobalWorkerOptions.workerSrc = '../vendor/pdfjs/pdf.worker.min.mjs';

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const MAX_BYTES = 40 * 1024 * 1024;
const PREVIEW_W = 860;

let vault = null;
let file = null;         // {name, bytes: Uint8Array}
let pdf = null;          // pdf.js document
let pages = [];          // [{num, vp1, el, cssW, cssH}]
let acroCount = 0;
let items = [];          // see newItem()
let selected = null;
let addMode = null;      // 'text' | 'check' | null
let seq = 0;

// Measuring text for previews with the same metrics family as the PDF (Helvetica).
const measureCtx = document.createElement('canvas').getContext('2d');
const measure = (t, size) => { measureCtx.font = `${size}px Helvetica, Arial, 'FF Devanagari', sans-serif`; return measureCtx.measureText(t).width; };
document.fonts.load("12px 'FF Devanagari'", 'क').catch(() => {});

let devaBytes = null;
async function devanagariFont() {
  devaBytes ??= new Uint8Array(await (await fetch(chrome.runtime.getURL(DEVA_FONT_PATH))).arrayBuffer());
  return devaBytes;
}

// ---------------- boot & lock ----------------
onLocked(() => location.reload()); // wipes the PDF and values from memory
$('#lock-now').onclick = () => lock();

async function boot() {
  await showLock($('#lock'));
  vault = await loadVault();
  $('#app').classList.remove('hidden');
  $('#lock-now').classList.remove('hidden');
  const last = (await chrome.storage.local.get('ff_last_profile')).ff_last_profile;
  $('#profile').innerHTML = vault.profiles.map((p) => `<option value="${p.id}">${esc(p.label)}</option>`).join('');
  if (vault.profiles.some((p) => p.id === last)) $('#profile').value = last;
}
const profile = () => vault.profiles.find((p) => p.id === $('#profile').value) || vault.profiles[0];

// Keep the vault unlocked while you are actively working on this page (auto-lock still applies when idle).
let lastPing = 0;
for (const ev of ['pointerdown', 'keydown']) {
  document.addEventListener(ev, () => {
    if (Date.now() - lastPing > 30000) { lastPing = Date.now(); isUnlocked(); }
  }, true);
}

$('#profile').onchange = () => {
  chrome.storage.local.set({ ff_last_profile: $('#profile').value });
  // Re-resolve values for boxes you haven't edited by hand.
  for (const it of items) if (!it.edited) applyValue(it);
  resolveCheckGroups();
  resolveAddressGroups();
  renderAll();
};

// ---------------- open PDF ----------------
$('#file').onchange = async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  if (f.size > MAX_BYTES) return info(`That PDF is larger than ${MAX_BYTES / 1048576} MB.`, 'err');
  try {
    await openPdf(f.name, new Uint8Array(await f.arrayBuffer()));
  } catch (err) {
    info(err.message, 'err');
  }
};

function info(text, cls = 'muted') { $('#file-info').className = 'small ' + cls; $('#file-info').textContent = text; }

async function openPdf(name, bytes) {
  items = []; selected = null; pages = []; acroCount = 0;
  ['#step-edit', '#step-save'].forEach((s) => $(s).classList.add('hidden'));
  info('Opening…');
  let lib;
  try {
    lib = await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (err) {
    if (/encrypt/i.test(err.message)) throw new Error('This PDF is password-protected or encrypted, so it cannot be changed. Remove the protection first.');
    throw new Error('Could not read this PDF: ' + err.message);
  }
  acroCount = lib.getForm().getFields().filter((fl) => !/Button|Signature/.test(fl.constructor.name)).length;
  pdf = await pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false, enableXfa: false }).promise;
  file = { name, bytes };
  info(`${name} · ${pdf.numPages} page(s) · ${(bytes.length / 1024).toFixed(0)} KB`, '');
  await renderPages();
  $('#step-detect').classList.remove('hidden');
  const hasKey = !!vault.settings.apiKey;
  if (acroCount) {
    $('#detect-acro').classList.remove('hidden');
    $('#detect-flat').classList.add('hidden');
    $('#acro-count').textContent = acroCount;
    $('#acro-ai-note').textContent = hasKey
      ? 'Field names and nearby labels (text only, no images, no values) go to Gemini for matching.'
      : 'No Gemini key: using offline keyword matching. Nothing is sent.';
    $('#flatten-row').classList.remove('hidden');
  } else {
    $('#detect-acro').classList.add('hidden');
    $('#detect-flat').classList.remove('hidden');
    $('#page-count').textContent = pdf.numPages;
    $('#ai-block').classList.toggle('hidden', !hasKey);
    $('#no-key').classList.toggle('hidden', hasKey);
    $('#no-key').textContent = hasKey ? '' : 'Add a Gemini API key in Settings to detect blanks on scanned forms. Without one, use offline detection (for digital PDFs) or add boxes yourself.';
    $('#flatten-row').classList.add('hidden');
  }
  $('#step-edit').classList.remove('hidden');
  $('#step-save').classList.remove('hidden');
  renderAll();
}

async function renderPages() {
  const host = $('#pages');
  host.innerHTML = '';
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    const vp1 = page.getViewport({ scale: 1 });
    const scale = PREVIEW_W / vp1.width;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const vp = page.getViewport({ scale: scale * dpr });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(vp.width);
    canvas.height = Math.round(vp.height);
    // intent 'print' renders in one pass instead of waiting for animation frames, so it also
    // completes if this tab is in the background.
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp, intent: 'print' }).promise;
    const el = document.createElement('div');
    el.className = 'page';
    el.dataset.page = n;
    const cssW = PREVIEW_W, cssH = (vp1.height / vp1.width) * PREVIEW_W;
    el.style.width = cssW + 'px';
    el.style.height = cssH + 'px';
    el.innerHTML = `<span class="pno">Page ${n}</span>`;
    el.appendChild(canvas);
    host.appendChild(el);
    pages.push({ num: n, vp1, el, cssW, cssH, pdfPage: page });
    el.addEventListener('pointerdown', (e) => onPagePointer(e, n));
  }
}

async function pageImage(n, maxW = 1600) {
  const p = pages[n - 1];
  const scale = Math.min(maxW / p.vp1.width, 3);
  const vp = p.pdfPage.getViewport({ scale });
  const c = new OffscreenCanvas(Math.round(vp.width), Math.round(vp.height));
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  await p.pdfPage.render({ canvasContext: ctx, viewport: vp, intent: 'print', annotationMode: pdfjs.AnnotationMode.DISABLE }).promise;
  const blob = await c.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
  return toB64(new Uint8Array(await blob.arrayBuffer()));
}

// ---------------- items ----------------
function newItem(o) {
  return {
    id: 'i' + ++seq, page: 1, box: { x: 0.1, y: 0.1, w: 0.25, h: 0.022 }, kind: 'text', text: '', checked: false,
    label: '', key: null, sure: false, edited: false, cells: 0, upper: false, fontSize: null, dateFormat: null,
    option: null, group: null, acro: null, options: null, ...o
  };
}

/** Candidate profile keys for a label, best first: custom field, precise label rule, AI's key, keyword guess. */
function candidateKeys(label, aiKey) {
  return [...new Set([customKeyFor(label), C.labelKey(label), aiKey, C.heuristicKey({ label })].filter(Boolean))];
}

const isAddressKey = (k) => /^(permanentAddress|currentAddress)\.full$/.test(k || '');

function applyValue(it) {
  if (it.kind !== 'text') return;
  if (it.addrGroup) return; // filled by resolveAddressGroups()
  const keys = it.keys?.length ? it.keys : [it.key];
  const hit = resolveFirst(profile(), keys);
  if (hit) it.key = hit.key;
  const val = hit;
  if (it.options) { // AcroForm dropdown
    const m = val ? C.matchOption(it.options.map((t) => ({ text: t, value: t })), val.value, val.kind) : { index: -1 };
    it.text = m.index >= 0 ? it.options[m.index] : '';
    it.sure = m.index >= 0 && m.score >= 0.8 && it.conf !== 'low';
    return;
  }
  it.text = G.textForItem(val, it, C);
  if (it.acro?.maxLen && it.text.length > it.acro.maxLen) { it.text = it.text.slice(0, it.acro.maxLen); it.conf = 'low'; }
  // a precise label match ("Full Name", "Father's Name") counts as sure even if the AI was unsure
  it.sure = !!it.text && (it.conf !== 'low' || (!!hit && hit.key === C.labelKey(it.label)));
}

/**
 * Address boxes: an address label's box plus the continuation lines right below it form a group.
 * The address is built from its parts and spread over the group's lines (or wrapped in one tall box).
 */
function groupAddresses() {
  const sorted = items.filter((i) => i.kind === 'text' && !i.acro && !(i.cells > 1))
    .sort((a, b) => a.page - b.page || a.box.y - b.box.y || a.box.x - b.box.x);
  let gid = 0, cur = null;
  for (const it of sorted) {
    if (it.edited && !it.addrGroup) { cur = null; continue; }
    const k = it.keys?.find(isAddressKey) || (isAddressKey(it.key) ? it.key : null);
    const prev = cur?.last;
    const below = prev && it.page === prev.page && it.box.y > prev.box.y + prev.box.h * 0.5 &&
      it.box.y < prev.box.y + prev.box.h * 3.5 && it.box.x < prev.box.x + prev.box.w && it.box.x + it.box.w > prev.box.x;
    const continuation = below && (k === cur.key || (!k && (!it.label || /contd|continued|line ?\d|^\W*$/i.test(it.label) || C.norm(it.label) === C.norm(prev.label))));
    if (continuation) {
      it.addrGroup = cur.id; it.key = cur.key; it.keys = [cur.key];
      cur.last = it;
    } else if (k) {
      cur = { id: 'a' + ++gid, key: k, last: it };
      it.addrGroup = cur.id; it.key = k;
    } else {
      cur = null;
      it.addrGroup = null;
    }
  }
}

function resolveAddressGroups() {
  const groups = new Map();
  for (const it of items) if (it.addrGroup) {
    if (!groups.has(it.addrGroup)) groups.set(it.addrGroup, []);
    groups.get(it.addrGroup).push(it);
  }
  for (const group of groups.values()) {
    if (group.some((i) => i.edited)) continue; // you changed it by hand: keep your version
    group.sort((a, b) => a.box.y - b.box.y);
    const vp = pages[group[0].page - 1].vp1;
    let parts = addressPartsFor(profile(), group[0].key.split('.')[0]);
    if (group.some((i) => i.upper)) parts = parts.map((x) => x.toUpperCase());
    for (const it of group) { it.text = ''; it.sure = false; it.fontSize = null; it.spare = false; }
    if (!parts.length) continue;
    const widths = group.map((i) => i.box.w * vp.width - 3);
    const size = G.autoFontSize(group[0].box.h * vp.height);
    if (group.length === 1) {
      const it = group[0];
      const cap = G.lineCapacity(it.box.h * vp.height, size);
      const r = G.distributeParts(parts, Array(cap).fill(widths[0]), size, measure);
      it.text = r.lines.join('\n');
      it.fontSize = r.size;
      it.sure = !r.overflow;
      continue;
    }
    const r = G.distributeParts(parts, widths, size, measure);
    r.lines.forEach((line, k) => { group[k].text = line; });
    for (const it of group) { it.fontSize = r.size; it.sure = !r.overflow; it.spare = !it.text; } // unused extra lines
  }
}

/** For checkbox groups (same group id), tick the option matching your profile value. */
function resolveCheckGroups() {
  const groups = new Map();
  for (const it of items) if (it.kind === 'check' && it.group && !it.edited) {
    if (!groups.has(it.group)) groups.set(it.group, []);
    groups.get(it.group).push(it);
  }
  for (const group of groups.values()) {
    const key = group[0].key;
    const val = key ? resolveValue(profile(), key) : null;
    const { tick, sure } = G.chooseOption(group, val, C);
    for (const it of group) {
      it.checked = it === tick;
      it.sure = !!tick && sure && it.conf !== 'low';
    }
  }
}

function customKeyFor(label) {
  const n = C.norm(label);
  if (!n) return null;
  const i = (profile().custom || []).findIndex((c) => { const cn = C.norm(c.label); return cn && (cn === n || (cn.length > 3 && n.includes(cn))); });
  return i >= 0 ? `custom.${i}` : null;
}

// ---------------- AcroForm path ----------------
$('#run-acro').onclick = () => runStep(fillAcro);

async function fillAcro() {
  const lib = await PDFDocument.load(file.bytes, { updateMetadata: false });
  const libFields = new Map(lib.getForm().getFields().map((f) => [f.getName(), f]));
  const widgets = [];
  for (const p of pages) {
    const annots = await p.pdfPage.getAnnotations({ intent: 'display' });
    const text = await textItems(p);
    for (const a of annots) {
      if (a.subtype !== 'Widget' || !a.fieldName || !libFields.has(a.fieldName)) continue;
      const box = G.fromViewportRect(p.vp1.convertToViewportRectangle(a.rect), p.vp1.width, p.vp1.height);
      widgets.push({ a, page: p.num, box, near: nearbyLabel(text, box), optionNear: rightLabel(text, box) });
    }
  }
  // One description per field (radio widgets share a field).
  const fields = [];
  const byName = new Map();
  for (const w of widgets) {
    const lf = libFields.get(w.a.fieldName);
    if (!byName.has(w.a.fieldName)) {
      const pretty = C.humanize(w.a.fieldName.replace(/\[\d+\]/g, '').split('.').pop());
      const d = {
        name: w.a.fieldName, label: w.a.alternativeText || w.near || pretty, section: '', placeholder: '',
        tag: lf instanceof PDFDropdown || lf instanceof PDFOptionList ? 'select' : 'input',
        type: lf instanceof PDFCheckBox ? 'checkbox' : lf instanceof PDFRadioGroup ? 'radio' : 'text',
        lf, widgets: []
      };
      if (d.label !== pretty && !C.norm(d.label).includes(C.norm(pretty))) d.name = pretty;
      if (lf instanceof PDFDropdown || lf instanceof PDFOptionList) d.options = lf.getOptions().map((t) => ({ text: t, value: t }));
      if (lf instanceof PDFRadioGroup) { d.options = []; d.libOptions = lf.getOptions(); }
      byName.set(w.a.fieldName, d);
      fields.push(d);
    }
    const d = byName.get(w.a.fieldName);
    d.widgets.push(w);
    if (d.type === 'radio') {
      // pdf-lib's option names are what select() accepts; fall back to the export value.
      const j = d.widgets.length - 1;
      const libOpt = d.libOptions?.length === undefined ? undefined : d.libOptions[j];
      const value = libOpt ?? w.a.buttonValue;
      d.options.push({ text: optionText(w, libOpt), value });
    }
  }
  const usable = fields.filter((d) => !(d.sensitive = C.isSensitive(d)));
  const skipped = fields.length - usable.length;

  const mapping = await mapFields(usable);
  items = [];
  usable.forEach((d, i) => {
    const m = mapping.get(i);
    const keys = candidateKeys(d.label, m?.key);
    const key = keys[0] || null;
    const conf = m?.confidence || 'low';
    const acroBase = { name: d.widgets[0].a.fieldName, type: d.type };
    if (d.type === 'radio') {
      d.widgets.forEach((w, j) => items.push(newItem({
        page: w.page, box: w.box, kind: 'check', label: d.label, option: d.options[j].text, key, conf, group: 'g:' + d.widgets[0].a.fieldName,
        acro: { ...acroBase, option: d.options[j].value }
      })));
    } else if (d.type === 'checkbox') {
      const w = d.widgets[0];
      items.push(newItem({ page: w.page, box: w.box, kind: 'check', label: d.label, option: d.label, key, conf, group: 'g:' + acroBase.name, acro: acroBase }));
    } else {
      const w = d.widgets[0];
      const maxLen = d.lf instanceof PDFTextField ? d.lf.getMaxLength() : undefined;
      const it = newItem({
        page: w.page, box: w.box, kind: 'text', label: d.label, key, keys, conf, dateFormat: m?.dateFormat || null,
        options: d.options ? d.options.map((o) => o.text) : null, acro: { ...acroBase, maxLen }
      });
      applyValue(it);
      items.push(it);
    }
  });
  resolveCheckGroups();
  renderAll();
  return `Matched ${items.filter((i) => i.sure).length} of ${usable.length} fields${skipped ? ` · 🛡️ ${skipped} sensitive field(s) skipped` : ''}.`;
}

function optionText(w, libOpt) {
  for (const v of [libOpt, w.a.buttonValue].map((x) => String(x ?? ''))) {
    if (v && !/^\d+$/.test(v) && v.length > 1 && !/^(on|yes|off)$/i.test(v)) return v;
  }
  return w.optionNear || w.near || String(w.a.buttonValue ?? '');
}

async function mapFields(descs) {
  const { apiKey, model } = vault.settings;
  if (apiKey) {
    try {
      return await mapFieldsWithGemini(apiKey, model, descs, keyCatalog(profile()));
    } catch (err) {
      aiWarning = `AI matching failed (${err.message}), so offline matching was used.`;
    }
  }
  const m = new Map();
  descs.forEach((d, i) => {
    const key = C.heuristicKey(d);
    if (key) m.set(i, { key, confidence: 'high', dateFormat: null });
  });
  return m;
}

/** Text items on a page, as normalised boxes. */
async function textItems(p) {
  const tc = await p.pdfPage.getTextContent();
  const out = [];
  for (const t of tc.items) {
    if (!t.str || !t.str.trim()) continue;
    const tx = pdfjs.Util.transform(p.vp1.transform, t.transform);
    const h = Math.hypot(tx[2], tx[3]) || 10;
    out.push({ text: t.str, x: tx[4] / p.vp1.width, y: (tx[5] - h) / p.vp1.height, w: t.width / p.vp1.width, h: (h * 1.15) / p.vp1.height });
  }
  return out;
}

/** Text printed just to the right of a tick box / radio button (its option name). */
function rightLabel(text, box) {
  const cy = box.y + box.h / 2;
  const r = text.filter((t) => Math.abs(t.y + t.h / 2 - cy) < Math.max(box.h, t.h) * 0.8 && t.x >= box.x + box.w - 0.005 && t.x - (box.x + box.w) < 0.06)
    .sort((a, b) => a.x - b.x)[0];
  return r ? r.text.trim().slice(0, 80) : '';
}

function nearbyLabel(text, box) {
  const cy = box.y + box.h / 2;
  const left = text.filter((t) => Math.abs(t.y + t.h / 2 - cy) < Math.max(box.h, t.h) * 0.8 && t.x + t.w <= box.x + 0.01 && box.x - (t.x + t.w) < 0.45)
    .sort((a, b) => b.x - a.x);
  if (left.length) {
    // join words of the same line that sit directly left of the field
    const line = left.filter((t) => t.x >= left[left.length - 1].x).sort((a, b) => a.x - b.x);
    return line.map((t) => t.text).join(' ').replace(/\s+/g, ' ').trim().slice(0, 120);
  }
  const right = text.filter((t) => Math.abs(t.y + t.h / 2 - cy) < Math.max(box.h, t.h) * 0.8 && t.x >= box.x + box.w - 0.005 && t.x - (box.x + box.w) < 0.06)
    .sort((a, b) => a.x - b.x)[0];
  if (right) return right.text.trim().slice(0, 120);
  const above = text.filter((t) => t.y + t.h <= box.y + 0.005 && box.y - (t.y + t.h) < 0.03 && t.x < box.x + box.w && t.x + t.w > box.x)
    .sort((a, b) => b.y - a.y)[0];
  return above ? above.text.trim().slice(0, 120) : '';
}

// ---------------- flat path: AI ----------------
$('#ai-consent').onchange = (e) => { $('#run-ai').disabled = !e.target.checked; };
$('#run-ai').onclick = () => runStep(detectWithAI);

async function detectWithAI() {
  const { apiKey, model } = vault.settings;
  if (!apiKey) throw new Error('Add a Gemini API key in Settings first.');
  const catalog = keyCatalog(profile());
  items = items.filter((i) => i.edited); // keep boxes you placed by hand
  let skipped = 0;
  for (const p of pages) {
    progress(`Reading page ${p.num} of ${pages.length} with AI…`);
    const raw = await detectFlatPage(apiKey, model, await pageImage(p.num), 'image/jpeg', catalog);
    for (const r of raw) {
      if (r.kind === 'skip') continue;
      if (C.isSensitive({ label: r.label })) { skipped++; continue; }
      const box = G.fromBox2d(r.box_2d);
      if (!box) continue;
      const keys = r.kind === 'checkbox'
        ? [...new Set([r.key, C.labelKey(r.label), C.heuristicKey({ label: r.label })].filter(Boolean))]
        : candidateKeys(r.label, r.key);
      const key = keys[0] || null;
      const base = { page: p.num, box, label: r.label, key, keys, conf: r.confidence, dateFormat: r.dateFormat || null };
      if (r.kind === 'checkbox') {
        items.push(newItem({ ...base, kind: 'check', option: r.option || r.label, group: `p${p.num}:${key || r.label}` }));
      } else {
        const it = newItem({ ...base, kind: 'text', cells: r.cells > 1 ? r.cells : 0, upper: !!r.uppercase || r.cells > 1 });
        applyValue(it);
        items.push(it);
      }
    }
  }
  resolveCheckGroups();
  groupAddresses();
  resolveAddressGroups();
  renderAll();
  return summary(skipped);
}

// ---------------- flat path: offline (text layer) ----------------
$('#run-offline').onclick = () => runStep(detectOffline);

async function detectOffline() {
  items = items.filter((i) => i.edited);
  let found = 0, skipped = 0;
  for (const p of pages) {
    const text = await textItems(p);
    const rules = await printedRules(p);
    const used = new Set();
    // labels without a colon count when we recognise them ("Full Name", "Date of Birth", "Mobile No.")
    const known = (label) => label.length <= 60 && !!(customKeyFor(label) || C.labelKey(label) || C.heuristicKey({ label }));
    const upper = /capital|block letters/i.test(text.map((t) => t.text).join(' '));
    for (const b of G.blanksFromTextLayer(text, known)) {
      if (C.isSensitive({ label: b.label })) { skipped++; continue; }
      if (/signature|photo|thumb|office use/i.test(b.label)) continue;
      const keys = candidateKeys(b.label, null);
      const key = keys[0] || null;
      // put the value on the printed line next to the label, if there is one
      const rule = ruleForLabel(b.box, rules, used);
      const lines = [];
      if (rule) {
        lines.push(ruleBox(rule, p));
        if (isAddressKey(key)) for (const r of continuationRules(rule, rules, used, text)) lines.push(ruleBox(r, p));
      } else lines.push(isAddressKey(key) ? growAddressBox(b.box, text) : b.box);
      lines.forEach((box, n) => {
        const it = newItem({ page: p.num, box, label: n ? '' : b.label, key, keys: n ? [key] : keys, conf: key ? 'high' : 'low', upper });
        applyValue(it);
        items.push(it);
      });
      found++;
    }
  }
  if (!found) throw new Error('No text labels found. This looks like a scanned form: use AI detection, or add boxes yourself with "+ Text" / "+ Tick".');
  groupAddresses();
  resolveAddressGroups();
  renderAll();
  return summary(skipped) + ' Tick boxes are not detected offline; add them with "+ Tick".';
}

/** Horizontal printed lines on a page, as normalised {x0, x1, y} (y = the line itself). */
async function printedRules(p) {
  const ol = await p.pdfPage.getOperatorList({ intent: 'print' });
  return G.horizontalRules(ol.fnArray, ol.argsArray, pdfjs.OPS).map((r) => {
    const [ax, ay] = p.vp1.convertToViewportPoint(r.x0, r.y);
    const [bx] = p.vp1.convertToViewportPoint(r.x1, r.y);
    return { x0: Math.min(ax, bx) / p.vp1.width, x1: Math.max(ax, bx) / p.vp1.width, y: ay / p.vp1.height };
  });
}

/** The printed line a label points at: on the label's text line, starting after the label. */
function ruleForLabel(box, rules, used) {
  const labelEnd = box.x - 0.012;
  const cands = rules.filter((r) => !used.has(r) && r.x1 > labelEnd + 0.04 && r.x0 >= labelEnd - 0.01 &&
    r.y >= box.y + box.h * 0.35 && r.y <= box.y + box.h * 1.6);
  const r = cands.sort((a, b) => a.x0 - b.x0)[0];
  if (r) used.add(r);
  return r || null;
}

/** Further printed lines directly under an address line (same column), until printed text appears. */
function continuationRules(first, rules, used, text) {
  const out = [];
  let prev = first;
  for (;;) {
    const next = rules.filter((r) => !used.has(r) && r.y > prev.y + 0.008 && r.y < prev.y + 0.06 &&
      Math.abs(r.x0 - first.x0) < 0.03 && Math.abs(r.x1 - first.x1) < 0.05).sort((a, b) => a.y - b.y)[0];
    if (!next) break;
    // stop at the next labelled row (text printed on that line)
    if (text.some((t) => t.y + t.h > prev.y + 0.004 && t.y + t.h * 0.5 < next.y && t.x + t.w < first.x0)) break;
    used.add(next); out.push(next); prev = next;
    if (out.length >= 3) break;
  }
  return out;
}

/** Writing area above a printed line. */
function ruleBox(r, p) {
  const h = Math.max(14, 0.018 * p.vp1.height) / p.vp1.height;
  return { x: r.x0, y: r.y - h, w: r.x1 - r.x0, h };
}

/** Offline: an address usually gets several lines; extend its box down to just above the next printed text. */
function growAddressBox(box, text) {
  const below = text.filter((t) => t.y > box.y + box.h * 0.6).sort((a, b) => a.y - b.y)[0];
  const limit = below ? below.y - 0.004 - box.y : box.h * 3.2;
  const h = Math.min(limit, box.h * 3.2);
  return h > box.h * 1.6 ? { ...box, h } : box;
}

function summary(skipped) {
  const filled = items.filter((i) => (i.kind === 'text' ? i.text : i.checked) && i.sure).length;
  const review = items.filter((i) => i.kind === 'text' && !i.spare && (!i.text || !i.sure)).length;
  return `${filled} filled · ${review} to check${skipped ? ` · 🛡️ ${skipped} sensitive field(s) skipped` : ''}.`;
}

let aiWarning = null; // shown with the step's result so it isn't overwritten

async function runStep(fn) {
  aiWarning = null;
  const btns = ['#run-acro', '#run-ai', '#run-offline'].map((s) => $(s));
  btns.forEach((b) => (b.dataset.was = b.disabled, b.disabled = true));
  progress('Working…');
  try {
    let text = await fn();
    const m = vault.settings.model;
    if (aiWarning) { progress(`${text} ${aiWarning}`, 'warn'); return; }
    if (vault.settings.apiKey && lastModelUsed && lastModelUsed !== m && fn !== detectOffline) text += ` (${m} was busy, so ${lastModelUsed} answered.)`;
    progress(text, 'ok');
  } catch (err) {
    progress(err.message === 'LOCKED' ? 'Locked. Unlock and try again.' : err.message, 'err');
  } finally {
    btns.forEach((b) => (b.disabled = b.dataset.was === 'true'));
    if ($('#ai-consent')) $('#run-ai').disabled = !$('#ai-consent').checked;
  }
}
function progress(text, cls = 'muted') { const el = $('#progress'); el.className = 'small ' + (cls === 'warn' ? 'notice' : cls); el.textContent = text; }

// ---------------- rendering overlays ----------------
function renderAll() {
  for (const p of pages) p.el.querySelectorAll('.ov').forEach((n) => n.remove());
  for (const it of items) renderItem(it);
  renderList();
  renderEditor();
}

function isGreen(it) {
  return it.kind === 'check' ? it.sure : !!it.text && it.sure;
}

function renderItem(it) {
  const p = pages[it.page - 1];
  if (!p) return;
  let el = p.el.querySelector(`.ov[data-id="${it.id}"]`);
  if (!el) {
    el = document.createElement('div');
    el.dataset.id = it.id;
    p.el.appendChild(el);
    attachDrag(el, it);
  }
  const empty = it.kind === 'text' ? !it.text : false;
  el.className = `ov ${it.kind === 'check' ? 'check' : 'text'} ${it.spare ? 'spare' : isGreen(it) ? '' : 'y'} ${it.acro ? 'acro' : ''} ${selected === it.id ? 'sel' : ''} ${empty && !$('#show-empty').checked ? 'hide' : ''}`;
  Object.assign(el.style, { left: it.box.x * 100 + '%', top: it.box.y * 100 + '%', width: it.box.w * 100 + '%', height: it.box.h * 100 + '%' });
  el.title = `${it.label || 'Text'}${it.key ? ` (${it.key})` : ''}`;
  const k = p.cssW / p.vp1.width; // css px per pt
  const hPt = it.box.h * p.vp1.height;
  if (it.kind === 'check') {
    el.style.fontSize = Math.max(8, hPt * 0.9 * k) + 'px';
    el.innerHTML = `<span class="grip">⠿</span>${it.checked ? '✓' : ''}<span class="rs"></span>`;
    return;
  }
  const size = it.fontSize || G.autoFontSize(hPt, it.cells);
  const fit = it.cells > 1 ? size : G.fitFontSize(it.text, size, it.box.w * p.vp1.width - 3, measure);
  el.style.fontSize = fit * k + 'px';
  if (it.cells > 1) {
    const chars = graphemes(it.text).slice(0, it.cells);
    el.innerHTML = `<span class="grip">⠿</span><div class="cells">${Array.from({ length: it.cells }, (_, i) => `<span>${esc(chars[i] || '')}</span>`).join('')}</div><span class="rs"></span>`;
  } else {
    const multi = it.text.includes('\n');
    el.innerHTML = `<span class="grip">⠿</span>${multi ? '<textarea' : '<input'} spellcheck="false" aria-label="${esc(it.label)}">${multi ? '</textarea>' : ''}<span class="rs"></span>`;
    const inp = el.querySelector('input, textarea');
    if (multi) inp.style.lineHeight = Math.max(fit * 1.25, (hPt / it.text.split('\n').length)) * k + 'px';
    inp.value = it.text;
    inp.oninput = () => { it.text = inp.value; it.edited = true; it.sure = !!it.text; el.classList.toggle('y', !isGreen(it)); renderList(); syncEditorText(it); };
    inp.onfocus = () => select(it.id, false);
  }
}

function attachDrag(el, it) {
  el.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    if (addMode) return;
    const grip = e.target.closest('.grip'), rs = e.target.closest('.rs');
    if (it.kind === 'check' && !grip && !rs) {
      if (it.acro?.type === 'radio' || (it.group && !it.acro)) {
        // ticking one option in a group unticks the others
        const was = it.checked;
        for (const o of items) if (o.group && o.group === it.group) { o.checked = false; o.edited = true; }
        it.checked = !was;
      } else it.checked = !it.checked;
      it.edited = true; it.sure = true;
      for (const o of items) if (o.group && o.group === it.group) renderItem(o);
      select(it.id);
      return;
    }
    select(it.id, !e.target.matches('input'));
    if (it.acro || (!grip && !rs)) return;
    e.preventDefault();
    const p = pages[it.page - 1];
    const start = { x: e.clientX, y: e.clientY, box: { ...it.box } };
    const move = (ev) => {
      const dx = (ev.clientX - start.x) / p.cssW, dy = (ev.clientY - start.y) / p.cssH;
      if (grip) {
        it.box.x = Math.min(1 - it.box.w, Math.max(0, start.box.x + dx));
        it.box.y = Math.min(1 - it.box.h, Math.max(0, start.box.y + dy));
      } else {
        it.box.w = Math.max(0.01, Math.min(1 - it.box.x, start.box.w + dx));
        it.box.h = Math.max(0.008, Math.min(1 - it.box.y, start.box.h + dy));
      }
      it.edited = true;
      renderItem(it);
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
}

function onPagePointer(e, n) {
  if (!addMode) { select(null); return; }
  const p = pages[n - 1];
  const r = p.el.getBoundingClientRect();
  const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
  const it = addMode === 'text'
    ? newItem({ page: n, box: { x, y: y - 0.011, w: 0.25, h: 0.022 }, label: 'Text', edited: true, sure: true })
    : newItem({ page: n, kind: 'check', box: { x: x - 0.009, y: y - 0.0065, w: 0.018, h: 0.013 }, label: 'Tick', checked: true, edited: true, sure: true });
  items.push(it);
  setAddMode(null);
  renderItem(it);
  select(it.id);
  if (it.kind === 'text') setTimeout(() => pages[n - 1].el.querySelector(`.ov[data-id="${it.id}"] input`)?.focus(), 0);
}

function setAddMode(m) {
  addMode = m;
  pages.forEach((p) => p.el.classList.toggle('adding', !!m));
  $('#add-text').classList.toggle('primary', m === 'text');
  $('#add-tick').classList.toggle('primary', m === 'check');
}
$('#add-text').onclick = () => setAddMode(addMode === 'text' ? null : 'text');
$('#add-tick').onclick = () => setAddMode(addMode === 'check' ? null : 'check');
$('#show-empty').onchange = () => renderAll();

function select(id, scroll = false) {
  const prev = selected;
  selected = id;
  for (const p of pages) p.el.querySelectorAll('.ov.sel').forEach((n) => n.classList.remove('sel'));
  if (id) {
    const it = items.find((i) => i.id === id);
    const el = pages[it.page - 1]?.el.querySelector(`.ov[data-id="${id}"]`);
    el?.classList.add('sel');
    if (scroll) el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
  if (prev !== id) { renderList(); renderEditor(); }
}

// ---------------- sidebar ----------------
function renderList() {
  const host = $('#item-list');
  if (!items.length) { host.innerHTML = '<p class="small muted">No boxes yet.</p>'; return; }
  const parts = [];
  for (const p of pages) {
    const list = items.filter((i) => i.page === p.num);
    if (!list.length) continue;
    parts.push(`<div class="pg">Page ${p.num}</div>`);
    for (const it of list) {
      const v = it.kind === 'check' ? (it.checked ? '✓' : '') : it.text;
      parts.push(`<button data-id="${it.id}" class="${selected === it.id ? 'sel' : ''}"><span class="sw ${it.spare ? 's' : isGreen(it) ? 'g' : 'y'}"></span>
        <span>${esc(it.label || 'Text')}${it.option && it.option !== it.label ? ` · ${esc(it.option)}` : ''}</span><span class="v">${esc(v)}</span></button>`);
    }
  }
  host.innerHTML = parts.join('');
}
$('#item-list').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-id]');
  if (b) select(b.dataset.id, true);
});

function keyOptions(current) {
  const cat = keyCatalog(profile());
  return `<option value="">(none: type your own)</option>` + cat.map((c) => `<option value="${c.key}" ${c.key === current ? 'selected' : ''}>${esc(c.desc)}</option>`).join('');
}

function renderEditor() {
  const box = $('#editor');
  const it = items.find((i) => i.id === selected);
  if (!it) { box.classList.add('hidden'); box.innerHTML = ''; return; }
  box.classList.remove('hidden');
  const p = pages[it.page - 1];
  const autoSize = G.autoFontSize(it.box.h * p.vp1.height);
  box.innerHTML = `
    <b>${esc(it.label || 'Text')}${it.option && it.option !== it.label ? ` · ${esc(it.option)}` : ''}</b>
    ${it.kind === 'text' ? `
      <label><span>Fill from profile</span><select id="ed-key">${keyOptions(it.key)}</select></label>
      ${it.options
        ? `<label><span>Value</span><select id="ed-sel"><option value=""></option>${it.options.map((o) => `<option ${o === it.text ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select></label>`
        : `${it.text.includes('\n') || it.addrGroup ? `<label><span>Text</span><textarea id="ed-text" rows="3" spellcheck="false">${esc(it.text)}</textarea></label>` : `<label><span>Text</span><input id="ed-text" value="${esc(it.text)}" spellcheck="false"></label>`}`}
      ${it.acro ? '' : `<div class="grid2">
        <label><span>Font size (pt)</span><input id="ed-size" type="number" min="5" max="36" step="0.5" value="${it.fontSize || autoSize}"></label>
        <label><span>Letter boxes</span><input id="ed-cells" type="number" min="0" max="60" value="${it.cells || 0}"></label>
      </div>
      <label class="row small"><input type="checkbox" id="ed-upper" ${it.upper ? 'checked' : ''}> CAPITAL LETTERS</label>`}`
    : `<label class="row small"><input type="checkbox" id="ed-checked" ${it.checked ? 'checked' : ''}> Ticked</label>`}
    <div class="row">${it.acro ? '' : '<button class="danger" id="ed-del">Delete box</button>'}<button id="ed-done">Done</button></div>`;
  const rerender = () => { renderItem(it); renderList(); };
  $('#ed-key', box)?.addEventListener('change', (e) => {
    it.key = e.target.value || null; it.keys = it.key ? [it.key] : []; it.conf = 'high';
    if (isAddressKey(it.key)) { it.addrGroup = 'm' + it.id; it.edited = false; resolveAddressGroups(); }
    else { it.addrGroup = null; applyValue(it); }
    it.edited = true; it.sure = !!it.text; rerender(); renderEditor();
  });
  $('#ed-text', box)?.addEventListener('input', (e) => { it.text = e.target.value; it.edited = true; it.sure = !!it.text; rerender(); });
  $('#ed-sel', box)?.addEventListener('change', (e) => { it.text = e.target.value; it.edited = true; it.sure = !!it.text; rerender(); });
  $('#ed-size', box)?.addEventListener('input', (e) => { it.fontSize = Number(e.target.value) || null; it.edited = true; rerender(); });
  $('#ed-cells', box)?.addEventListener('input', (e) => { it.cells = Math.max(0, Number(e.target.value) || 0); it.edited = true; rerender(); });
  $('#ed-upper', box)?.addEventListener('change', (e) => { it.upper = e.target.checked; it.text = it.upper ? it.text.toUpperCase() : it.text; it.edited = true; rerender(); renderEditor(); });
  $('#ed-checked', box)?.addEventListener('change', (e) => {
    if (e.target.checked && it.group) for (const o of items) if (o.group === it.group && o !== it) { o.checked = false; renderItem(o); }
    it.checked = e.target.checked; it.edited = true; it.sure = true; rerender();
  });
  $('#ed-del', box)?.addEventListener('click', () => {
    items = items.filter((i) => i !== it);
    pages[it.page - 1].el.querySelector(`.ov[data-id="${it.id}"]`)?.remove();
    select(null);
  });
  $('#ed-done', box).onclick = () => select(null);
}

function syncEditorText(it) {
  if (selected !== it.id) return;
  const inp = $('#ed-text');
  if (inp && inp.value !== it.text) inp.value = it.text;
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { setAddMode(null); select(null); }
});

// ---------------- build the filled PDF (locally) ----------------
async function buildPdf() {
  const doc = await PDFDocument.load(file.bytes, { updateMetadata: false });
  const writer = await createTextWriter(doc, { StandardFonts, rgb, degrees, drawSvgPath, pushGraphicsState, popGraphicsState },
    globalThis.fontkit, await devanagariFont());
  const font = writer.latin;
  const problems = [];
  const canWrite = (t) => writer.canWrite(t);

  // 1) Real form fields
  const acroItems = items.filter((i) => i.acro);
  if (acroItems.length) {
    const form = doc.getForm();
    const done = new Set();
    const hindiFields = [];
    for (const it of acroItems) {
      const name = it.acro.name;
      try {
        const f = form.getField(name);
        if (f instanceof PDFTextField) {
          if (it.text && !canWrite(it.text)) { problems.push(it.label); continue; }
          if (hasDevanagari(it.text)) { hindiFields.push([f, it]); continue; } // after the Latin appearances below
          f.setText(it.text || undefined);
          if (it.text) { // readable 10–12 pt, smaller only if the field is too short
            const r = f.acroField.getWidgets()[0]?.getRectangle();
            if (r) {
              const pref = Math.max(G.MIN_READABLE, Math.min(G.MAX_READABLE, r.height * 0.62));
              const fitted = f.isMultiline() ? pref : G.fitFontSize(it.text, Math.min(pref, r.height * 0.8 + 1), r.width - 4, (t, sz) => writer.widthOf(t, sz), 6);
              f.setFontSize(fitted);
            }
          }
        } else if (f instanceof PDFDropdown || f instanceof PDFOptionList) {
          if (it.text) f.select(it.text); else f.clear();
        } else if (f instanceof PDFCheckBox) {
          it.checked ? f.check() : f.uncheck();
        } else if (f instanceof PDFRadioGroup && !done.has(name)) {
          const on = acroItems.find((o) => o.acro.name === name && o.checked);
          if (on) f.select(on.acro.option); else f.clear();
          done.add(name);
        }
      } catch (err) {
        problems.push(`${it.label} (${err.message})`);
      }
    }
    try { form.updateFieldAppearances(font); } catch { /* keep going; viewers regenerate appearances */ }
    // Hindi text fields: store the value and draw its appearance from correctly shaped outlines.
    for (const [f, it] of hindiFields) {
      try {
        f.setText(it.text);
        f.updateAppearances(font, (_field, widget) => {
          const r = widget.getRectangle();
          let size = Math.max(G.MIN_READABLE, Math.min(G.MAX_READABLE, r.height * 0.62, r.height * 0.8 + 1));
          size = G.fitFontSize(it.text, size, r.width - 4, (t, s) => writer.widthOf(t, s));
          const ops = [];
          // keep the field's border (the default appearance would have drawn it)
          const mk = widget.getAppearanceCharacteristics();
          if (mk?.getBorderColor()?.length) {
            const bw = widget.getBorderStyle()?.getWidth() ?? 1;
            ops.push(...drawRectangle({ x: bw / 2, y: bw / 2, width: r.width - bw, height: r.height - bw, borderWidth: bw,
              borderColor: rgb(0, 0, 0), rotate: degrees(0), xSkew: degrees(0), ySkew: degrees(0) }));
          }
          ops.push(...writer.outlineOps(it.text, { x: 2, y: r.height / 2 - size * 0.3, size, color: rgb(0, 0, 0) }));
          return { normal: ops };
        });
      } catch (err) {
        problems.push(err.mixed ? `${it.label} (mixed Hindi and English in one field)` : `${it.label} (${err.message})`);
      }
    }
    if ($('#flatten').checked) form.flatten();
  }

  // 2) Text and ticks drawn onto the page
  const pdfPages = doc.getPages();
  for (const it of items.filter((i) => !i.acro)) {
    const pg = pdfPages[it.page - 1];
    const vp = pages[it.page - 1].vp1;
    const bx = it.box.x * vp.width, by = it.box.y * vp.height, wPt = it.box.w * vp.width, hPt = it.box.h * vp.height;
    const toPdf = (lx, ly) => vp.convertToPdfPoint(bx + lx, by + ly);
    const [ox, oy] = toPdf(0, 0), [ax, ay] = toPdf(1, 0);
    const angle = Math.round((Math.atan2(ay - oy, ax - ox) * 180) / Math.PI);
    if (it.kind === 'check') {
      if (!it.checked) continue;
      const pts = G.TICK.map(([fx, fy]) => toPdf(fx * wPt, fy * hPt));
      const thickness = Math.max(1, Math.min(wPt, hPt) * 0.12);
      for (let i = 0; i < pts.length - 1; i++) {
        pg.drawLine({ start: { x: pts[i][0], y: pts[i][1] }, end: { x: pts[i + 1][0], y: pts[i + 1][1] }, thickness, color: rgb(0, 0, 0) });
      }
      continue;
    }
    if (!it.text) continue;
    if (!canWrite(it.text)) { problems.push(it.label || it.text); continue; }
    const fm = (t, s) => writer.widthOf(t, s);
    let size = it.fontSize || G.autoFontSize(hPt, it.cells);
    if (!(it.cells > 1)) size = G.fitFontSize(it.text, size, wPt - 3, fm);
    for (const piece of G.layoutText({ text: it.text, wPt, hPt, size, cells: it.cells, measure: fm })) {
      const [x, y] = toPdf(piece.x, piece.baseline);
      writer.draw(pg, piece.text, { x, y, size, angle, color: rgb(0, 0, 0) });
    }
  }
  return { bytes: await doc.save(), problems };
}

function outName() {
  return file.name.replace(/\.pdf$/i, '') + '-filled.pdf';
}

async function saveCommon(after) {
  const msg = $('#save-msg');
  msg.className = 'small muted';
  msg.textContent = 'Building PDF…';
  try {
    const { bytes, problems } = await buildPdf();
    await after(bytes);
    msg.className = problems.length ? 'small notice' : 'small ok';
    msg.textContent = problems.length
      ? `Saved, but these couldn't be written: ${problems.join(', ')}. Only English (Latin) and Hindi/Devanagari text is supported; please write these by hand.`
      : '✓ Done. Please check the PDF before you submit it.';
  } catch (err) {
    msg.className = 'small err';
    msg.textContent = err.message;
  }
}

$('#download').onclick = () => saveCommon(async (bytes) => {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: outName() });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
});

$('#to-locker').onclick = () => saveCommon(async (bytes) => {
  await addDocument(new Blob([bytes], { type: 'application/pdf' }), { name: outName(), tags: ['filled-form'] });
});

boot();
