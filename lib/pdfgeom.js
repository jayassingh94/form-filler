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

// ---------------- free space on the page ----------------
// Text items are normalised boxes {text, x, y, w, h} (top-left origin, 0..1).

const GAP = 0.006; // breathing room next to printed text

/** True if box overlaps any printed text (with a small tolerance). */
export function overlapsText(box, items, pad = 0.0015) {
  return items.some((t) => box.x < t.x + t.w - pad && box.x + box.w > t.x + pad && box.y < t.y + t.h - pad && box.y + box.h > t.y + pad);
}

/** Group text items into printed lines (same baseline), each sorted left to right. */
export function groupLines(items) {
  const sorted = items.filter((t) => t.text.trim()).sort((a, b) => (a.y + a.h) - (b.y + b.h) || a.x - b.x);
  const lines = [];
  for (const t of sorted) {
    const base = t.y + t.h;
    const line = lines.find((l) => Math.abs(l.base - base) < Math.min(l.h, t.h) * 0.45);
    if (line) { line.items.push(t); line.h = Math.max(line.h, t.h); line.top = Math.min(line.top, t.y); }
    else lines.push({ base, h: t.h, top: t.y, items: [t] });
  }
  for (const l of lines) {
    l.items.sort((a, b) => a.x - b.x);
    l.x0 = l.items[0].x;
    l.x1 = Math.max(...l.items.map((t) => t.x + t.w));
  }
  return lines.sort((a, b) => a.base - b.base);
}

/** Right edge of the page's printed content (where values may extend to). */
export function contentRight(items) {
  const r = Math.max(0, ...items.map((t) => t.x + t.w));
  return Math.min(0.95, Math.max(r, 0.85));
}

const stripNumbering = (s) => s.replace(/^\s*\(?(\d{1,2}|[a-h]|[ivx]{1,4})[.)]\s+/i, '');

/**
 * Split text pieces into label text, colon-ended pieces and underline runs ("______", "......"),
 * estimating each part's x position from its share of the piece's characters.
 */
const RUN_RE = /_{3,}|\.{4,}|…{2,}/g;
export function explodeText(items) {
  const out = [];
  for (const t of items) {
    const s = String(t.text);
    const len = s.length || 1;
    const cw = t.w / len;
    const push = (from, to, run) => {
      const part = s.slice(from, to);
      if (!run && !part.trim()) return;
      out.push({ ...t, text: part, x: t.x + from * cw, w: (to - from) * cw, run });
    };
    let last = 0, m;
    RUN_RE.lastIndex = 0;
    const textPart = (from, to) => { // split further after each colon: "6. Sex : Male :" -> "6. Sex :", " Male :"
      let a = from;
      for (let i = from; i < to; i++) if (s[i] === ':') { push(a, i + 1, false); a = i + 1; }
      push(a, to, false);
    };
    while ((m = RUN_RE.exec(s))) {
      if (m.index > last) textPart(last, m.index);
      push(m.index, m.index + m[0].length, true);
      last = m.index + m[0].length;
    }
    if (last < s.length) textPart(last, s.length);
  }
  return out;
}

/** Printed text without its underline runs: what values must not cover (underscores are where you write). */
export function inkItems(items) {
  return explodeText(items).filter((t) => !t.run && String(t.text).trim());
}

/** Underline runs printed as text ("______"), as {x0, x1, y} (y = the line's baseline). */
export function underlineRuns(items) {
  return explodeText(items).filter((t) => t.run).map((t) => ({ x0: t.x, x1: t.x + t.w, y: t.y + t.h * 0.87 }));
}

const cleanLabel = (s) => stripNumbering(s.replace(/\s+/g, ' ').replace(/^[\s:.\-–]+/, '').trim()).replace(/[\s:_.\-–]+$/, '').trim();
const OPTION_WORD = /^(male|female|transgender|other|others|yes|no|married|unmarried|single|widow(ed|er)?|divorced|general|gen|ur|sc|st|obc|ews|ph|pwd|exsm|hindu|muslim|christian|sikh|m|f)$/i;

/**
 * Offline label finder for flat PDFs that have a text layer.
 * Rebuilds each printed line from its pieces and returns blanks:
 *   { label, box, alt, colon, underline, kind: 'text' | 'check', option }
 * - an underline run ("______") is a blank exactly on that line; its label is the text before it on the line
 *   (empty label = continuation line, e.g. the 2nd line of an address);
 * - "Label :" followed by empty space is a blank from after the colon to the next printed text / right margin;
 * - "Sex : Male : Female :" gives tick boxes after each option;
 * - a recognised label without colon or underline ("Full Name") gets the space after it.
 * Boxes never overlap printed text.
 */
