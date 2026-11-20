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
  $('#step-detect').open = true;
  $('#sum-detect').textContent = '';
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
  // "Post applied for": only ever from a custom field of yours, never your name
  if (C.isPostApplied(label)) { const c = customKeyFor(label); return c ? [c] : []; }
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
      it.box.y < prev.box.y + Math.max(prev.box.h * 3.5, 0.075) && it.box.x < prev.box.x + prev.box.w && it.box.x + it.box.w > prev.box.x;
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
      const full = G.distributeParts(parts, Array(cap).fill(widths[0]), size, measure, G.MIN_READABLE);
      if (!full.overflow) { it.text = full.lines.join('\n'); it.fontSize = full.size; it.sure = true; continue; }
      // not enough room after the colon: the free band under the label, if there is one
      if (it.altBox) {
        const aw = it.altBox.w * vp.width - 3, ah = it.altBox.h * vp.height;
        const r = G.distributeParts(parts, Array(G.lineCapacity(ah, G.MIN_READABLE)).fill(aw), G.MIN_READABLE + 0.5, measure);
        if (!r.overflow) { it.box = it.altBox; it.text = r.lines.join('\n'); it.fontSize = r.size; it.sure = true; continue; }
      }
      // still tight: the complete address in smaller text (min 8 pt), else a shorter one; either way, check it
      let best = G.distributeParts(parts, Array(cap).fill(widths[0]), size, measure);
      it.note = 'Smaller text to fit: check it is readable';
      if (best.overflow) {
        for (const v of G.addressVariants(parts).slice(1)) {
          best = G.distributeParts(v, Array(cap).fill(widths[0]), size, measure);
          it.note = 'Shortened to fit: check the address';
          if (!best.overflow) break;
        }
        if (best.overflow) it.note = 'Too long for the space';
      }
      it.text = best.lines.join('\n');
      it.fontSize = best.size;
      it.sure = false;
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

/**
 * Printed text of a page (cached). Returns all text pieces (to find labels and underlines);
 * p.text keeps only the "ink" values must not cover (underscore runs are where you write).
 */
async function pageText(p) {
  if (!p.raw) { p.raw = await textItems(p); p.text = G.inkItems(p.raw); }
  return p.raw;
}

/**
 * Make each filled value fit its space without touching printed text: if it doesn't fit after the colon at a
 * readable size, use the free band under the label; otherwise shrink (min 8 pt) and mark it to check.
 */
