// Injected only when you click "Fill this form". Runs in Chrome's isolated content-script world.
// Never submits forms. Never touches password / payment / bank / OTP fields.
(function () {
  'use strict';
  if (window.__formFiller) return;
  const C = globalThis.FFCore;

  // optional highlights (Settings → Filling): soft mint = filled, warm amber = needs you; clear on any site
  const GREEN = { outline: '2px solid #12a57a', bg: 'rgba(18,165,122,.12)' };
  const YELLOW = { outline: '2px solid #e3962b', bg: 'rgba(245,165,36,.16)' };
  const SKIP_TYPES = new Set(['hidden', 'submit', 'button', 'image', 'reset', 'file', 'range', 'color', 'search']);
  const TEXTISH = new Set(['text', 'email', 'tel', 'number', 'url', '', 'date', 'month', 'datetime-local', 'week', 'time']);

  const fields = new Map(); // ffId -> {el, group?: [radios], desc}
  const highlighted = new Set();
  const fileTokens = new Map(); // token -> input[type=file]
  let seq = 0;

  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const textOf = (el, max = 160) => clean(el?.innerText ?? el?.textContent).slice(0, max);

  function visible(el) {
    if (!el || !el.isConnected) return false;
    const st = getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden') return false;
    return el.getClientRects().length > 0;
  }

  function labelTextWithoutControls(label) {
    const clone = label.cloneNode(true);
    clone.querySelectorAll('select, option, input, textarea, button, script, style').forEach((n) => n.remove());
    return clean(clone.textContent).slice(0, 160);
  }

  function cellHeaders(el) {
    const td = el.closest('td, th');
    if (!td) return {};
    const tr = td.parentElement;
    const out = {};
    const cells = [...tr.children];
    const first = cells[0];
    if (first && first !== td && !first.querySelector('input, select, textarea')) out.row = textOf(first, 80);
    const table = td.closest('table');
    const idx = cells.indexOf(td);
    const headRow = table?.querySelector('thead tr') || table?.querySelector('tr');
    if (headRow && headRow !== tr) {
      let col = 0;
      for (const h of headRow.children) {
        const span = Number(h.colSpan) || 1;
        if (idx >= col && idx < col + span) { out.col = textOf(h, 80); break; }
        col += span;
      }
    }
    if (!out.col) {
      const prev = td.previousElementSibling;
      if (prev && !prev.querySelector('input, select, textarea')) out.prev = textOf(prev, 100);
    }
    return out;
  }

  function nearbyText(el) {
    let sib = el.previousElementSibling;
    for (let i = 0; sib && i < 3; i++, sib = sib.previousElementSibling) {
      if (sib.matches('input, select, textarea, button, br')) continue;
      const t = textOf(sib, 120);
      if (t && t.length < 120) return t;
    }
    const parent = el.parentElement;
    if (parent && parent.querySelectorAll('input, select, textarea').length === 1) {
      const t = labelTextWithoutControls(parent);
      if (t && t.length < 120) return t;
    }
    if (parent) {
      let ps = parent.previousElementSibling;
      if (ps && !ps.querySelector('input, select, textarea')) {
        const t = textOf(ps, 120);
        if (t && t.length < 120) return t;
      }
    }
    return '';
  }

  function labelFor(el) {
    const parts = [];
    const lb = el.getAttribute('aria-labelledby');
    if (lb) lb.split(/\s+/).forEach((id) => { const n = document.getElementById(id); if (n) parts.push(textOf(n)); });
    if (el.labels?.length) [...el.labels].forEach((l) => parts.push(labelTextWithoutControls(l)));
    if (!parts.join('')) {
      const cell = cellHeaders(el);
      if (cell.col || cell.prev) parts.push(cell.col || cell.prev);
    }
    if (!parts.join('')) parts.push(nearbyText(el));
    if (!parts.join('') && el.title) parts.push(el.title);
    return clean(parts.filter(Boolean).join(' ')).slice(0, 200);
  }

  function sectionFor(el) {
    const bits = [];
    const cell = cellHeaders(el);
    if (cell.row) bits.push(cell.row);
    const fs = el.closest('fieldset');
    const legend = fs?.querySelector(':scope > legend');
    if (legend) bits.push(textOf(legend, 80));
    else {
      // Nearest preceding heading while walking up the tree.
      let node = el;
      outer: for (let depth = 0; node && depth < 8; depth++, node = node.parentElement) {
        let sib = node.previousElementSibling;
        for (let i = 0; sib && i < 6; i++, sib = sib.previousElementSibling) {
          if (sib.matches('h1,h2,h3,h4,h5,h6,legend,caption,[role=heading],.section-title,.card-header,.panel-heading')) {
            bits.push(textOf(sib, 80)); break outer;
          }
          const h = sib.querySelector?.('h1,h2,h3,h4,h5,h6');
          if (h && !sib.querySelector('input,select,textarea')) { bits.push(textOf(h, 80)); break outer; }
        }
      }
    }
    const cap = el.closest('table')?.querySelector('caption');
    if (cap) bits.push(textOf(cap, 80));
    return clean([...new Set(bits)].join(' / ')).slice(0, 160);
  }

  function radioOptionText(r) {
    if (r.labels?.length) return labelTextWithoutControls(r.labels[0]);
    const next = r.nextSibling;
    if (next && next.nodeType === 3 && clean(next.textContent)) return clean(next.textContent).slice(0, 60);
    if (r.nextElementSibling && !r.nextElementSibling.matches('input')) return textOf(r.nextElementSibling, 60);
    return r.value;
  }

  function groupLabel(radios) {
    const first = radios[0];
    const rg = first.closest('[role=radiogroup]');
    if (rg?.getAttribute('aria-label')) return rg.getAttribute('aria-label');
    const fs = first.closest('fieldset');
    const legend = fs?.querySelector(':scope > legend');
    if (legend && radios.every((r) => fs.contains(r))) return textOf(legend);
    let box = first.parentElement;
    while (box && !radios.every((r) => box.contains(r))) box = box.parentElement;
    for (let d = 0; box && d < 3; d++, box = box.parentElement) {
      const clone = box.cloneNode(true);
      clone.querySelectorAll('input, label, select, textarea, option').forEach((n) => n.remove());
      const t = clean(clone.textContent);
      if (t) return t.slice(0, 160);
      const cell = cellHeaders(first);
      if (cell.col || cell.prev) return cell.col || cell.prev;
      const ps = box.previousElementSibling;
      if (ps && !ps.querySelector('input,select,textarea')) { const pt = textOf(ps, 160); if (pt) return pt; }
    }
    return first.name || '';
  }

  function baseDesc(el) {
    return {
      tag: el.tagName.toLowerCase(),
      type: (el.getAttribute('type') || (el.tagName === 'INPUT' ? 'text' : '')).toLowerCase(),
      name: el.name || '',
      idAttr: el.id || '',
      placeholder: el.placeholder || '',
      aria: el.getAttribute('aria-label') || '',
      autocomplete: el.getAttribute('autocomplete') || '',
      label: labelFor(el),
      section: sectionFor(el)
    };
  }

  // ---------------- scan ----------------
  function scan() {
    clearHighlights();
    fields.clear();
    const out = [];
    const seenRadio = new Set();
    const els = document.querySelectorAll('input, select, textarea');
    for (const el of els) {
      if (el.disabled || el.closest('[data-ff-ui]')) continue;
      const type = (el.getAttribute('type') || '').toLowerCase();
      if (el.tagName === 'INPUT' && SKIP_TYPES.has(type)) continue;

      if (type === 'radio') {
        const key = (el.form ? 'f' + [...document.forms].indexOf(el.form) : 'nf') + ':' + el.name;
        if (!el.name || seenRadio.has(key)) continue;
        seenRadio.add(key);
        const scope = el.form || document;
        const group = [...scope.querySelectorAll('input[type=radio]')].filter((r) => r.name === el.name && !r.disabled);
        if (!group.some((r) => visible(r) || (r.labels?.[0] && visible(r.labels[0])))) continue;
        const ffId = 'ff' + ++seq;
        const d = baseDesc(el);
        d.label = groupLabel(group);
        d.options = group.map((r) => ({ text: radioOptionText(r), value: r.value }));
        d.ffId = ffId;
        d.sensitive = C.isSensitive(d);
        fields.set(ffId, { el, group, desc: d });
        out.push(d);
        continue;
      }

      const shown = visible(el) || (type === 'checkbox' && el.labels?.[0] && visible(el.labels[0]));
      if (!shown) continue;
      const ffId = 'ff' + ++seq;
      const d = baseDesc(el);
      d.ffId = ffId;
      if (el.tagName === 'SELECT') {
        d.options = [...el.options].map((o) => ({
          text: clean(o.text).slice(0, 80), value: o.value,
          placeholder: C.isPlaceholderOption(o.text, o.value) || undefined
        }));
      }
      d.sensitive = C.isSensitive(d);
      fields.set(ffId, { el, desc: d });
      out.push(d);
    }
    const fileInputs = addLockerButtons();
    return { fields: out, fileInputs };
  }

  // ---------------- set values (framework friendly) ----------------
  function setNativeValue(el, value) {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    el.focus({ preventScroll: true });
    setter ? setter.call(el, value) : (el.value = value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.blur();
  }

  function dateText(desc, value, hint) {
    const native = C.nativeDateValue(value, desc.type);
    if (native) return native;
    const fmt = C.detectDateFormat([desc.placeholder, desc.label, desc.el?.pattern].join(' ')) || C.detectDateFormat(hint) || 'dd/mm/yyyy';
    return C.formatDate(value, fmt);
  }

  function selectOptions(el) {
    return [...el.options].map((o) => ({ text: o.text, value: o.value, placeholder: C.isPlaceholderOption(o.text, o.value) }));
  }

  /** Returns 'filled' | 'unsure' | 'nomatch' | 'kept' */
  function applyOne(f, a, overwrite) {
    const { el, desc } = f;
    const { value, kind } = a;

    if (f.group) {
      if (!overwrite && f.group.some((r) => r.checked)) return 'kept';
      const m = C.matchOption(desc.options, kind === 'bool' ? (value ? 'yes' : 'no') : value, kind);
      if (m.index < 0) return 'nomatch';
      const r = f.group[m.index];
      if (!r.checked) r.click();
      if (!r.checked) { r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); }
      return m.score >= 0.8 ? 'filled' : 'unsure';
    }

    if (desc.tag === 'select') {
      if (!overwrite && el.selectedIndex > 0 && !C.isPlaceholderOption(el.options[el.selectedIndex].text, el.value)) return 'kept';
      let v = value;
      if (kind === 'date') v = C.formatDate(value, 'dd/mm/yyyy');
      const m = C.matchOption(selectOptions(el), kind === 'bool' ? (value ? 'yes' : 'no') : v, kind);
      if (m.index < 0) return 'nomatch';
      if (el.selectedIndex !== m.index) {
        el.selectedIndex = m.index;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return m.score >= 0.8 ? 'filled' : 'unsure';
    }

    if (desc.type === 'checkbox') {
      const b = C.toBool(value);
      if (b === null) return 'nomatch';
      if (el.checked !== b) el.click();
      if (el.checked !== b) { el.checked = b; el.dispatchEvent(new Event('change', { bubbles: true })); }
      return 'filled';
    }

    if (TEXTISH.has(desc.type) || desc.tag === 'textarea') {
      if (!overwrite && el.value) return el.value === String(value) ? 'filled' : 'kept';
      let v = kind === 'date' ? dateText({ ...desc, el }, value, a.dateFormat) : kind === 'bool' ? (value ? 'Yes' : 'No') : String(value);
      if (desc.type === 'number' || el.inputMode === 'numeric') {
        const digits = v.replace(/[^\d.]/g, '');
        if (!digits) return 'nomatch';
        v = digits;
      }
      if (desc.type === 'tel') v = v.replace(/[^\d+\s-]/g, '');
      if (el.maxLength > 0 && v.length > el.maxLength) {
        const compact = v.replace(/[\s-]/g, '');
        if (compact.length <= el.maxLength) v = compact;
        else if (/^\+\d+\s/.test(v) && v.replace(/^\+\d+\s/, '').length <= el.maxLength) v = v.replace(/^\+\d+\s/, '');
        else return 'nomatch';
      }
      setNativeValue(el, v);
      return el.value === v || kind === 'date' ? 'filled' : 'unsure';
    }
    return 'nomatch';
  }

  /**
   * assignments: [{ffId, value, kind, sure, dateFormat, key}] ; review: [ffId] mapped-but-empty / unmapped
   */
  // Highlighting is optional (Settings → Filling → Highlight fields on the page); by default the page is left
  // exactly as it is apart from the filled values, and the summary is shown in the popup only.
  let highlightOn = false;

  /** Short, readable name of a field for the popup summary ("Mobile Number / मोबाइल नंबर :" → "Mobile Number"). */
  function shortLabel(f) {
    let l = String(f.desc.label || f.desc.placeholder || f.desc.name || '');
    l = l.split(/\s+\/\s+/)[0]
      .replace(/\s*\([^)]*\)\s*/g, ' ')
      .replace(/^[\s\d.)]+/, '')
      .replace(/[\s:*]+$/, '')
      .replace(/\s+/g, ' ').trim();
    if (!l) return 'Unnamed field';
    return l.length > 32 ? l.slice(0, 30).trim() + '…' : l;
  }

  async function fill({ assignments, review, overwrite, highlight }) {
    highlightOn = !!highlight;
    clearHighlights();
    const stats = { green: 0, yellow: 0, kept: 0, filled: 0, needs: [], check: [] };
    const pending = [];
    for (const a of assignments) {
      const f = fields.get(a.ffId);
      if (!f || f.desc.sensitive) continue;
      let r;
      try { r = applyOne(f, a, overwrite); } catch { r = 'nomatch'; }
      if (r === 'nomatch' && f.desc.tag === 'select') { pending.push(a); continue; }
      finish(f, a, r, stats);
    }
    // Dependent dropdowns (e.g. District loads after State): retry a few times.
    for (let round = 0; pending.length && round < 4; round++) {
      await new Promise((res) => setTimeout(res, 600));
      for (let i = pending.length - 1; i >= 0; i--) {
        const a = pending[i];
        const f = fields.get(a.ffId);
        let r;
        try { r = applyOne(f, a, overwrite); } catch { r = 'nomatch'; }
        if (r !== 'nomatch') { finish(f, a, r, stats); pending.splice(i, 1); }
      }
    }
    for (const a of pending) finish(fields.get(a.ffId), a, 'nomatch', stats);
    for (const id of review) {
      const f = fields.get(id);
      if (!f || f.desc.sensitive) continue;
      if (isFilledByUser(f)) continue;
      mark(f, YELLOW, 'Form Filler: not sure what goes here. Please fill or check manually.');
      stats.yellow++;
      stats.needs.push(shortLabel(f));
    }
    if (highlightOn) showPanel(stats);
    stats.needs = [...new Set(stats.needs)];
    stats.check = [...new Set(stats.check)];
    return stats;
  }

  function isFilledByUser(f) {
    if (f.group) return f.group.some((r) => r.checked);
    if (f.desc.type === 'checkbox') return false;
    if (f.desc.tag === 'select') return f.el.selectedIndex > 0;
    return !!f.el.value;
  }

  function finish(f, a, r, stats) {
    if (r === 'filled' && a.sure) { mark(f, GREEN, `Form Filler: filled from your profile (${a.key}).`); stats.green++; stats.filled++; }
    else if (r === 'filled' || r === 'unsure') { mark(f, YELLOW, `Form Filler: filled (${a.key}) but please double-check.`); stats.yellow++; stats.filled++; stats.check.push(shortLabel(f)); }
    else if (r === 'kept') { stats.kept++; }
    else { mark(f, YELLOW, `Form Filler: could not fill (${a.key}); no matching value or option.`); stats.yellow++; stats.needs.push(shortLabel(f)); }
  }

  // ---------------- highlights ----------------
  function targetsOf(f) {
    if (f.group) return f.group.map((r) => r.labels?.[0] && visible(r.labels[0]) ? r.labels[0] : r);
    if (f.desc.type === 'checkbox') return [f.el.labels?.[0] && !visible(f.el) ? f.el.labels[0] : f.el];
    return [f.el];
  }

  function mark(f, color, title) {
    if (!highlightOn) return; // default: no colours, borders, tints or tooltips on the page
    for (const t of targetsOf(f)) {
      if (!t.dataset.ffOrig) t.dataset.ffOrig = JSON.stringify({ o: t.style.outline, b: t.style.backgroundColor, t: t.title });
      t.style.setProperty('outline', color.outline, 'important');
      t.style.setProperty('outline-offset', '1px', 'important');
      t.style.setProperty('background-color', color.bg, 'important');
      t.title = title;
      highlighted.add(t);
    }
  }

  function clearHighlights() {
    for (const t of highlighted) {
      try {
        const o = JSON.parse(t.dataset.ffOrig || '{}');
        t.style.outline = o.o || '';
        t.style.outlineOffset = '';
        t.style.backgroundColor = o.b || '';
        t.title = o.t || '';
        delete t.dataset.ffOrig;
      } catch { /* element gone */ }
    }
    highlighted.clear();
    document.getElementById('ff-panel-host')?.remove();
  }

  // ---------------- summary panel ----------------
  function showPanel(stats) {
    document.getElementById('ff-panel-host')?.remove();
    const host = document.createElement('div');
    host.id = 'ff-panel-host';
    host.setAttribute('data-ff-ui', '');
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `<style>
      .p{position:fixed;right:16px;bottom:16px;z-index:2147483647;max-width:320px;background:#fff;color:#161a3a;overflow:hidden;
         border:1px solid #e3e0f0;border-radius:12px;box-shadow:0 12px 32px rgba(22,26,58,.18);padding:15px 16px 14px;
         font:13px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
      .p::before{content:'';position:absolute;left:0;right:0;top:0;height:3px;background:linear-gradient(120deg,#3b4bd8,#7b4fd6 36%,#d45a9a 70%,#f0876a)}
      b{display:block;margin-bottom:6px;font-weight:650}
      .k{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:7px;vertical-align:0}
      .row{display:flex;gap:8px;margin-top:10px}button{font:inherit;font-weight:500;color:#161a3a;border:1px solid #d7d3ea;background:#fff;border-radius:8px;padding:5px 11px;cursor:pointer}
      button:hover{background:#f4f1fe}button:focus-visible{outline:2px solid #7b4fd6;outline-offset:2px}
    </style>
    <div class="p" role="status">
      <b>Form Filler</b>
      <div><span class="k" style="background:#12a57a"></span>${stats.green} filled</div>
      <div><span class="k" style="background:#e3962b"></span>${stats.yellow} to check or fill yourself</div>
      ${stats.kept ? `<div>${stats.kept} already had a value (left as is)</div>` : ''}
      <div style="margin-top:6px;color:#5f6385">Review everything before you submit. Form Filler never submits forms.</div>
      <div class="row"><button id="c">Clear highlights</button><button id="x">Close</button></div>
    </div>`;
    root.getElementById('c').onclick = () => clearHighlights();
    root.getElementById('x').onclick = () => host.remove();
    document.documentElement.appendChild(host);
  }

  // ---------------- document locker buttons ----------------
  function uploadContextText(input) {
    const bits = [labelFor(input), input.accept];
    let n = input.parentElement;
    for (let i = 0; n && i < 3; i++, n = n.parentElement) {
      // stop before a container that also holds another upload (its rules belong to that field)
      if ([...n.querySelectorAll('input[type=file]')].some((o) => o !== input)) break;
      const t = clean(n.innerText || '');
      if (t.length < 400) bits.push(t); else break;
    }
    return bits.join(' ');
  }

  function addLockerButtons() {
    const inputs = [...document.querySelectorAll('input[type=file]')].filter((i) => !i.disabled);
    for (const input of inputs) {
      if (input.dataset.ffLocker) continue;
      const token = crypto.randomUUID();
      input.dataset.ffLocker = token;
      fileTokens.set(token, input);
      const host = document.createElement('span');
      host.setAttribute('data-ff-ui', '');
      host.style.cssText = 'display:inline-block;margin:4px 6px;vertical-align:middle';
      const root = host.attachShadow({ mode: 'closed' });
      // white chip with a thin sunset border and navy text: readable on any site
      root.innerHTML = `<style>button{display:inline-flex;align-items:center;gap:6px;font:600 12px/1 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#2a2e63;
          border:1.5px solid transparent;border-radius:8px;padding:6px 11px 6px 9px;cursor:pointer;
          background:linear-gradient(#fff,#fff) padding-box,linear-gradient(120deg,#3b4bd8,#7b4fd6 36%,#d45a9a 70%,#f0876a) border-box;box-shadow:0 1px 2px rgba(22,26,58,.12);transition:box-shadow .15s,background .15s}
        button:hover{background:linear-gradient(#f6f2ff,#f6f2ff) padding-box,linear-gradient(120deg,#3b4bd8,#7b4fd6 36%,#d45a9a 70%,#f0876a) border-box;box-shadow:0 4px 12px -4px rgba(123,79,214,.45)}
        button:focus-visible{outline:2px solid #7b4fd6;outline-offset:2px}svg{flex:none}</style><button type="button" title="Attach a document from Form Filler's encrypted locker"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#7b4fd6" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m20 11.5-8 8a5 5 0 0 1-7-7l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7l-8.4 8.4a1.7 1.7 0 0 1-2.4-2.4l7.6-7.6"/></svg>Pick from locker</button>`;
      root.querySelector('button').addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        openPicker(token, input);
      });
      // If the real input is hidden behind a custom button, put ours after the visible wrapper.
      let anchor = input;
      while (anchor.parentElement && !visible(anchor) && anchor.parentElement !== document.body) anchor = anchor.parentElement;
      anchor.insertAdjacentElement('afterend', host);
    }
    return inputs.length;
  }

  // ---------------- upload rule text (for AI) ----------------
  const RULE_WORDS = /\b(kb|mb|kilobytes?|pixels?|px|dpi|jpe?g|png|pdf|dimensions?|width|height|cm|mm|resolution|size)\b/i;
  /** Redact anything that looks personal before text leaves the page. */
  function redact(t) {
    return t
      .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[email]')
      .replace(/(\+?\d[\d\s-]{8,}\d)/g, (m) => (m.replace(/\D/g, '').length >= 8 ? '[number]' : m))
      .replace(/\b\d{6,}\b/g, '[number]');
  }
  /**
   * Short pieces of the page's visible text that state upload rules: nearest to the field first,
   * then elsewhere on the page. Input values are never included (innerText doesn't contain them).
   */
  function ruleSnippets(input) {
    const out = [];
    const seen = new Set();
    let total = 0;
    const add = (raw) => {
      const t = redact(clean(raw)).slice(0, 300);
      if (t.length < 6 || !RULE_WORDS.test(t) || !/\d/.test(t) || seen.has(t)) return;
      for (const s of seen) if (s.includes(t) || t.includes(s)) return;
      if (total + t.length > 4000 || out.length >= 30) return;
      seen.add(t); out.push(t); total += t.length;
    };
    // 1) the field's own surroundings
    add(labelFor(input));
    let n = input.parentElement;
    for (let i = 0; n && i < 4; i++, n = n.parentElement) {
      if ([...n.querySelectorAll('input[type=file]')].some((o) => o !== input)) break;
      const t = clean(n.innerText || '');
      if (t.length <= 400) add(t);
    }
    // 2) instruction blocks anywhere on the page
    const blocks = document.querySelectorAll('p, li, td, th, label, dd, dt, span, small, b, strong, font, h1, h2, h3, h4, h5, h6, div');
    for (const el of blocks) {
      if (el.closest('[data-ff-ui], script, style, noscript, input, textarea, select')) continue;
      if (el.tagName === 'DIV' && el.querySelector('div, p, table, ul, ol')) continue; // leaf-ish divs only
      const t = el.innerText || '';
      if (t.length > 300 || !visible(el)) continue;
      add(t);
    }
    return out;
  }

  function openPicker(token, input) {
    closePicker();
    const req = C.parseUploadRequirements(uploadContextText(input), labelFor(input));
    const params = new URLSearchParams({
      token,
      accept: input.accept || '',
      label: labelFor(input).slice(0, 100),
      req: JSON.stringify(req)
    });
    const wrap = document.createElement('div');
    wrap.id = 'ff-picker-wrap';
    wrap.setAttribute('data-ff-ui', '');
    wrap.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:rgba(15,18,38,.55);backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px);display:flex;align-items:center;justify-content:center';
    const frame = document.createElement('iframe');
    frame.src = chrome.runtime.getURL('picker/picker.html') + '?' + params.toString();
    frame.style.cssText = 'width:min(980px,96vw);height:min(820px,94vh);border:0;border-radius:16px;background:transparent;color-scheme:normal;box-shadow:0 24px 60px rgba(15,18,38,.45),0 0 60px -12px rgba(212,90,154,.4)';
    wrap.appendChild(frame);
    wrap.addEventListener('click', (e) => { if (e.target === wrap) closePicker(); });
    document.documentElement.appendChild(wrap);
  }

  function closePicker() {
    document.getElementById('ff-picker-wrap')?.remove();
  }

  function b64ToBytes(b64) {
    const s = atob(b64);
    const u8 = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
    return u8;
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'ff-attach' && fileTokens.has(msg.token)) {
      const input = fileTokens.get(msg.token);
      try {
        const file = new File([b64ToBytes(msg.b64)], msg.name, { type: msg.mime, lastModified: Date.now() });
        const dt = new DataTransfer();
        if (input.multiple) for (const f of input.files || []) dt.items.add(f);
        dt.items.add(file);
        input.files = dt.files;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        closePicker();
        const target = visible(input) ? input : input.parentElement;
        if (target && highlightOn) {
          target.style.setProperty('outline', GREEN.outline, 'important');
          highlighted.add(target);
        }
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: String(e.message || e) });
      }
      return;
    }
    if (msg?.type === 'ff-rule-text' && fileTokens.has(msg.token)) {
      const input = fileTokens.get(msg.token);
      sendResponse({ ok: true, label: labelFor(input).slice(0, 120), accept: input.accept || '', snippets: ruleSnippets(input) });
      return;
    }
    if (msg?.type === 'ff-close-picker' && fileTokens.has(msg.token)) {
      closePicker();
      sendResponse({ ok: true });
    }
  });

  window.__formFiller = { scan, fill, clear: clearHighlights };
})();
