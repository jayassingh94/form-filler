// Pure geometry/text-layout helpers for "Fill a PDF". No DOM, no personal data.
import { graphemes } from './pdftext.js';
// Boxes are normalised to the rendered page: {x, y, w, h} in 0..1 with origin at the TOP-LEFT.

/** Gemini box_2d [ymin, xmin, ymax, xmax] in 0..1000 -> normalised box (clamped). */
export function fromBox2d(b) {
  if (!Array.isArray(b) || b.length !== 4 || b.some((n) => typeof n !== 'number' || !isFinite(n))) return null;
  let [y0, x0, y1, x1] = b.map((n) => Math.min(1000, Math.max(0, n)) / 1000);
  if (x1 < x0) [x0, x1] = [x1, x0];
  if (y1 < y0) [y0, y1] = [y1, y0];
  if (x1 - x0 < 0.003 || y1 - y0 < 0.003) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** pdf.js viewport rectangle [x1,y1,x2,y2] (pixels) -> normalised box. */
export function fromViewportRect(r, vpW, vpH) {
  const x0 = Math.min(r[0], r[2]), x1 = Math.max(r[0], r[2]);
  const y0 = Math.min(r[1], r[3]), y1 = Math.max(r[1], r[3]);
  return { x: x0 / vpW, y: y0 / vpH, w: (x1 - x0) / vpW, h: (y1 - y0) / vpH };
}

export const MIN_READABLE = 10, MAX_READABLE = 12, MIN_SHRINK = 8;

/** Default font size (pt): readable 10–12 pt; letter boxes follow the box height. */
export function autoFontSize(hPt, cells = 0) {
  if (cells > 1) return Math.max(MIN_SHRINK, Math.min(MAX_READABLE, Math.round(hPt * 0.68 * 2) / 2));
  return Math.max(MIN_READABLE, Math.min(MAX_READABLE, Math.round(hPt * 0.72 * 2) / 2));
}

/** Lines a box can hold at `size` (1 for ordinary single-line boxes). */
export function lineCapacity(hPt, size) {
  return Math.max(1, Math.floor((hPt + size * 0.25) / (size * 1.25)));
}

/** Shrinks `size` until every line of `text` fits `maxW` (not below `min`). measure = (text, size) => width. */
export function fitFontSize(text, size, maxW, measure, min = MIN_SHRINK) {
  const lines = String(text).split('\n');
  let s = size;
  while (s > min && lines.some((l) => measure(l, s) > maxW)) s -= 0.5;
  return s;
}

/**
 * Spread address pieces over several separate lines (each with its own width), never splitting a piece.
 * Non-final lines end with a comma. Returns { lines, size, overflow }.
 */
export function distributeParts(parts, widths, size, measure, min = MIN_SHRINK) {
  let lastTry = null;
  for (let s = size; s >= min - 1e-9; s -= 0.5) {
    const lines = [];
    let i = 0;
    for (let l = 0; l < widths.length && i < parts.length; l++) {
      const last = l === widths.length - 1;
      let line = parts[i++];
      while (i < parts.length) {
        const next = `${line}, ${parts[i]}`;
        if (last || measure(next + ',', s) <= widths[l]) { line = next; i++; } else break;
      }
      lines.push(line);
    }
    const withCommas = lines.map((l, k) => (k < lines.length - 1 ? l + ',' : l));
    lastTry = { lines: withCommas, size: s, overflow: !withCommas.every((l, k) => measure(l, s) <= widths[k]) };
    if (!lastTry.overflow) return lastTry;
  }
  return lastTry || { lines: [parts.join(', ')], size: min, overflow: true };
}

/**
 * Layout for text written into a box, in box-local points (origin top-left of box, y down).
 * Returns [{text, x, baseline}]: one per character for letter boxes, one per line otherwise ("\n" = new line).
 */
export function layoutText({ text, wPt, hPt, size, cells, measure }) {
  // one grapheme cluster per box, so "कि" / "क्ष" stay together
  if (cells && cells > 1) {
    const cw = wPt / cells;
    const baseline = hPt / 2 + size * 0.35;
    return graphemes(text).slice(0, cells).map((ch, i) => ({
      text: ch, x: i * cw + (cw - measure(ch, size)) / 2, baseline
    }));
  }
  const lines = String(text).split('\n');
  const x = Math.min(2, wPt * 0.03);
  if (lines.length === 1) {
    return [{ text: lines[0], x, baseline: Math.min(hPt - 1.5, hPt / 2 + size * 0.35) }];
  }
  const lh = size * 1.25;
  const top = Math.max(0, (hPt - lines.length * lh) / 2);
  return lines.map((t, i) => ({ text: t, x, baseline: top + size * 0.95 + i * lh }));
}

/** Tick-mark polyline for a checkbox, in box-local fractions (0..1, y down). */
export const TICK = [[0.18, 0.55], [0.42, 0.8], [0.85, 0.2]];

/** Turns a resolved profile value into the text to write (dates formatted, upper-cased if asked). */
export function textForItem(val, item, C) {
  if (!val) return '';
  let t;
  if (val.kind === 'date') t = C.formatDate(val.value, item.dateFormat || C.detectDateFormat(item.label) || 'dd/mm/yyyy');
  else if (val.kind === 'bool') t = val.value ? 'Yes' : 'No';
  else t = String(val.value);
  if (item.cells > 1 && val.kind === 'date') t = t.replace(/[^0-9A-Za-z]/g, '');
  // Forms ask for CAPITAL letters, but e-mail addresses are written exactly as they are.
  if (item.upper && !/email/i.test(item.key || '') && !/@/.test(t)) t = t.toUpperCase();
  return t;
}

/**
 * Decide which checkbox items in a group should be ticked.
 * group: items sharing a key, each with .option (e.g. "Male"); value: resolved profile value.
 * Returns {tick: item|null, sure}
 */
export function chooseOption(group, val, C) {
  if (!val) return { tick: null, sure: false };
  if (group.length === 1 && val.kind === 'bool') return { tick: val.value ? group[0] : null, sure: true };
  const options = group.map((it) => ({ text: it.option || it.label || '' }));
  const v = val.kind === 'bool' ? (val.value ? 'yes' : 'no') : val.value;
  const m = C.matchOption(options, v, val.kind);
  if (m.index < 0) return { tick: null, sure: false };
  return { tick: group[m.index], sure: m.score >= 0.8 };
}

/**
 * Offline label finder for flat PDFs that have a text layer (not scans).
 * lines: [{text, x, y, w, h}] normalised. Returns candidate blanks: [{label, box}]
 */
export function blanksFromTextLayer(items, isKnown = null) {
  const out = [];
  const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
  for (const it of sorted) {
    const raw = it.text.trim();
    if (!raw || /^[_.\s-]+$/.test(raw)) continue;
    // drop list numbering like "12." / "(a)" / "iv)" so it isn't mistaken for "Class 12"
    const label = raw.replace(/[:_.\s-]+$/, '').replace(/^\(?(\d{1,2}|[a-h]|[ivx]{1,4})[.)]\s+/i, '').trim();
    if (label.length < 2 || label.length > 80) continue;
    const sameLine = sorted.filter((o) => o !== it && Math.abs((o.y + o.h / 2) - (it.y + it.h / 2)) < it.h * 0.6 && o.x > it.x + it.w - 0.002);
    const underline = sameLine.find((o) => /^[_.]{3,}$/.test(o.text.trim()));
    // "Sex: [] Male [] Female": several short words after the label = a tick-box row, not a blank
    // (the options start close to the label; far-away text such as a photo-box caption doesn't count)
    const labelEnd = it.x + it.w;
    const words = sameLine.filter((o) => !/^[_.\s]+$/.test(o.text) && o.text.trim().length <= 20 && o.x - labelEnd < 0.3);
    if (!underline && words.length >= 2 && words.some((o) => o.x - labelEnd < 0.2) && words.every((o) => !/:\s*$/.test(o.text))) continue;
    let x0, x1;
    if (underline) { x0 = underline.x; x1 = underline.x + underline.w; }
    else {
      const next = sameLine.filter((o) => !/^[_.\s]+$/.test(o.text)).sort((a, b) => a.x - b.x)[0];
      x0 = it.x + it.w + 0.008;
      x1 = next ? next.x - 0.01 : 0.95;
      // only text that looks like "Label:" / "Label ____", or a label we recognise ("Full Name" + printed line)
      if (!/[:_]\s*$/.test(raw) && !underline && !(isKnown && isKnown(label))) continue;
    }
    if (x1 - x0 < 0.06) continue;
    out.push({ label, box: { x: x0, y: it.y - it.h * 0.25, w: x1 - x0, h: it.h * 1.4 } });
  }
  return out;
}

/**
 * Horizontal printed lines (ruled blanks) from a pdf.js operator list, in page user space.
 * Tracks save/restore/transform; reads moveTo/lineTo segments and thin rectangles.
 * Returns [{x0, x1, y}] with x0 < x1, at least `minLen` long.
 */
export function horizontalRules(fnArray, argsArray, OPS, minLen = 25) {
  const mul = (m, n) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
  const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  const out = [];
  const seg = (a, b) => {
    if (Math.abs(a[1] - b[1]) < 0.8 && Math.abs(a[0] - b[0]) >= minLen) out.push({ x0: Math.min(a[0], b[0]), x1: Math.max(a[0], b[0]), y: (a[1] + b[1]) / 2 });
  };
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i], args = argsArray[i];
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
    else if (fn === OPS.transform) ctm = mul(ctm, args);
    else if (fn === OPS.constructPath) {
      const [ops, coords] = args;
      let k = 0, cur = null;
      for (const op of ops) {
        if (op === OPS.moveTo) { cur = apply(ctm, coords[k], coords[k + 1]); k += 2; }
        else if (op === OPS.lineTo) { const p = apply(ctm, coords[k], coords[k + 1]); k += 2; if (cur) seg(cur, p); cur = p; }
        else if (op === OPS.rectangle) {
          const [x, y, w, h] = coords.slice(k, k + 4); k += 4;
          const a = apply(ctm, x, y), b = apply(ctm, x + w, y), c = apply(ctm, x, y + h), d = apply(ctm, x + w, y + h);
          if (Math.abs(h) <= 1.5) seg(a, b); // a thin filled bar drawn as a line
          else { seg(a, b); seg(c, d); }      // box: its bottom and top edges
        } else if (op === OPS.curveTo) k += 6;
        else if (op === OPS.curveTo2 || op === OPS.curveTo3) k += 4;
      }
    }
  }
  return out;
}
