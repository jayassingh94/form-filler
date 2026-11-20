// Regression: the identity-certificate application form (test/sample-identity-certificate.pdf).
// Text pieces below are exactly as pdf.js reports them for that file (x, baseline from top, width; pt).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as G from '../lib/pdfgeom.js';
const C = createRequire(import.meta.url)('../content/fillcore.js');

const W = 612, H = 792, FS = 10.5;
const mk = (rows) => rows.map(([x, base, w, text]) => ({ text, x: x / W, y: (base - FS) / H, w: w / W, h: (FS * 1.15) / H }));
const page1 = mk([
  [106, 83, 250, 'Post Applied for :____________________'],
  [437, 87, 95, 'Affix recent passport'], [448, 100, 72, 'size photograph'],
  [106, 246, 53, '1. Full Name'], [275, 246, 246, ': ______________________________________________'],
  [106, 267, 72, '2. Father’s Name'], [275, 267, 243, ':______________________________________________'],
  [106, 289, 94, '3. Permanent Address'], [275, 289, 246, ': ______________________________________________'],
  [281, 338, 241, '______________________________________________'],
  [281, 370, 241, '______________________________________________'],
  [106, 489, 154, '5. Date of Birth : ________________'], [275, 489, 63, '6. Sex : Male :'], [411, 489, 37, 'Female :'],
  [106, 533, 151, '9. Domicile : __________________'], [117, 543, 28, '(State)']
]);
const page3 = mk([
  [106, 219, 445, 'This is to certify that the details and photograph of Shri _________________________'],
  [106, 239, 445, 'S/o._________________________________________________ and resident of (R/O)'],
  [106, 258, 427, '____________________________________________________________________'],
  [106, 330, 137, 'PERMANENT ADDRESS :'],
  [140, 343, 364, '__________________________________________________________'],
  [140, 369, 364, '__________________________________________________________'],
  [106, 537, 170, 'Signature of the Certifying Officer:'], [309, 537, 188, '______________________________'],
  [106, 563, 130, 'Name of Certifying Officer'], [275, 563, 3, ':'], [309, 563, 188, '______________________________'],
  [106, 589, 153, 'Phone No. of Certifying Officer'], [276, 589, 3, ':'], [309, 589, 188, '______________________________'],
  [106, 628, 60, 'Designation'], [275, 628, 3, ':'], [309, 628, 188, '______________________________']
]);
const known = (l) => !!(C.labelKey(l) || C.heuristicKey({ label: l }));
const find = (bs, label) => bs.find((b) => b.label === label);

test('underscores after "Label :" are the blanks, exactly on their lines', () => {
  const bs = G.blanksFromTextLayer(page1, known);
  // [label, baseline, underline from, to] (pt)
  for (const [label, base, x0, x1] of [['Full Name', 246, 275, 522], ["Father’s Name", 267, 275, 519], ['Permanent Address', 289, 275, 522],
    ['Date of Birth', 489, 175, 261], ['Domicile', 533, 160, 258]]) {
    const b = find(bs, label);
    assert.ok(b && b.underline, `${label} found on its underline`);
    const bottom = (b.box.y + b.box.h) * H;
    assert.ok(bottom > base - 1 && bottom < base + 4, `${label}: box sits on the line (bottom ${bottom.toFixed(1)} vs ${base})`);
    assert.ok(b.box.x * W >= x0 && (b.box.x + b.box.w) * W <= x1, `${label}: within its underline (${(b.box.x * W).toFixed(0)}–${((b.box.x + b.box.w) * W).toFixed(0)})`);
  }
  // the two continuation lines of the address have no label of their own
  assert.equal(bs.filter((b) => b.underline && !b.label && b.box.y * H > 300 && b.box.y * H < 380).length, 2);
  // "Post Applied for" is on its own underline, not beside the photo box
  const post = find(bs, 'Post Applied for');
  assert.ok(post && post.box.x * W > 150 && (post.box.x + post.box.w) * W < 360);
  // "(State)" under Domicile is a note, not a field
  assert.ok(!bs.some((b) => b.label === '(State)'));
});

