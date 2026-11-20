import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as G from '../lib/pdfgeom.js';
import { detectFlatPage } from '../lib/ai.js';
import { newProfile, keyCatalog, resolveValue } from '../lib/schema.js';
const C = createRequire(import.meta.url)('../content/fillcore.js');

test('box conversions', () => {
  const near = (a, b) => Object.keys(b).forEach((k) => assert.ok(Math.abs(a[k] - b[k]) < 1e-9, `${k}: ${a[k]} vs ${b[k]}`));
  near(G.fromBox2d([100, 200, 150, 700]), { x: 0.2, y: 0.1, w: 0.5, h: 0.05 });
  assert.equal(G.fromBox2d([100, 200, 100, 700]), null, 'zero height rejected');
  assert.equal(G.fromBox2d([1, 2, 3]), null);
  const b = G.fromBox2d([150, 700, 100, 200]); // swapped corners are fixed
  assert.ok(Math.abs(b.x - 0.2) < 1e-9 && Math.abs(b.w - 0.5) < 1e-9);
  near(G.fromViewportRect([60, 400, 260, 380], 600, 800), { x: 0.1, y: 0.475, w: 1 / 3, h: 0.025 });
});

test('text layout: single line and character boxes', () => {
  const measure = (t, s) => t.length * s * 0.5;
  const one = G.layoutText({ text: 'ASHA', wPt: 200, hPt: 14, size: 9, measure });
  assert.equal(one.length, 1);
  assert.ok(one[0].baseline > 7 && one[0].baseline < 14);
  const cells = G.layoutText({ text: 'ASHA', wPt: 280, hPt: 16, size: 10, cells: 20, measure });
  assert.equal(cells.length, 4);
  assert.equal(cells[1].x - cells[0].x, 14, 'one character per 14pt box');
  assert.equal(G.fitFontSize('a very long piece of text', 12, 50, measure) < 12, true);
  assert.equal(G.autoFontSize(14), 8.5);
  assert.equal(G.autoFontSize(40), 12);
});

test('values for PDF boxes and tick groups', () => {
  const p = newProfile('Me');
  Object.assign(p.personal, { firstName: 'Asha', lastName: 'Verma', dob: '1996-03-07', gender: 'Female' });
  p.category.category = 'OBC';
  const dob = resolveValue(p, 'personal.dob');
  assert.equal(G.textForItem(dob, { label: 'Date of Birth (DD/MM/YYYY)' }, C), '07/03/1996');
  assert.equal(G.textForItem(dob, { label: 'DOB', cells: 8 }, C), '07031996');
  assert.equal(G.textForItem(resolveValue(p, 'personal.fullName'), { upper: true }, C), 'ASHA VERMA');
  assert.equal(G.textForItem({ value: 'a.b@x.com', kind: 'text' }, { upper: true, key: 'contact.email' }, C), 'a.b@x.com');
  const sex = ['Male', 'Female', 'Transgender'].map((o) => ({ option: o }));
  assert.equal(G.chooseOption(sex, resolveValue(p, 'personal.gender'), C).tick, sex[1]);
  const cat = ['GEN', 'OBC', 'SC', 'ST', 'EWS'].map((o) => ({ option: o }));
  assert.equal(G.chooseOption(cat, resolveValue(p, 'category.category'), C).tick, cat[1]);
  assert.equal(G.chooseOption(cat, null, C).tick, null);
});

test('offline blank finder uses "Label:" text and skips tight gaps', () => {
  const items = [
    { text: "Father's Name:", x: 0.07, y: 0.15, w: 0.15, h: 0.014 },
    { text: 'Sex:', x: 0.07, y: 0.24, w: 0.04, h: 0.014 },
    { text: 'Male', x: 0.15, y: 0.24, w: 0.05, h: 0.014 },
    { text: 'Female', x: 0.25, y: 0.24, w: 0.06, h: 0.014 },
    { text: '12. Educational Qualification:', x: 0.07, y: 0.5, w: 0.3, h: 0.014 },
    { text: "Mother's Name:", x: 0.07, y: 0.18, w: 0.15, h: 0.014 },
    { text: 'passport size', x: 0.82, y: 0.178, w: 0.1, h: 0.014 },
    { text: 'photograph', x: 0.82, y: 0.183, w: 0.1, h: 0.014 }
  ];
  const b = G.blanksFromTextLayer(items);
  const labels = b.map((x) => x.label);
  assert.deepEqual(labels, ["Father's Name", "Mother's Name", 'Educational Qualification'], 'Sex row skipped; photo caption is not an option row; numbering removed');
  assert.ok(b[1].box.x + b[1].box.w < 0.82, "Mother's Name box stops before the photo caption");
  assert.ok(b[0].box.x > 0.22 && b[0].box.w > 0.5);
});

test('flat-page Gemini request has the image and key names but no profile values', async () => {
  const p = newProfile('Me');
  Object.assign(p.personal, { firstName: 'Asha', aadhaar: '999988887777' });
  let body;
  globalThis.fetch = async (_url, init) => {
    body = init.body;
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ items: [
      { label: 'Name', kind: 'text', box_2d: [100, 280, 120, 760], cells: 20, key: 'personal.fullName', confidence: 'high' },
      { label: 'Sex', kind: 'checkbox', option: 'Male', box_2d: [240, 250, 252, 268], key: 'made.up', confidence: 'high' }
    ] }) }] } }] }), { status: 200 });
  };
  const out = await detectFlatPage('K', 'gemini-3.5-flash-lite', 'SU1BR0U=', 'image/jpeg', keyCatalog(p));
  assert.ok(!body.includes('Asha') && !body.includes('999988887777'));
  assert.ok(body.includes('"inlineData"') && body.includes('SU1BR0U='));
  assert.ok(body.includes('personal.fullName'));
  assert.equal(out[0].key, 'personal.fullName');
  assert.equal(out[1].key, null, 'unknown keys dropped');
});
