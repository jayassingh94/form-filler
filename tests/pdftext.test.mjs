import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import '../vendor/regenerator-runtime/runtime.js';
import { PDFDocument, StandardFonts, rgb, degrees, drawSvgPath, pushGraphicsState, popGraphicsState } from '../vendor/pdf-lib/pdf-lib.esm.min.js';
import { createTextWriter, graphemes, hasDevanagari, DEVA_FONT_PATH } from '../lib/pdftext.js';

const require = createRequire(import.meta.url);
const fontkit = require('../vendor/fontkit/fontkit.umd.min.js');
const fontBytes = new Uint8Array(fs.readFileSync(new URL('../' + DEVA_FONT_PATH, import.meta.url)));
const lib = { StandardFonts, rgb, degrees, drawSvgPath, pushGraphicsState, popGraphicsState };

test('grapheme clusters keep Devanagari syllables together', () => {
  assert.deepEqual(graphemes('कि'), ['कि']);
  assert.deepEqual(graphemes('हिन्दी'), ['हि', 'न्दी']);
  assert.deepEqual(graphemes('AB'), ['A', 'B']);
  assert.ok(hasDevanagari('नाम: Asha') && !hasDevanagari('Asha'));
});

test('mixed text is split into Hindi and Latin runs', async () => {
  const doc = await PDFDocument.create();
  const w = await createTextWriter(doc, lib, fontkit, fontBytes);
  assert.deepEqual(w.runs('आशा वर्मा (Asha) 12'), [
    { script: 'deva', text: 'आशा वर्मा ' },
    { script: 'latin', text: '(Asha) 12' }
  ]);
  assert.deepEqual(w.runs('Asha'), [{ script: 'latin', text: 'Asha' }]);
  assert.ok(w.canWrite('श्री रामेश्वर प्रसाद'));
  assert.ok(!w.canWrite('名前'), 'other scripts are reported, not silently dropped');
  assert.throws(() => w.runs('a名'), (e) => e.unsupported === '名');
  const hi = w.widthOf('आशा कुमारी वर्मा', 12);
  assert.ok(hi > 40 && hi < 140, `plausible width ${hi}`);
  // shaped width differs from summing single characters (conjuncts/matras)
  const naive = [...'क्ष'].reduce((s, c) => s + w.widthOf(c, 12), 0);
  assert.ok(w.widthOf('क्ष', 12) < naive);
});

test('Hindi is drawn into a page and in a form-field appearance', async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 200]);
  const w = await createTextWriter(doc, lib, fontkit, fontBytes);
  w.draw(page, 'नाम: आशा (Asha)', { x: 20, y: 150, size: 14, color: rgb(0, 0, 0) });
  w.draw(page, 'कुमारी', { x: 20, y: 100, size: 14, angle: 90, color: rgb(0, 0, 0) });
  const tf = doc.getForm().createTextField('hi');
  tf.addToPage(page, { x: 20, y: 20, width: 200, height: 20 });
  tf.setText('आशा कुमारी');
  tf.updateAppearances(w.latin, () => ({ normal: w.outlineOps('आशा कुमारी', { x: 2, y: 6, size: 12, color: rgb(0, 0, 0) }) }));
  assert.throws(() => w.outlineOps('आशा Asha', { x: 0, y: 0, size: 12 }), (e) => e.mixed);
  const bytes = await doc.save();
  const again = await PDFDocument.load(bytes);
  assert.equal(again.getForm().getTextField('hi').getText(), 'आशा कुमारी', 'field keeps the Unicode value');
});