test('"Sex : Male : Female :" becomes tick boxes', () => {
  const ticks = G.blanksFromTextLayer(page1, known).filter((b) => b.kind === 'check');
  assert.deepEqual(ticks.map((t) => t.option), ['Male', 'Female']);
  assert.ok(ticks.every((t) => t.label === 'Sex' && C.heuristicKey({ label: t.label }) === 'personal.gender'));
});

test('page 3: Shri / S/o / R/O and address headings above their lines', () => {
  const bs = G.blanksFromTextLayer(page3, known);
  const keyOf = (b) => C.labelKey(b.label) || C.heuristicKey({ label: b.label });
  assert.equal(keyOf(bs[0]), 'personal.fullName', bs[0].label);
  assert.equal(keyOf(find(bs, 'S/o')), 'family.fatherName');
  const ro = bs.find((b) => /resident of/.test(b.label));
  assert.ok(ro && keyOf(ro) === 'permanentAddress.full' && Math.abs((ro.box.y + ro.box.h) * H - 258) < 4, 'R/O line takes the label from the line above');
  const perm = find(bs, 'PERMANENT ADDRESS');
  assert.ok(perm && perm.underline && Math.abs((perm.box.y + perm.box.h) * H - 343) < 4, 'heading labels the first line under it');
  assert.ok(!bs.some((b) => b.label === 'PERMANENT ADDRESS' && !b.underline), 'no box after the heading’s colon');
});

test('officer section is recognised and never mapped to your details', () => {
  for (const l of ['Signature of the Certifying Officer', 'Name of Certifying Officer', 'Phone No. of Certifying Officer', 'Attested by', 'For office use only']) {
    assert.ok(C.isOfficialLabel(l), l);
    assert.equal(C.labelKey(l), null, l);
    assert.equal(C.heuristicKey({ label: l }), null, l);
  }
  assert.ok(C.isOfficialFollower('Designation') && C.isOfficialFollower('Phone No.') && C.isOfficialFollower('(Seal of Office)') === false);
  assert.ok(!C.isOfficialFollower('Full Name of the candidate'));
  assert.ok(C.isOfficialHeading('FOR OFFICE USE ONLY') && C.isOfficialHeading('To be filled by the Head of Office'));
  assert.ok(!C.isOfficialLabel('Full Name') && !C.isOfficialLabel('Principal Subjects'));
  // other things this form taught us
  assert.equal(C.heuristicKey({ label: 'Name of Issuing Branch' }), null);
  assert.equal(C.heuristicKey({ label: 'Date of Discharge from Service' }), null);
  assert.equal(C.heuristicKey({ label: 'Experience' }), null);
});

test('photo-box edges are not lines to write on', () => {
  const OPS = { save: 1, restore: 2, transform: 3, constructPath: 4, moveTo: 5, lineTo: 6, rectangle: 7, curveTo: 8, curveTo2: 9, curveTo3: 10 };
  // a box drawn from four thin bars (like the photo box), plus a real underline
  const bar = (x, y, w, h) => [OPS.constructPath, [[OPS.rectangle], [x, y, w, h]]];
  const ops = [bar(430, 600, 110, 1), bar(430, 720, 110, 1), bar(430, 600, 1, 121), bar(539, 600, 1, 121), bar(280, 500, 240, 0.8)];
  const rules = G.horizontalRules(ops.map((o) => o[0]), ops.map((o) => o[1]), OPS);
  assert.deepEqual(rules.map((r) => Math.round(r.y)), [500]);
});

test('an AI box one line too low snaps to its own label’s line, not the next field', () => {
  const ink = G.inkItems(page1);
  const lines = G.underlineRuns(page1);
  const tooLow = { x: 286 / W, y: 244 / H, w: 235 / W, h: 15 / H }; // bottom at 259: between Full Name (246) and Father (267)
  const snapped = G.snapByLabel(tooLow, 'Full Name', ink, lines, C.norm);
  assert.ok(Math.abs((snapped.y + snapped.h) * H - 246) < 4, `snapped to Full Name's line (${((snapped.y + snapped.h) * H).toFixed(1)})`);
  assert.equal(G.overlapsText(snapped, ink), false, 'underscores are not counted as printed text');
});
