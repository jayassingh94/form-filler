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

/** Default font size (pt) for a box `hPt` points tall. */
export function autoFontSize(hPt) {
  return Math.max(6, Math.min(12, Math.round(hPt * 0.62 * 2) / 2));
}

/**
 * Shrinks `size` until measure(text, size) fits `maxW` (min 5pt). measure = (text, size) => width.
 */
export function fitFontSize(text, size, maxW, measure) {
  let s = size;
  while (s > 5 && measure(text, s) > maxW) s -= 0.5;
  return s;
}

/**
 * Layout for text written into a box, in box-local points (origin top-left of box, y down).
 * Returns [{ch|text, x, baseline}]: one entry per character for character boxes, or one for the line.
 */
export function layoutText({ text, wPt, hPt, size, cells, measure }) {
  const baseline = hPt / 2 + size * 0.35; // optical vertical centring for Latin caps/lowercase
  if (cells && cells > 1) {
    const cw = wPt / cells;
    // one grapheme cluster per box, so "कि" / "क्ष" stay together
    return graphemes(text).slice(0, cells).map((ch, i) => ({
      text: ch, x: i * cw + (cw - measure(ch, size)) / 2, baseline
    }));
  }
  return [{ text: String(text), x: Math.min(2, wPt * 0.03), baseline }];
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
export function blanksFromTextLayer(items) {
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
      if (!/[:_]\s*$/.test(raw) && !underline) continue; // only text that looks like "Label:" or "Label ____"
    }
    if (x1 - x0 < 0.06) continue;
    out.push({ label, box: { x: x0, y: it.y - it.h * 0.25, w: x1 - x0, h: it.h * 1.4 } });
  }
  return out;
}
