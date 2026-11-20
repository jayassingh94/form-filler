// Photo / signature editor: rules (page, AI, presets, custom), crop with a movable box, exact resize,
// JPEG size targeting and signature clean-up. All processing happens locally on canvases.
import { PRESETS, PRESETS_CHECKED, presetRule } from './presets.js';
import * as IP from './imgproc.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const kb = (bytes) => (bytes / 1024).toFixed(1) + ' KB';
const mk = (w, h) => new OffscreenCanvas(Math.max(1, Math.round(w)), Math.max(1, Math.round(h)));
const KIND_LABEL = { photo: 'Photo', signature: 'Signature', thumb: 'Thumb impression' };

/**
 * opts: {
 *   blob, name, rule (rules read from the page, may be {}), kind,
 *   ai: null | { preview(): Promise<{snippets,label}>, run(preview): Promise<rule> },
 *   primaryLabel, allowSaveCopy, onDone(blob, info, {saveCopy}), onCancel()
 * }
 */
export async function openImageEditor(host, opts) {
  const pageRule = clean(opts.rule || {});
  const st = {
    kind: opts.kind || pageRule.kind || guessKind(opts.name),
    source: Object.keys(pageRule).some((k) => /KB|idth|eight/.test(k)) ? 'page' : 'custom',
    rule: {}, note: '', userDims: null, rot: 0,
    crop: null, clean: false, threshold: 200, autoThreshold: 200, darken: true, pad: true,
    result: null, aiRule: null
  };
  if (!['photo', 'signature', 'thumb'].includes(st.kind)) st.kind = 'photo';
  st.clean = st.kind === 'signature';

  const bitmap = await createImageBitmap(opts.blob);
  let src = null; // rotated source canvas

  host.innerHTML = `
  <div class="ie">
    <div class="ie-head">
      <b>Prepare “${esc(opts.name)}”</b>
      <div class="ie-seg" role="group" aria-label="Type">${['photo', 'signature', 'thumb'].map((k) => `<button data-kind="${k}">${KIND_LABEL[k]}</button>`).join('')}</div>
    </div>
    <section class="ie-rules">
      <div class="ie-row">
        <label class="grow"><span>Size rules</span><select id="ie-source"></select></label>
        ${opts.ai ? '<button id="ie-ai" type="button">✨ Read rules from this page with AI</button>' : ''}
      </div>
      <div id="ie-ai-box" class="ie-ai hidden"></div>
      <div class="ie-grid">
        <label><span>Width (px)</span><input id="ie-w" type="number" min="16" max="8000"></label>
        <label><span>Height (px)</span><input id="ie-h" type="number" min="16" max="8000"></label>
        <label><span>Min KB</span><input id="ie-min" type="number" min="0" step="1"></label>
        <label><span>Max KB</span><input id="ie-max" type="number" min="1" step="1"></label>
        <label><span>Format</span><select id="ie-fmt"><option value="jpg">JPG</option><option value="png">PNG</option></select></label>
      </div>
      <div id="ie-note" class="small muted"></div>
    </section>
    <section class="ie-work">
      <div class="ie-stage-wrap">
        <div class="ie-stage" id="ie-stage"><canvas id="ie-view"></canvas><div class="ie-crop" id="ie-crop"><span class="ie-h" data-h="se"></span><span class="ie-h" data-h="nw"></span></div></div>
        <div class="ie-row small">
          <button id="ie-rot" type="button">↻ Rotate</button>
          <button id="ie-reset" type="button">Reset crop</button>
          <button id="ie-trim" type="button" class="hidden">Trim to signature</button>
          <span class="muted">Drag the box to move it; drag a corner to resize.</span>
        </div>
        <div id="ie-sig" class="ie-sig hidden">
          <label class="ie-check"><input type="checkbox" id="ie-clean"> Clean background to white</label>
          <label class="ie-slider"><span>Paper threshold <b id="ie-tval"></b> <button type="button" class="link small" id="ie-tauto">auto</button></span>
            <input type="range" id="ie-thr" min="60" max="250"></label>
          <label class="ie-check"><input type="checkbox" id="ie-dark"> Darken ink</label>
        </div>
      </div>
      <div class="ie-out">
        <div class="ie-preview"><img id="ie-img" alt="Result preview"></div>
        <div id="ie-stats" class="ie-stats"></div>
        <label class="ie-check small"><input type="checkbox" id="ie-pad"> If the file is still below the minimum, pad it with empty metadata (the picture is unchanged)</label>
      </div>
    </section>
    <div class="ie-actions">
      <button class="primary" id="ie-ok" disabled>${esc(opts.primaryLabel || 'Use this')}</button>
      ${opts.allowSaveCopy ? '<label class="ie-check small"><input type="checkbox" id="ie-copy"> Also save this copy to my locker</label>' : ''}
      <button id="ie-cancel" type="button">Cancel</button>
    </div>
  </div>`;

  const $ = (s) => host.querySelector(s);
  const view = $('#ie-view'), cropEl = $('#ie-crop'), stage = $('#ie-stage');
  let scale = 1;
  let previewUrl = null;

  // ---------- rules ----------
  function sourceOptions() {
    const o = [];
    if (Object.keys(pageRule).length) o.push(['page', 'Read from this page (please check)']);
    if (st.aiRule) o.push(['ai', 'From AI reading of this page']);
    for (const p of PRESETS) o.push([`preset:${p.id}`, p.name]);
    o.push(['custom', 'Custom']);
    $('#ie-source').innerHTML = o.map(([v, t]) => `<option value="${v}">${esc(t)}</option>`).join('');
    $('#ie-source').value = o.some(([v]) => v === st.source) ? st.source : 'custom';
  }

  function applySource() {
    const s = st.source;
    let r = {}, note = '';
    if (s === 'page') { r = { ...pageRule }; note = 'Read from text next to the upload field. Check it against the form\'s instructions.'; }
    else if (s === 'ai') { r = { ...st.aiRule }; note = `Read by AI from this page's text${st.aiRule.notes ? ': ' + String(st.aiRule.notes).replace(/[.\s]+$/, '') : ''}. Please double-check.`; }
    else if (s.startsWith('preset:')) {
      const id = s.slice(7);
      r = presetRule(id, st.kind) || {};
      const p = PRESETS.find((x) => x.id === id);
      note = r.minKB !== undefined
        ? `${p.name}: typical recent values (compiled ${PRESETS_CHECKED}). ${p.note} Always check the official notice.`
        : `${p.name} has no preset for a ${KIND_LABEL[st.kind].toLowerCase()}. Enter the values from the notice.`;
    } else {
      r = { ...st.rule };
      note = 'Enter the values from the form\'s instructions.';
    }
    st.rule = clean(r);
    st.userDims = null;
    st.note = note;
    if (st.rule.format === 'pdf') st.rule.format = 'jpg';
    fillRuleInputs();
    resetCrop();
  }

  function fillRuleInputs() {
    const r = st.rule;
    const t = target();
    $('#ie-w').value = t.w; $('#ie-h').value = t.h;
    $('#ie-min').value = r.minKB ?? ''; $('#ie-max').value = r.maxKB ?? '';
    $('#ie-fmt').value = r.format === 'png' ? 'png' : 'jpg';
    const range = r.minWidth || r.maxWidth ? ` Allowed: ${r.minWidth || '?'}–${r.maxWidth || '?'} × ${r.minHeight || '?'}–${r.maxHeight || '?'} px.` : '';
    const cmNote = r.fromCm ? ' Pixel size derived from the cm size (100 px per cm).' : '';
    $('#ie-note').textContent = st.note + range + cmNote;
  }

  function target() {
    if (st.userDims) return st.userDims;
    const c = st.crop || { w: src?.width || 1, h: src?.height || 1 };
    return IP.computeTarget(st.rule, c.w, c.h);
  }

  function aspect() {
    if (st.userDims) return { fixed: st.userDims.w / st.userDims.h };
    return IP.aspectFor(st.rule);
  }

  const onRuleInput = () => {
    const w = Number($('#ie-w').value), h = Number($('#ie-h').value);
    if (w >= 16 && h >= 16) {
      const t = target();
      if (w !== t.w || h !== t.h) { st.userDims = { w, h, exact: true }; resetCrop(); }
    }
    st.rule.minKB = Number($('#ie-min').value) || undefined;
    st.rule.maxKB = Number($('#ie-max').value) || undefined;
    st.rule.format = $('#ie-fmt').value;
    if (st.source !== 'custom') { // values edited by hand: keep them as a custom rule
      st.source = 'custom';
      $('#ie-source').value = 'custom';
      $('#ie-note').textContent = 'Custom values.';
    }
    schedule();
  };
  ['#ie-w', '#ie-h', '#ie-min', '#ie-max'].forEach((s) => $(s).addEventListener('change', onRuleInput));
  $('#ie-fmt').addEventListener('change', onRuleInput);
  $('#ie-source').addEventListener('change', (e) => { st.source = e.target.value; applySource(); });

  // AI rules
  if (opts.ai) {
    $('#ie-ai').onclick = async () => {
      const box = $('#ie-ai-box');
      box.classList.remove('hidden');
      box.innerHTML = '<span class="small muted">Collecting the size instructions from the page…</span>';
      try {
        const prev = await opts.ai.preview();
        if (!prev.snippets.length) { box.innerHTML = '<span class="small">No size instructions found in the page text.</span>'; return; }
        box.innerHTML = `
          <p class="small">Only these <b>${prev.snippets.length} text snippet(s)</b> from the page will be sent to Gemini.
            No image and none of your details. E-mails and long numbers are already masked.</p>
          <details class="small"><summary>Show what will be sent</summary><ul>${prev.snippets.map((s) => `<li>${esc(s)}</li>`).join('')}</ul></details>
          <div class="ie-row"><button class="primary" id="ie-ai-go" type="button">Send &amp; read rules</button><span id="ie-ai-msg" class="small"></span></div>`;
        $('#ie-ai-go').onclick = async () => {
          $('#ie-ai-msg').className = 'small muted'; $('#ie-ai-msg').textContent = 'Asking Gemini…';
          try {
            const r = clean(await opts.ai.run(prev));
            if (!Object.keys(r).some((k) => /KB|idth|eight/.test(k))) { $('#ie-ai-msg').textContent = 'No size rules for this field were found in the text.'; return; }
            st.aiRule = r;
            if (r.kind && KIND_LABEL[r.kind] && r.kind !== st.kind) setKind(r.kind, false);
            st.source = 'ai';
            sourceOptions();
            applySource();
            box.classList.add('hidden');
          } catch (err) {
            $('#ie-ai-msg').className = 'small err'; $('#ie-ai-msg').textContent = err.message;
          }
        };
      } catch (err) {
        box.innerHTML = `<span class="small err">${esc(err.message)}</span>`;
      }
    };
  }

  // ---------- kind ----------
  function setKind(k, reapply = true) {
    st.kind = k;
    host.querySelectorAll('[data-kind]').forEach((b) => b.classList.toggle('on', b.dataset.kind === k));
    const sig = k === 'signature';
    $('#ie-sig').classList.toggle('hidden', !sig && k !== 'thumb');
    $('#ie-trim').classList.toggle('hidden', !sig && k !== 'thumb');
    st.clean = sig;
    $('#ie-clean').checked = st.clean;
    if (reapply) applySource();
  }
  host.querySelectorAll('[data-kind]').forEach((b) => (b.onclick = () => setKind(b.dataset.kind)));

  // ---------- source image & crop ----------
  function buildSource() {
    const r = st.rot % 360;
    const sw = r % 180 ? bitmap.height : bitmap.width, sh = r % 180 ? bitmap.width : bitmap.height;
    src = mk(sw, sh);
    const c = src.getContext('2d');
    c.translate(sw / 2, sh / 2);
    c.rotate((r * Math.PI) / 180);
    c.drawImage(bitmap, -bitmap.width / 2, -bitmap.height / 2);
    // automatic paper threshold from a small copy
    const small = mk(Math.min(400, sw), Math.min(400, sw) * (sh / sw));
    small.getContext('2d').drawImage(src, 0, 0, small.width, small.height);
    const d = small.getContext('2d').getImageData(0, 0, small.width, small.height).data;
    st.autoThreshold = Math.min(245, Math.max(80, IP.otsu(IP.luminanceHistogram(d)) + 12));
    st.threshold = st.autoThreshold;
    drawView();
  }

  function drawView() {
    const maxW = Math.min(stage.parentElement.clientWidth || 520, 560), maxH = 380;
    scale = Math.min(maxW / src.width, maxH / src.height, 1);
    view.width = Math.round(src.width * scale);
    view.height = Math.round(src.height * scale);
    view.getContext('2d').drawImage(src, 0, 0, view.width, view.height);
    stage.style.width = view.width + 'px';
    stage.style.height = view.height + 'px';
  }

  function resetCrop() {
    if (!src) return;
    const a = aspect();
    st.crop = IP.centeredCrop(src.width, src.height, a.fixed);
    if (!st.userDims) { const t = target(); $('#ie-w').value = t.w; $('#ie-h').value = t.h; }
    placeCrop();
    schedule();
  }

  function placeCrop() {
    const c = st.crop;
    Object.assign(cropEl.style, { left: c.x * scale + 'px', top: c.y * scale + 'px', width: c.w * scale + 'px', height: c.h * scale + 'px' });
  }

  function clampCrop(c) {
    const W = src.width, H = src.height;
    c.w = Math.min(c.w, W); c.h = Math.min(c.h, H);
    c.x = Math.min(Math.max(0, c.x), W - c.w);
    c.y = Math.min(Math.max(0, c.y), H - c.h);
    return c;
  }

  cropEl.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const handle = e.target.dataset.h;
    const start = { x: e.clientX, y: e.clientY, c: { ...st.crop } };
    const a = aspect();
    try { cropEl.setPointerCapture(e.pointerId); } catch { /* synthetic or already-released pointer */ }
    const move = (ev) => {
      const dx = (ev.clientX - start.x) / scale, dy = (ev.clientY - start.y) / scale;
      let c = { ...start.c };
      if (!handle) { c.x += dx; c.y += dy; }
      else {
        const sign = handle === 'se' ? 1 : -1;
        let w = Math.max(20, start.c.w + sign * dx);
        let h = a.fixed ? w / a.fixed : Math.max(20, start.c.h + sign * dy);
        if (!a.fixed && a.min) { const r = Math.min(a.max, Math.max(a.min, w / h)); h = w / r; }
        if (w > src.width) { w = src.width; if (a.fixed) h = w / a.fixed; }
        if (h > src.height) { h = src.height; if (a.fixed) w = h * a.fixed; }
        if (handle === 'nw') { c.x = start.c.x + start.c.w - w; c.y = start.c.y + start.c.h - h; }
        c.w = w; c.h = h;
      }
      st.crop = clampCrop(c);
      placeCrop();
    };
    const up = () => { cropEl.removeEventListener('pointermove', move); cropEl.removeEventListener('pointerup', up); schedule(); };
    cropEl.addEventListener('pointermove', move);
    cropEl.addEventListener('pointerup', up);
  });

  $('#ie-rot').onclick = () => { st.rot = (st.rot + 90) % 360; buildSource(); resetCrop(); updateSigInputs(); };
  $('#ie-reset').onclick = () => resetCrop();
  $('#ie-trim').onclick = () => {
    const d = src.getContext('2d').getImageData(0, 0, src.width, src.height).data;
    const b = IP.inkBounds(d, src.width, src.height, st.threshold);
    if (!b) return;
    const padX = b.w * 0.08 + 4, padY = b.h * 0.15 + 4;
    let c = { x: b.x - padX, y: b.y - padY, w: b.w + 2 * padX, h: b.h + 2 * padY };
    const a = aspect();
    if (a.fixed) c = IP.growToAspect(c, a.fixed);
    st.crop = clampCrop(c);
    placeCrop();
    schedule();
  };

  // ---------- signature clean-up ----------
  function updateSigInputs() {
    $('#ie-clean').checked = st.clean;
    $('#ie-thr').value = st.threshold;
    $('#ie-tval').textContent = st.threshold;
    $('#ie-dark').checked = st.darken;
    $('#ie-thr').disabled = $('#ie-dark').disabled = !st.clean;
  }
  $('#ie-clean').onchange = (e) => { st.clean = e.target.checked; updateSigInputs(); schedule(); };
  $('#ie-thr').oninput = (e) => { st.threshold = Number(e.target.value); $('#ie-tval').textContent = st.threshold; schedule(); };
  $('#ie-tauto').onclick = () => { st.threshold = st.autoThreshold; updateSigInputs(); schedule(); };
  $('#ie-dark').onchange = (e) => { st.darken = e.target.checked; schedule(); };
  $('#ie-pad').onchange = (e) => { st.pad = e.target.checked; schedule(); };

  // ---------- processing ----------
  let timer = null, running = 0;
  function schedule() { clearTimeout(timer); timer = setTimeout(process, 200); }

  async function process() {
    if (!src || !st.crop) return;
    const my = ++running;
    const t = target();
    $('#ie-stats').innerHTML = '<span class="muted">Working…</span>';
    let c = st.crop;
    // Work at up to 2× the target size, then clean, then make the exact size.
    let work = IP.renderCrop(src, c, Math.min(Math.round(c.w), t.w * 2), Math.min(Math.round(c.h), t.h * 2), mk);
    if (st.clean && (st.kind === 'signature' || st.kind === 'thumb')) {
      const ctx = work.getContext('2d');
      const img = ctx.getImageData(0, 0, work.width, work.height);
      IP.cleanSignature(img.data, st.threshold, { darken: st.darken });
      ctx.putImageData(img, 0, 0);
    }
    const out = fitInto(work, t.w, t.h);
    const fmt = st.rule.format === 'png' ? 'png' : 'jpg';
    const res = await IP.encodeToRange(out, { format: fmt, minKB: st.rule.minKB, maxKB: st.rule.maxKB, pad: st.pad });
    if (my !== running) return;
    st.result = { ...res, w: t.w, h: t.h, fmt };
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = URL.createObjectURL(res.blob);
    $('#ie-img').src = previewUrl;
    renderStats();
  }

  /** Draw `work` into w×h; keeps proportions (white margins) if the crop shape doesn't match. */
  function fitInto(work, w, h) {
    const ra = work.width / work.height, ta = w / h;
    if (Math.abs(ra - ta) / ta < 0.01) return IP.renderCrop(work, { x: 0, y: 0, w: work.width, h: work.height }, w, h, mk);
    const out = mk(w, h);
    const ctx = out.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
    const s = Math.min(w / work.width, h / work.height);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(work, (w - work.width * s) / 2, (h - work.height * s) / 2, work.width * s, work.height * s);
    return out;
  }

  function renderStats() {
    const r = st.result, rule = st.rule;
    const { lo, hi } = IP.byteWindow(rule.minKB, rule.maxKB);
    const sizeOk = r.blob.size >= lo && r.blob.size <= hi;
    const dimsOk = (!rule.minWidth || (r.w >= rule.minWidth && r.w <= (rule.maxWidth || 1e9) && r.h >= (rule.minHeight || 0) && r.h <= (rule.maxHeight || 1e9)));
    const range = rule.minKB || rule.maxKB ? `${rule.minKB ?? 0}–${rule.maxKB ?? '∞'} KB` : 'no size limit';
    const lines = [
      `<div class="big">${r.w} × ${r.h} px · ${kb(r.blob.size)} · ${r.fmt.toUpperCase()}</div>`,
      `<div class="${sizeOk ? 'ok' : 'err'} small">${sizeOk ? '✓' : '✗'} File size ${sizeOk ? 'inside' : 'outside'} ${range}${r.quality ? ` (quality ${Math.round(r.quality * 100)}%)` : ''}</div>`,
      `<div class="${dimsOk ? 'ok' : 'err'} small">${dimsOk ? '✓' : '✗'} Dimensions ${dimsOk ? 'OK' : 'outside the allowed range'}</div>`
    ];
    if (r.padded) lines.push('<div class="small muted">Padded with empty metadata to reach the minimum size.</div>');
    if (r.overMax) lines.push('<div class="small err">Still too large even at the lowest quality: use smaller dimensions.</div>');
    if (r.underMin && !r.padded) lines.push('<div class="small err">Below the minimum size: tick the padding option, use larger dimensions or PNG.</div>');
    $('#ie-stats').innerHTML = lines.join('');
    $('#ie-ok').disabled = false;
  }

  // ---------- finish ----------
  $('#ie-ok').onclick = async () => {
    if (!st.result) return;
    const base = String(opts.name || 'image').replace(/\.[^.]+$/, '');
    const name = `${base}_${st.result.w}x${st.result.h}.${st.result.fmt === 'png' ? 'png' : 'jpg'}`;
    $('#ie-ok').disabled = true;
    try {
      await opts.onDone(st.result.blob, { name, width: st.result.w, height: st.result.h, kind: st.kind }, { saveCopy: !!$('#ie-copy')?.checked });
    } finally {
      $('#ie-ok').disabled = false;
    }
  };
  $('#ie-cancel').onclick = () => { if (previewUrl) URL.revokeObjectURL(previewUrl); opts.onCancel?.(); };

  // ---------- start ----------
  $('#ie-pad').checked = st.pad;
  buildSource();
  sourceOptions();
  setKind(st.kind, false);
  updateSigInputs();
  if (st.source === 'page') applySource();
  else { st.rule = {}; applySource(); }
  return { state: st };
}

function clean(r) {
  const o = {};
  for (const [k, v] of Object.entries(r || {})) if (v !== undefined && v !== null && v !== '' && !Number.isNaN(v)) o[k] = v;
  return o;
}

function guessKind(name) {
  const n = String(name || '').toLowerCase();
  if (/sign/.test(n)) return 'signature';
  if (/thumb/.test(n)) return 'thumb';
  return 'photo';
}