export function blanksFromTextLayer(items, isKnown = null) {
  const tokens = explodeText(items.filter((t) => String(t.text).trim()));
  const ink = tokens.filter((t) => !t.run && t.text.trim()); // printed text that values must not cover
  const lines = groupLines(tokens);
  const right = contentRight(items);
  const out = [];
  const tails = []; // per line: text left at its end (a label for underlines on the next line)
  lines.forEach((line, li) => {
    const toks = line.items;
    const lh = line.h;
    let labelToks = [];
    let tail = null;
    let lastRun = null; // index in `out` of this line's previous underline (to merge "____ ____")
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (t.run) {
        let label = cleanLabel(labelToks.map((x) => x.text).join(' '));
        // a sentence ("…photograph of Shri ____", "S/o.____ and resident of", "post of ____ is"), not "Label : ____"
        let sentence = !!label && !labelToks.some((x) => x.colon);
        labelToks = [];
        // "____ ____" (two underlines with only spaces between): one blank, one value
        if (!label && lastRun != null) {
          const b = out[lastRun].box;
          b.w = t.x + t.w - b.x;
          continue;
        }
        // an underline starting a line with no label of its own takes the label that ended the line above
        // ("PERMANENT ADDRESS :" / "and resident of (R/O)" followed by lines to write on)
        const prev = tails[li - 1];
        if (!label && i === 0 && prev && line.top - lines[li - 1].base < lh * 2.6) {
          label = prev.label;
          sentence = !prev.colon;
          if (prev.outIndex != null) out[prev.outIndex].drop = true; // the heading's own "after the colon" spot
          tails[li - 1] = null;
        }
        if (/^\d+[.)]?$/.test(label)) continue;
        // writing area: on the underline, a little more than one text line high
        const box = { x: t.x, y: line.base - lh * 1.02, w: t.w, h: lh * 1.12 };
        out.push({ label, box, alt: null, colon: true, underline: true, kind: 'text', sentence });
        lastRun = out.length - 1;
        tail = null;
        continue;
      }
      if (t.text.trim()) lastRun = null;
      const raw = t.text.trim();
      if (!/:\s*$/.test(raw)) { labelToks.push(t); continue; }
      // a colon: the label is everything since the last blank
      labelToks.push(t);
      const label = cleanLabel(labelToks.map((x) => x.text).join(' '));
      labelToks = [];
      const next = toks[i + 1];
      if (next?.run) { labelToks.push({ ...t, text: label, colon: true }); continue; } // "Label : ____": the run makes the blank
      if (label.length < 2 || label.length > 120 || /^\d+[.)]?$/.test(label)) continue;
      // "Sex : Male : Female :" -> tick boxes after each option word
      const opts = [];
      for (let j = i + 1; j < toks.length && !toks[j].run && /:\s*$/.test(toks[j].text.trim()); j++) {
        const word = cleanLabel(toks[j].text);
        if (!OPTION_WORD.test(word)) break;
        opts.push(toks[j]);
      }
      if (opts.length >= 2) {
        for (const o of opts) {
          const sz = lh * 0.95;
          out.push({ label, option: cleanLabel(o.text), kind: 'check', colon: true, underline: false, alt: null,
            box: { x: o.x + o.w + GAP, y: line.base - sz * 0.85, w: sz, h: sz } });
        }
        i += opts.length;
        continue;
      }
      // "Sex: [] Male [] Female": short words right after the label = a tick-box row, not a blank
      const rest = toks.slice(i + 1).filter((x) => !x.run);
      const labelEnd = t.x + t.w;
      const near = rest.filter((x) => x.text.trim().length <= 20 && x.x - labelEnd < 0.3);
      if (near.length >= 2 && near.some((x) => x.x - labelEnd < 0.2) && near.every((x) => !/:\s*$/.test(x.text))) { i = toks.length; continue; }
      const idx = pushAfter(label, t, i, true);
      tail = { label, outIndex: idx, colon: true };
    }
    // a recognised label without colon or underline ("Full Name" then a drawn line or empty space)
    if (labelToks.length) {
      const label = cleanLabel(labelToks.map((x) => x.text).join(' '));
      const lastTok = labelToks[labelToks.length - 1];
      tail = { label, outIndex: null, colon: false };
      if (label.length >= 2 && label.length <= 120 && !/[\/,&]\s*$/.test(lastTok.text.trim()) && !/^\(.*\)$/.test(label) && isKnown && isKnown(label)) {
        tail.outIndex = pushAfter(label, lastTok, toks.indexOf(lastTok), false);
      }
    }
    tails[li] = tail;

    function pushAfter(label, t, i, colon) {
      const startX = t.x + t.w + GAP;
      const next = toks.slice(i + 1).find((x) => x.x > startX);
      const endX = next ? next.x - GAP : right;
      const box = { x: startX, y: line.top - lh * 0.12, w: Math.max(0, endX - startX), h: lh * 1.3 };
      // free band under the label (until the next printed line that reaches into this column)
      const x0 = stripLabelStart(line);
      const below = lines.slice(li + 1).find((l) => l.items.some((x) => x.x < right && x.x + x.w > x0));
      const bandTop = line.base + lh * 0.25;
      const bandBottom = below ? below.top - GAP : Math.min(1, bandTop + lh * 4);
      let alt = null;
      if (bandBottom - bandTop >= lh * 1.15) {
        alt = { x: x0, y: bandTop, w: right - x0, h: Math.min(bandBottom - bandTop, lh * 4.5) };
        if (overlapsText(alt, ink)) alt = null;
      }
      const ok = box.w >= 0.04 && !overlapsText(box, ink);
      if (!ok && !alt) return null;
      out.push({ label, colon, underline: false, kind: 'text', box: ok ? box : alt, alt: ok ? alt : null });
      return out.length - 1;
    }
  });

  // A numbered heading (over one or more lines) followed by a big empty space is a writing area under it:
  // "8. Academic Qualifications indicating subject, year of passing…" / "9. Work Experience in chronological order…"
  const NUM = /^\(?(\d{1,2}|[a-h])[.)]/i;
  for (let li = 0; li < lines.length; li++) {
    const L = lines[li];
    const toks = L.items.filter((x) => x.run || x.text.trim());
    if (!toks.length || toks.some((x) => x.run) || !NUM.test(toks[0].text.trim())) continue;
    if (/:\s*$/.test(toks[toks.length - 1].text.trim())) continue; // "Label :" is handled above
    let last = li;
    const parts = [toks.map((x) => x.text).join(' ')];
    while (last + 1 < lines.length) {
      const nx = lines[last + 1];
      const nt = nx.items.filter((x) => x.text.trim());
      if (!nt.length || nx.items.some((x) => x.run) || NUM.test(nt[0].text.trim())) break;
      if (nx.top - lines[last].base > lines[last].h * 1.2) break;
      parts.push(nt.map((x) => x.text).join(' '));
      last++;
    }
    const below = lines[last + 1];
    if (!below) continue; // nothing under it on this page: not a writing area we can bound
    const lh = L.h;
    const top = lines[last].base + lh * 0.6, bottom = below.top - lh * 0.5;
    if (bottom - top < lh * 3) continue;
    const x0 = /^\(?(\d{1,2}|[a-h])[.)]$/i.test(toks[0].text.trim()) && toks[1] ? toks[1].x : toks[0].x;
    const box = { x: x0, y: top, w: right - x0, h: bottom - top };
    if (box.w < 0.2 || overlapsText(box, ink)) continue;
    for (let k = li; k <= last; k++) if (tails[k]?.outIndex != null) out[tails[k].outIndex].drop = true;
    const label = cleanLabel(parts.join(' ').replace(NUM, ''));
    out.push({ label, box, alt: null, colon: false, underline: false, kind: 'text', area: true });
    li = last;
  }
  return out.filter((b) => b.box && !b.drop);
}

