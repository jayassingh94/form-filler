// Writes text onto PDF pages with script fallback:
//  - Latin text (anything Helvetica can encode) is written as normal PDF text (Helvetica).
//  - Devanagari (Hindi, Marathi, Nepali, Sanskrit…) is shaped with fontkit (conjuncts, ि reordering, reph,
//    mark positioning) using the bundled Noto Sans Devanagari and drawn as vector glyph outlines at the
//    exact shaped positions. (pdf-lib's own custom-font text ignores GPOS mark offsets, which misplaces
//    vowel signs like ु, so outlines are used instead.)
// No DOM access; works in extension pages and in Node (for tests).

export const DEVA_FONT_PATH = 'vendor/fonts/NotoSansDevanagari-Regular.ttf';

const DEVA_RE = /[ऀ-ॿ꣠-ꣿ᳐-᳿]/;
const JOINER_RE = /[‌‍]/;

export function hasDevanagari(text) {
  return DEVA_RE.test(String(text || ''));
}

/** Split text into grapheme clusters (so "कि" or "क्ष" stays together in a letter box). */
export function graphemes(text) {
  const s = String(text || '');
  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    return [...new Intl.Segmenter('hi', { granularity: 'grapheme' }).segment(s)].map((g) => g.segment);
  }
  return [...s];
}

/**
 * @param doc       pdf-lib PDFDocument
 * @param lib       { StandardFonts, rgb, degrees } from pdf-lib
 * @param fontkit   the fontkit module (UMD global in the browser)
 * @param devaBytes Uint8Array of the Devanagari TTF
 */
export async function createTextWriter(doc, lib, fontkit, devaBytes) {
  const latin = await doc.embedFont(lib.StandardFonts.Helvetica);
  const deva = fontkit.create(devaBytes);
  const upm = deva.unitsPerEm;
  const pathCache = new Map();

  const latinOk = (ch) => { try { latin.encodeText(ch); return true; } catch { return false; } };
  const devaOk = (ch) => deva.hasGlyphForCodePoint(ch.codePointAt(0));

  /** [{script:'latin'|'deva', text}] or throws {unsupported: '…'} */
  function runs(text) {
    const out = [];
    const bad = new Set();
    let cur = null;
    for (const ch of String(text)) {
      let script;
      if (DEVA_RE.test(ch) || JOINER_RE.test(ch)) script = 'deva';
      else if (/\s/.test(ch) && cur) script = cur.script; // spaces stay in the current run
      else if (latinOk(ch)) script = 'latin';
      else if (devaOk(ch)) script = 'deva';
      else { bad.add(ch); continue; }
      if (script === 'deva' && !devaOk(ch) && !JOINER_RE.test(ch)) { bad.add(ch); continue; }
      if (!cur || cur.script !== script) out.push(cur = { script, text: '' });
      cur.text += ch;
    }
    if (bad.size) {
      const err = new Error(`Unsupported characters: ${[...bad].join(' ')}`);
      err.unsupported = [...bad].join('');
      throw err;
    }
    return out;
  }

  function runWidth(r, size) {
    if (r.script === 'latin') return latin.widthOfTextAtSize(r.text, size);
    return (deva.layout(r.text).advanceWidth * size) / upm;
  }

  /** Width of mixed text in points; throws for unsupported characters. */
  function widthOf(text, size) {
    return runs(text).reduce((w, r) => w + runWidth(r, size), 0);
  }

  function canWrite(text) {
    try { runs(text); return true; } catch { return false; }
  }

  function glyphSvg(glyph) {
    if (!pathCache.has(glyph.id)) pathCache.set(glyph.id, glyph.path.scale(1, -1).toSVG());
    return pathCache.get(glyph.id);
  }

  /**
   * Draw text with its baseline starting at PDF point (x, y), rotated `angle` degrees (counter-clockwise).
   */
  function draw(page, text, { x, y, size, angle = 0, color }) {
    const rad = (angle * Math.PI) / 180, cos = Math.cos(rad), sin = Math.sin(rad);
    const at = (lx, ly) => ({ x: x + lx * cos - ly * sin, y: y + lx * sin + ly * cos });
    let pen = 0;
    for (const r of runs(text)) {
      if (r.script === 'latin') {
        const p = at(pen, 0);
        page.drawText(r.text, { x: p.x, y: p.y, size, font: latin, color, rotate: lib.degrees(angle) });
        pen += latin.widthOfTextAtSize(r.text, size);
        continue;
      }
      const k = size / upm;
      const shaped = deva.layout(r.text);
      let gx = 0;
      shaped.glyphs.forEach((g, i) => {
        const pos = shaped.positions[i];
        const svg = g.path.commands.length ? glyphSvg(g) : null;
        if (svg) {
          const p = at(pen + (gx + pos.xOffset) * k, pos.yOffset * k);
          page.drawSvgPath(svg, { x: p.x, y: p.y, scale: k, rotate: lib.degrees(angle), color, borderWidth: 0 });
        }
        gx += pos.xAdvance;
      });
      pen += gx * k;
    }
  }

  /**
   * Appearance-stream operators for a form field showing Devanagari text (digits/spaces allowed, no Latin
   * letters, because a field appearance here uses outlines only). Box-local coords, baseline at (x, y).
   */
  function outlineOps(text, { x, y, size, color }) {
    const rs = runs(text);
    if (rs.some((r) => r.script === 'latin' && /\S/.test(r.text))) {
      const err = new Error('Mixed Hindi and English text cannot go in one PDF form field');
      err.mixed = true;
      throw err;
    }
    const k = size / upm;
    const shaped = deva.layout(rs.map((r) => r.text).join(''));
    const ops = [lib.pushGraphicsState()];
    let gx = 0;
    shaped.glyphs.forEach((g, i) => {
      const pos = shaped.positions[i];
      if (g.path.commands.length) {
        ops.push(...lib.drawSvgPath(glyphSvg(g), {
          x: x + (gx + pos.xOffset) * k, y: y + pos.yOffset * k, scale: k, color, borderWidth: 0
        }));
      }
      gx += pos.xAdvance;
    });
    ops.push(lib.popGraphicsState());
    return ops;
  }

  return { latin, deva, runs, widthOf, canWrite, draw, outlineOps };
}