function fitAll() {
  for (const it of items) {
    if (it.kind !== 'text' || it.acro || it.cells > 1 || !it.text || it.edited) continue;
    const vp = pages[it.page - 1].vp1;
    const wPt = it.box.w * vp.width - 3, hPt = it.box.h * vp.height;
    const size = it.fontSize || G.autoFontSize(hPt);
    const widest = Math.max(...it.text.split('\n').map((l) => measure(l, G.MIN_READABLE)));
    if (widest > wPt && it.altBox && !it.addrGroup) {
      const aw = it.altBox.w * vp.width - 3;
      if (measure(it.text, G.MIN_READABLE) <= aw) { it.box = it.altBox; it.fontSize = Math.min(size, G.autoFontSize(it.altBox.h * vp.height)); continue; }
    }
    const fit = G.fitFontSize(it.text, size, wPt, measure);
    if (fit < G.MIN_READABLE || it.text.split('\n').some((l) => measure(l, fit) > wPt + 0.5)) {
      it.sure = false; // smaller than 10 pt or still too long: check it
      it.note ||= 'Smaller text to fit: check it is readable';
    }
    it.fontSize = fit;
  }
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
  let skipped = 0, noRoom = 0;
  for (const p of pages) {
    progress(`Reading page ${p.num} of ${pages.length} with AI…`);
    const raw = await detectFlatPage(apiKey, model, await pageImage(p.num), 'image/jpeg', catalog);
    const text = await pageText(p);
    const zone = officialZone(text);
    const lines = [...G.underlineRuns(text), ...(await printedRules(p))];
    const sorted = [...raw].map((r) => ({ r, box: G.fromBox2d(r.box_2d) })).filter((x) => x.box).sort((a, b) => a.box.y - b.box.y);
    for (const { r, box: b0 } of sorted) {
      let box = b0;
      if (r.kind === 'skip') continue;
      if (C.isSensitive({ label: r.label })) { skipped++; continue; }
      if (r.kind !== 'checkbox') {
        // sit on the printed line the box belongs to, and never over printed text
        box = G.snapByLabel(box, r.label, p.text, lines, C.norm);
        if (p.text.length) {
          const fixed = G.repairBox(box, p.text);
          if (!fixed) { noRoom++; continue; }
          box = fixed;
        }
      }
      if (zone.test({ label: r.label, box })) { items.push(officialItem(p.num, box, r.label)); continue; }
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
  fitAll();
  renderAll();
  return summary(skipped) + (noRoom ? ` ${noRoom} box(es) had no free space next to their label and were left out; add them with "+ Text".` : '');
}

// ---------------- flat path: offline (text layer) ----------------
$('#run-offline').onclick = () => runStep(detectOffline);

async function detectOffline() {
  items = items.filter((i) => i.edited);
  let found = 0, skipped = 0;
  for (const p of pages) {
    const text = await pageText(p);
    const rules = await printedRules(p);
    const used = new Set();
    // labels without a colon count when we recognise them ("Full Name", "Date of Birth", "Mobile No.")
    const known = (label) => label.length <= 60 && !!(customKeyFor(label) || C.labelKey(label) || C.heuristicKey({ label }));
    const upper = /capital|block letters/i.test(text.map((t) => t.text).join(' '));
    const zone = officialZone(text);
    for (const b of G.blanksFromTextLayer(text, known)) {
      if (C.isSensitive({ label: b.label })) { skipped++; continue; }
      if (zone.test(b)) { items.push(officialItem(p.num, b.box, b.label)); continue; }
      // signature / photo / thumb boxes stay empty, unless the label clearly asks for your details
      // ("…the details and photograph of Shri ____" is your name)
      if (/signature|photo|thumb|office use/i.test(b.label) && !candidateKeys(b.label, null).length) continue;
      if (b.kind === 'check') { // "Sex : Male : Female :"
        const keys = [...new Set([C.labelKey(b.label), C.heuristicKey({ label: b.label })].filter(Boolean))];
        items.push(newItem({ page: p.num, box: b.box, kind: 'check', label: b.label, option: b.option, key: keys[0] || null, keys, conf: 'high', group: `p${p.num}:${keys[0] || b.label}` }));
        continue;
      }
      const keys = candidateKeys(b.label, null);
      const key = keys[0] || null;
      // underscores mark the exact spot; otherwise use a drawn line next to the label, if there is one
      const rule = b.underline ? null : ruleForLabel(b.box, rules, used);
      // without a colon or a printed line, only trust precise labels ("Full Name"), not keyword guesses
      if (!b.colon && !rule && !customKeyFor(b.label) && !C.labelKey(b.label)) continue;
      const lines = [];
      if (rule) {
        lines.push(ruleBox(rule, p));
        if (isAddressKey(key)) for (const r of continuationRules(rule, rules, used, text)) lines.push(ruleBox(r, p));
      } else lines.push(b.box);
      lines.forEach((box, n) => {
        const it = newItem({ page: p.num, box, altBox: !rule && !n ? b.alt : null, label: n ? '' : b.label, key, keys: n ? [key] : keys, conf: key ? 'high' : 'low', upper });
        applyValue(it);
        items.push(it);
      });
      found++;
    }
  }
  if (!found) throw new Error('No text labels found. This looks like a scanned form: use AI detection, or add boxes yourself with "+ Text" / "+ Tick".');
  resolveCheckGroups();
  groupAddresses();
  resolveAddressGroups();
  fitAll();
  renderAll();
  const ticks = items.some((i) => i.kind === 'check');
  return summary(skipped) + (ticks ? '' : ' Tick boxes are not detected offline; add them with "+ Tick".');
}

/**
 * Officer-only parts of a page: an officer/authority label ("Name of Certifying Officer"), the generic
 * labels right after it ("Designation", "Phone No."), and everything under a "For office use only" heading.
 * Call test(blank) in top-to-bottom order.
 */
function officialZone(text) {
  const head = text.filter((t) => C.isOfficialHeading(t.text)).map((t) => t.y).sort((a, b) => a - b)[0];
  let inZone = false;
  return {
    test(b) {
      if (head != null && b.box.y > head) return true;
      if (C.isOfficialLabel(b.label)) { inZone = true; return true; }
      if (inZone && C.isOfficialFollower(b.label)) return true;
      inZone = false;
      return false;
    }
  };
}

/** A blank that belongs to the officer: shown grey, never filled from your profile. */
function officialItem(page, box, label) {
  return newItem({ page, box, label, key: null, keys: [], official: true, sure: true, note: 'For the officer: left blank' });
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

function summary(skipped) {
  const filled = items.filter((i) => (i.kind === 'text' ? i.text : i.checked) && i.sure).length;
  const review = items.filter((i) => i.kind === 'text' && !i.spare && !i.official && (!i.text || !i.sure)).length;
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
    if (aiWarning) { progress(`${text} ${aiWarning}`, 'warn'); }
    else {
      if (vault.settings.apiKey && lastModelUsed && lastModelUsed !== m && fn !== detectOffline) text += ` (${m} was busy, so ${lastModelUsed} answered.)`;
      progress(text, 'ok');
    }
    // done: fold steps 1–2 so the field list comes up
    $('#sum-detect').textContent = text.split(/[.(]/)[0];
    $('#step-choose').open = false;
    $('#step-detect').open = false;
    $('#step-edit').open = true;
    updateSummaries();
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
}

function isGreen(it) {
  if (it.kind === 'text' && it.text && pages[it.page - 1]?.text && G.overlapsText(it.box, pages[it.page - 1].text)) return false;
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
  el.className = `ov ${it.kind === 'check' ? 'check' : 'text'} ${it.official ? 'official' : it.spare ? 'spare' : isGreen(it) ? '' : 'y'} ${it.acro ? 'acro' : ''} ${selected === it.id ? 'sel' : ''}`;
  Object.assign(el.style, { left: it.box.x * 100 + '%', top: it.box.y * 100 + '%', width: it.box.w * 100 + '%', height: it.box.h * 100 + '%' });
  const onText = it.kind === 'text' && it.text && p.text && G.overlapsText(it.box, p.text);
  el.title = `${splitLabel(it.label).en}${onText ? ' ⚠ overlaps printed text' : it.note ? ` ⚠ ${it.note}` : ''}`;
  const k = p.cssW / p.vp1.width; // css px per pt
  const hPt = it.box.h * p.vp1.height;
  if (it.kind === 'check') {
    el.style.fontSize = Math.max(8, hPt * 0.9 * k) + 'px';
    el.innerHTML = `<span class="grip"></span>${it.checked ? '✓' : ''}<span class="rs"></span>`;
    return;
  }
  const size = it.fontSize || G.autoFontSize(hPt, it.cells);
  const fit = it.cells > 1 ? size : G.fitFontSize(it.text, size, it.box.w * p.vp1.width - 3, measure);
  el.style.fontSize = fit * k + 'px';
  if (it.cells > 1) {
    const chars = graphemes(it.text).slice(0, it.cells);
    el.innerHTML = `<span class="grip"></span><div class="cells">${Array.from({ length: it.cells }, (_, i) => `<span>${esc(chars[i] || '')}</span>`).join('')}</div><span class="rs"></span>`;
  } else {
    const multi = it.text.includes('\n');
    el.innerHTML = `<span class="grip"></span>${multi ? '<textarea' : '<input'} spellcheck="false" aria-label="${esc(splitLabel(it.label).en)}">${multi ? '</textarea>' : ''}<span class="rs"></span>`;
    const inp = el.querySelector('input, textarea');
    if (multi) inp.style.lineHeight = Math.max(fit * 1.25, (hPt / it.text.split('\n').length)) * k + 'px';
    inp.value = it.text;
    inp.oninput = () => {
      it.text = inp.value; it.edited = true; it.sure = !!it.text;
      el.classList.toggle('y', !isGreen(it));
      syncEditorText(it);
    };
    inp.onfocus = () => select(it.id, false);
  }
}

function attachDrag(el, it) {
  el.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    if (addMode) return;
    const grip = e.target.closest('.grip'), rs = e.target.closest('.rs');
    if (it.kind === 'check' && !grip && !rs) {
      toggleTick(it, !it.checked);
      select(it.id, false, { revealCard: true });
      return;
    }
    select(it.id, false, { revealCard: true });
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
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); refreshCard(it); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
}

/** Tick / untick; ticking one option of a group unticks the others. */
function toggleTick(it, on) {
  if (on && it.group) for (const o of items) if (o.group === it.group && o !== it) { o.checked = false; o.edited = true; o.sure = true; renderItem(o); }
  it.checked = on; it.edited = true; it.sure = true;
  renderItem(it);
  refreshCard(it);
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
  select(it.id, false, { revealCard: true });
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
const applyHighlight = () => $('#pages').classList.toggle('hl', $('#show-empty').checked);
$('#show-empty').onchange = applyHighlight;
applyHighlight();

/**
 * Select an item. `scroll` brings its box into view in the preview; `revealCard` scrolls its card into view
 * in the side panel.
 */
function select(id, scroll = false, { revealCard = false } = {}) {
  const prev = selected;
  selected = id;
  for (const p of pages) p.el.querySelectorAll('.ov.sel').forEach((n) => n.classList.remove('sel'));
  if (id) {
    const it = items.find((i) => i.id === id);
    const el = pages[it.page - 1]?.el.querySelector(`.ov[data-id="${id}"]`);
    el?.classList.add('sel');
    if (scroll) el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
  if (prev !== id) markSelectedCard();
  if (id && revealCard) {
    $('#step-edit').open = true;
    $('#item-list').querySelector('.fc.sel')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}

// ---------------- labels for display ----------------
const DEVA = /[ऀ-ॿ]/;
const CONS = '[\\u0915-\\u0939\\u0958-\\u095F]\\u093C?';
const ORPHAN_I = new RegExp(`(^|[^\\u0915-\\u0939\\u0958-\\u095F\\u093C])\\u093F((?:${CONS}\\u094D)*${CONS})`, 'g');
/** Tidy Hindi extracted from PDFs with old fonts: drop stray symbols, put a leading ि after its consonant ("िपता" → "पिता"). */
function cleanHindi(s) {
  return String(s).replace(/[Ā-˿�]/g, '').replace(ORPHAN_I, '$1$2ि').replace(/\s+/g, ' ').trim();
}
/** Bilingual "English / हिंदी" label -> { en, hi } (English first). */
function splitLabel(label) {
  const L = String(label || '').trim();
  if (!L) return { en: 'Text', hi: '' };
  const parts = L.split(/\s+\/\s+/);
  const isHi = (p) => DEVA.test(p) && !/[A-Za-z]{2}/.test(p);
  const en = parts.filter((p) => !isHi(p)).join(' / ');
  const hi = parts.filter(isHi).join(' / ');
  if (en && hi) return { en, hi: cleanHindi(hi) };
  if (!en) return { en: cleanHindi(hi), hi: '' };
  return { en: DEVA.test(en) ? cleanHindi(en) : en, hi: '' };
}

// ---------------- side panel: field cards ----------------
/** Cards: one per field; an address spread over several lines and a tick-box group each get one card. */
function entries() {
  const out = [];
  const seen = new Set();
  const sorted = [...items].sort((a, b) => a.page - b.page || a.box.y - b.box.y || a.box.x - b.box.x);
  for (const it of sorted) {
    if (seen.has(it.id)) continue;
    let group = [it], type = 'one';
    if (it.addrGroup) { group = sorted.filter((o) => o.addrGroup === it.addrGroup); type = 'addr'; }
    else if (it.kind === 'check' && it.group) { group = sorted.filter((o) => o.kind === 'check' && o.group === it.group); type = 'checks'; }
    group.forEach((o) => seen.add(o.id));
    out.push({ type, items: group, page: it.page });
  }
  return out;
}

function entryStatus(e) {
  if (e.items.every((i) => i.official)) return 's';
  if (e.type === 'addr') return e.items.some((i) => i.text) && e.items.every((i) => i.spare || isGreen(i)) ? 'g' : 'y';
  if (e.type === 'checks') return e.items.some((i) => i.checked) && e.items.every((i) => i.sure) ? 'g' : 'y';
  return isGreen(e.items[0]) ? 'g' : 'y';
}

let optsOpen = false;

function cardBody(e) {
  const it = e.items[0];
  if (e.type === 'addr') {
    const lines = e.items.map((i) => i.text);
    while (lines.length > 1 && !lines[lines.length - 1]) lines.pop();
    return `<textarea class="fc-input" data-act="addr" rows="${Math.max(2, e.items.length)}" spellcheck="false" aria-label="${esc(splitLabel(it.label).en)}">${esc(lines.join('\n'))}</textarea>`;
  }
  if (it.kind === 'check') {
    return `<div class="chips">${e.items.map((i) => {
      const opt = e.type === 'checks' ? splitLabel(i.option || i.label).en : 'Ticked';
      return `<label class="chip ${i.checked ? 'on' : ''}"><input type="checkbox" data-act="tick" data-item="${i.id}" ${i.checked ? 'checked' : ''}> ${esc(opt)}</label>`;
    }).join('')}</div>`;
  }
  if (it.options) {
    return `<select class="fc-input" data-act="sel"><option value=""></option>${it.options.map((o) => `<option ${o === it.text ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
  }
  if (it.text.includes('\n')) return `<textarea class="fc-input" data-act="text" rows="${it.text.split('\n').length}" spellcheck="false">${esc(it.text)}</textarea>`;
  return `<input class="fc-input" data-act="text" value="${esc(it.text)}" spellcheck="false" placeholder="Empty: type a value or leave blank" aria-label="${esc(splitLabel(it.label).en)}">`;
}

function keyOptions(current) {
  const cat = keyCatalog(profile());
  return `<option value="">(none: type your own)</option>` + cat.map((c) => `<option value="${c.key}" ${c.key === current ? 'selected' : ''}>${esc(c.desc)}</option>`).join('');
}

function cardOptions(it) {
  const p = pages[it.page - 1];
  const autoSize = G.autoFontSize(it.box.h * p.vp1.height, it.cells);
  const textOpts = it.kind === 'text' ? `
      <label><span>Fill from profile</span><select data-act="key">${keyOptions(it.key)}</select></label>
      ${it.acro ? '' : `<div class="grid2" style="margin-top:8px">
        <label><span>Font size (pt)</span><input data-act="size" type="number" min="5" max="36" step="0.5" value="${it.fontSize || autoSize}"></label>
        <label><span>Letter boxes</span><input data-act="cells" type="number" min="0" max="60" value="${it.cells || 0}"></label>
      </div>
      <label class="toggle" style="margin-top:8px"><input type="checkbox" data-act="upper" ${it.upper ? 'checked' : ''}> CAPITAL LETTERS</label>`}` : '';
  return `<details class="fc-opts" ${optsOpen ? 'open' : ''}><summary>Options</summary>${textOpts}
    <div class="row">${it.acro ? '' : '<button class="danger" data-act="del" type="button">Delete box</button>'}<button data-act="done" type="button">Done</button></div></details>`;
}

function renderList() {
  const host = $('#item-list');
  // keep focus and cursor while re-rendering
  const ae = document.activeElement;
  const keep = ae && host.contains(ae) ? { card: ae.closest('.fc')?.dataset.id, act: ae.dataset.act, item: ae.dataset.item, pos: ae.selectionStart } : null;
  if (!items.length) {
    host.innerHTML = '<div class="empty-list">No fields yet. Run step 2, or add your own with “+ Text”.</div>';
    updateSummaries();
    return;
  }
  const html = [];
  let lastPage = 0;
  const es = entries();
  for (const e of es) {
    if (pages.length > 1 && e.page !== lastPage) { html.push(`<div class="pg">Page ${e.page}</div>`); lastPage = e.page; }
    const it = e.items[0];
    const { en, hi } = splitLabel(it.label || (it.kind === 'check' ? 'Tick' : 'Text'));
    const sel = e.items.find((i) => i.id === selected);
    const note = e.items.map((i) => i.note).find(Boolean) ||
      (e.items.some((i) => i.kind === 'text' && i.text && pages[i.page - 1]?.text && G.overlapsText(i.box, pages[i.page - 1].text)) ? 'Overlaps printed text' : '');
    html.push(`<div class="fc ${sel ? 'sel' : ''} ${e.items.every((i) => i.official) ? 'official' : ''}" data-id="${it.id}" role="listitem">
      <div class="fc-head" data-act="pick"><span class="dot ${entryStatus(e)}" aria-label="${entryStatus(e) === 'g' ? 'filled' : 'to check'}"></span>
        <div class="fc-label"><div class="en">${esc(en)}</div>${hi ? `<div class="hi" lang="hi">${esc(hi)}</div>` : ''}${note ? `<div class="note">⚠ ${esc(note)}</div>` : ''}</div></div>
      ${cardBody(e)}
      ${sel ? cardOptions(sel) : ''}
    </div>`);
  }
  host.innerHTML = html.join('');
  if (keep?.card) {
    const card = host.querySelector(`.fc[data-id="${keep.card}"]`);
    const el = card?.querySelector(keep.item ? `[data-item="${keep.item}"]` : `[data-act="${keep.act}"]`);
    if (el) { el.focus({ preventScroll: true }); try { if (keep.pos != null) el.setSelectionRange(keep.pos, keep.pos); } catch { /* not a text input */ } }
  }
  updateSummaries();
}

/** Highlight the selected item's card and show its options, without rebuilding the list (keeps focus/caret). */
function markSelectedCard() {
  const host = $('#item-list');
  const sel = items.find((i) => i.id === selected);
  const es = entries();
  host.querySelectorAll('.fc').forEach((card) => {
    const e = es.find((x) => x.items[0].id === card.dataset.id);
    const has = !!sel && !!e?.items.includes(sel);
    card.classList.toggle('sel', has);
    const opts = card.querySelector('.fc-opts');
    if (opts && (!has || opts.dataset.item !== sel.id)) opts.remove();
    if (has && !card.querySelector('.fc-opts')) {
      card.insertAdjacentHTML('beforeend', cardOptions(sel));
      card.querySelector('.fc-opts').dataset.item = sel.id;
    }
  });
}

const cardOf = (el) => {
  const card = el.closest('.fc');
  if (!card) return null;
  const e = entries().find((x) => x.items[0].id === card.dataset.id);
  return e ? { card, e } : null;
};

/** Update one card's dot (and its input, if it isn't being typed in) without rebuilding the list. */
function refreshCard(it) {
  const e = entries().find((x) => x.items.includes(it));
  const card = e && $('#item-list').querySelector(`.fc[data-id="${e.items[0].id}"]`);
  if (!card) return;
  card.querySelector('.fc-head .dot').className = `dot ${entryStatus(e)}`;
  const inp = card.querySelector('.fc-input');
  if (inp && inp !== document.activeElement) {
    if (e.type === 'addr') inp.value = e.items.map((i) => i.text).join('\n').replace(/\n+$/, '');
    else if (inp.dataset.act === 'text') inp.value = it.text;
  }
  card.querySelectorAll('[data-act=tick]').forEach((cb) => {
    const o = items.find((i) => i.id === cb.dataset.item);
    cb.checked = !!o?.checked;
    cb.closest('.chip').classList.toggle('on', cb.checked);
  });
  updateSummaries();
}

$('#item-list').addEventListener('click', (ev) => {
  const c = cardOf(ev.target);
  if (!c) return;
  const act = ev.target.closest('[data-act]')?.dataset.act;
  const it = items.find((i) => i.id === selected) || c.e.items[0];
  if (act === 'pick') { select(c.e.items[0].id, true); return; }
  if (act === 'del' && !it.acro) {
    items = items.filter((i) => i !== it);
    pages[it.page - 1].el.querySelector(`.ov[data-id="${it.id}"]`)?.remove();
    select(null);
    renderList();
    return;
  }
  if (act === 'done') { select(null); return; }
});
$('#item-list').addEventListener('toggle', (ev) => { if (ev.target.matches('.fc-opts')) optsOpen = ev.target.open; }, true);
$('#item-list').addEventListener('focusin', (ev) => {
  const c = cardOf(ev.target);
  if (!c || ev.target.closest('.fc-opts')) return;
  if (!c.e.items.some((i) => i.id === selected)) select(c.e.items[0].id, true);
});
$('#item-list').addEventListener('input', (ev) => {
  const c = cardOf(ev.target);
  if (!c) return;
  const act = ev.target.dataset.act;
  const it = items.find((i) => i.id === selected) || c.e.items[0];
  if (act === 'text') {
    it.text = ev.target.value; it.edited = true; it.sure = !!it.text; it.note = null;
    renderItem(it); refreshCard(it);
  } else if (act === 'addr') {
    // one card line per printed line; anything extra joins the last line
    const lines = ev.target.value.split('\n');
    const n = c.e.items.length;
    c.e.items.forEach((o, k) => {
      o.text = k < n - 1 ? (lines[k] || '') : lines.slice(k).join(' ').trim();
      o.edited = true; o.sure = true; o.spare = !o.text && k > 0; o.note = null;
      renderItem(o);
    });
    refreshCard(c.e.items[0]);
  } else if (act === 'size') { it.fontSize = Number(ev.target.value) || null; it.edited = true; renderItem(it); }
  else if (act === 'cells') { it.cells = Math.max(0, Number(ev.target.value) || 0); it.edited = true; renderItem(it); }
});
$('#item-list').addEventListener('change', (ev) => {
  const c = cardOf(ev.target);
  if (!c) return;
  const act = ev.target.dataset.act;
  const it = items.find((i) => i.id === selected) || c.e.items[0];
  if (act === 'tick') { toggleTick(items.find((i) => i.id === ev.target.dataset.item), ev.target.checked); return; }
  if (act === 'sel') { it.text = ev.target.value; it.edited = true; it.sure = !!it.text; renderItem(it); refreshCard(it); return; }
  if (act === 'upper') { it.upper = ev.target.checked; it.text = it.upper ? it.text.toUpperCase() : it.text; it.edited = true; renderItem(it); renderList(); return; }
  if (act === 'key') {
    it.key = ev.target.value || null; it.keys = it.key ? [it.key] : []; it.conf = 'high';
    if (isAddressKey(it.key)) { it.addrGroup = 'm' + it.id; it.edited = false; resolveAddressGroups(); }
    else { it.addrGroup = null; applyValue(it); }
    it.edited = true; it.sure = !!it.text;
    renderItem(it); renderList();
  }
});

function syncEditorText(it) {
  refreshCard(it);
}

// ---------------- step summaries, collapsing ----------------
function updateSummaries() {
  const es = entries().filter((e) => !(e.type === 'one' && (e.items[0].spare || e.items[0].official)));
  const filled = es.filter((e) => entryStatus(e) === 'g').length;
  $('#sum-edit').textContent = es.length ? `${filled} filled · ${es.length - filled} to check` : '';
  $('#sum-choose').textContent = file ? file.name : '';
}

function setSideCollapsed(c) {
  $('#app').classList.toggle('collapsed', c);
  const b = $('#side-toggle');
  b.setAttribute('aria-expanded', String(!c));
  b.title = c ? 'Show panel' : 'Collapse panel';
  try { localStorage.setItem('ff_pdf_side', c ? '1' : '0'); } catch { /* storage unavailable */ }
}
$('#side-toggle').onclick = () => setSideCollapsed(!$('#app').classList.contains('collapsed'));
try { if (localStorage.getItem('ff_pdf_side') === '1') setSideCollapsed(true); } catch { /* storage unavailable */ }

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