/**
 * Snap a box onto the printed line it belongs to: the nearest line (from `lines` = [{x0, x1, y}]) that
 * overlaps it horizontally and lies within about one box height of its bottom. Returns the box unchanged if
 * there is none.
 */
export function snapToLine(box, lines) {
  const bottom = box.y + box.h;
  const cands = lines.filter((l) => l.x1 > box.x + box.w * 0.2 && l.x0 < box.x + box.w * 0.8 && Math.abs(l.y - bottom) < Math.max(box.h * 1.1, 0.012));
  if (!cands.length) return box;
  const l = cands.sort((a, b) => Math.abs(a.y - bottom) - Math.abs(b.y - bottom))[0];
  const x0 = Math.max(l.x0, Math.min(box.x, l.x1 - 0.05)), x1 = l.x1;
  const h = Math.min(Math.max(box.h, 0.014), 0.03);
  return { x: x0, y: l.y - h * 0.92, w: x1 - x0, h };
}

/** Where the label text starts on a line (after "1." numbering). */
function stripLabelStart(line) {
  const first = line.items[0];
  if (/^\(?(\d{1,2}|[a-h]|[ivx]{1,4})[.)]$/i.test(first.text.trim()) && line.items[1]) return line.items[1].x;
  return first.x;
}

/**
 * Move a box (e.g. from AI) off printed text: keep its row, use the widest free stretch to the right of the
 * text it covers; if there is none, use the free band under that row; else null.
 */
export function repairBox(box, items, right = contentRight(items)) {
  if (!overlapsText(box, items)) return box;
  const cy = box.y + box.h / 2;
  const row = items.filter((t) => t.y < cy + box.h * 0.6 && t.y + t.h > cy - box.h * 0.6).sort((a, b) => a.x - b.x);
  const covered = row.filter((t) => t.x < box.x + box.w && t.x + t.w > box.x);
  const after = covered.length ? Math.max(...covered.map((t) => t.x + t.w)) + GAP : box.x;
  const next = row.find((t) => t.x > after);
  const end = next ? next.x - GAP : right;
  const lh = row.length ? Math.max(...row.map((t) => t.h)) : box.h;
  const top = row.length ? Math.min(...row.map((t) => t.y)) : box.y;
  if (end - after >= 0.06) {
    const fixed = { x: after, y: top - lh * 0.12, w: end - after, h: lh * 1.3 };
    if (!overlapsText(fixed, items)) return fixed;
  }
  const bottom = row.length ? Math.max(...row.map((t) => t.y + t.h)) : box.y + box.h;
  const under = { x: covered[0]?.x ?? box.x, y: bottom + lh * 0.25, w: right - (covered[0]?.x ?? box.x), h: lh * 1.3 };
  return overlapsText(under, items) ? null : under;
}

/** Shorter address versions to try when space is tight (drops landmark, locality, PO/PS/tehsil, district). */
export function addressVariants(parts) {
  const drop = [/^Near /, /^(PO|PS) /, /^Dist\. /];
  const v = [parts];
  let cur = parts;
  for (const re of drop) {
    const next = cur.filter((p) => !re.test(p));
    if (next.length < cur.length) { v.push(next); cur = next; }
  }
  // finally: street, city, state - PIN only
  if (cur.length > 3) v.push([cur[0], ...cur.slice(-2)]);
  return v;
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
  const vert = []; // thin vertical bars (sides of boxes drawn from bars)
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
        else if (op === OPS.lineTo) {
          const p = apply(ctm, coords[k], coords[k + 1]); k += 2;
          if (cur) { seg(cur, p); if (Math.abs(cur[0] - p[0]) < 0.8 && Math.abs(cur[1] - p[1]) > 4) vert.push({ x: p[0], y0: Math.min(cur[1], p[1]), y1: Math.max(cur[1], p[1]) }); }
          cur = p;
        }
        else if (op === OPS.rectangle) {
          const [x, y, w, h] = coords.slice(k, k + 4); k += 4;
          const a = apply(ctm, x, y), b = apply(ctm, x + w, y), c = apply(ctm, x, y + h);
          if (Math.abs(h) <= 1.5) seg(a, b);                       // a thin bar: may be a line
          else if (Math.abs(w) <= 1.5) vert.push({ x: (a[0] + b[0]) / 2, y0: Math.min(a[1], c[1]), y1: Math.max(a[1], c[1]) });
          // bigger rectangles are boxes / table cells, not lines to write on
        } else if (op === OPS.curveTo) k += 6;
        else if (op === OPS.curveTo2 || op === OPS.curveTo3) k += 4;
      }
    }
  }
  // a horizontal bar with vertical sides at both ends is the edge of a box (e.g. a photo box), not a line
  const touches = (x, y) => vert.some((v) => Math.abs(v.x - x) < 2.5 && y >= v.y0 - 2.5 && y <= v.y1 + 2.5);
  return out.filter((r) => !(touches(r.x0, r.y) && touches(r.x1, r.y)));
}

/**
 * Snap a box onto the printed line that belongs to its label: find the label's text on the page (nearest
 * match to the box), then the line on that row to the right of the label. Falls back to the nearest line
 * (snapToLine) when the label can't be found. `norm` normalises text for comparison.
 */
export function snapByLabel(box, label, ink, lines, norm) {
  const want = norm(label);
  if (want.length >= 3) {
    const rows = groupLines(ink).filter((l) => norm(l.items.map((t) => t.text).join(' ')).includes(want));
    const row = rows.sort((a, b) => Math.abs(a.base - (box.y + box.h)) - Math.abs(b.base - (box.y + box.h)))[0];
    if (row && Math.abs(row.base - (box.y + box.h)) < 0.06) {
      // where the label ends on that row (the words of the label, not later text on the same row)
      let end = row.x0, acc = '';
      for (const t of row.items) { acc = norm(`${acc} ${t.text}`); end = t.x + t.w; if (acc.includes(want)) break; }
      const onRow = lines.filter((l) => Math.abs(l.y - row.base) < row.h * 0.6 && l.x1 > end);
      if (onRow.length) {
        const l = onRow.sort((a, b) => Math.abs(a.x0 - box.x) - Math.abs(b.x0 - box.x))[0];
        const x0 = Math.max(l.x0, end + 0.004);
        const h = Math.min(Math.max(box.h, 0.014), 0.03);
        return { x: x0, y: l.y - h * 0.92, w: l.x1 - x0, h };
      }
    }
  }
  return snapToLine(box, lines);
}
