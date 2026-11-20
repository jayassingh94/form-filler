// Placement on forms without blank lines ("Name / नाम :" + empty space), modelled on an ICMR application form.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as G from '../lib/pdfgeom.js';
const C = createRequire(import.meta.url)('../content/fillcore.js');

const W = 612, H = 792;
// [x, yBaselineFromTop, width, text] exactly as pdf.js reports the form's pieces
const raw = [
  [255, 66, 115, 'Application Form'],
  [77, 96, 10, '1.'], [95, 96, 152, 'Name of the Post applied for /'], [249, 96, 80, 'आवेदित पद का नाम'], [332, 96, 3, ':'],
  [77, 117, 10, '2.'], [95, 117, 37, 'Name /'], [135, 117, 16, 'नाम'], [154, 117, 3, ':'],
  [77, 138, 10, '3.'], [95, 138, 139, 'Father’s/Husband’s Name /'], [236, 138, 71, 'पिता/पति का नाम'], [309, 138, 3, ':'],
  [77, 159, 10, '4.'], [95, 159, 70, 'Date of Birth /'], [169, 159, 37, 'जन्म तिथि'], [212, 159, 3, ':'],
  [77, 179, 10, '5.'], [95, 179, 148, 'Address for Communication /'], [246, 179, 71, 'संचार के लिए पता'], [319, 179, 3, ':'],
  [77, 200, 10, '6.'], [95, 200, 84, 'Mobile Number /'], [181, 200, 55, 'मोबाइल नंबर'], [243, 200, 3, ':'],
  [77, 221, 10, '7.'], [95, 221, 53, 'Email ID /'], [151, 221, 52, 'ईमेल आईडी'], [205, 221, 3, ':'],
  [77, 265, 8, '8.'], [95, 265, 437, 'Academic Qualifications indicating subject, year of passing, Division (as per Essential'],
  [95, 279, 192, 'Qualifications of the Advertisement) /'],
  [77, 389, 8, '9.'], [95, 389, 353, 'Work Experience in chronological order beginning from first to last /']
];
const fs = 11.5;
const items = raw.map(([x, base, w, text]) => ({ text, x: x / W, y: (base - fs) / H, w: w / W, h: (fs * 1.15) / H }));
const known = (l) => !!(C.labelKey(l) || C.heuristicKey({ label: l }));

test('blanks start after the colon and never overlap printed text', () => {
  const blanks = G.blanksFromTextLayer(items, known);
  const byLabel = Object.fromEntries(blanks.map((b) => [b.label, b]));
  const expect = {
    'Name / नाम': 154, 'Father’s/Husband’s Name / पिता/पति का नाम': 309, 'Date of Birth / जन्म तिथि': 212,
    'Address for Communication / संचार के लिए पता': 319, 'Mobile Number / मोबाइल नंबर': 243, 'Email ID / ईमेल आईडी': 205,
    'Name of the Post applied for / आवेदित पद का नाम': 332
  };
  for (const [label, colonX] of Object.entries(expect)) {
    const b = byLabel[label];
    assert.ok(b, `found "${label}" (got: ${Object.keys(byLabel).join(' | ')})`);
    assert.ok(b.box.x * W > colonX + 3 && b.box.x * W < colonX + 10, `${label}: starts right after the colon (${(b.box.x * W).toFixed(1)})`);
    assert.ok((b.box.x + b.box.w) * W > 500, `${label}: runs to the right margin`);
  }
  for (const b of blanks) {
    assert.equal(G.overlapsText(b.box, items), false, `box for "${b.label}" overlaps text`);
    if (b.alt) assert.equal(G.overlapsText(b.alt, items), false, `alt box for "${b.label}" overlaps text`);
  }
  // rows 1-7 are 21 pt apart: no room for a second line under them
  assert.equal(byLabel['Name / नाम'].alt, null);
});

test('labels map correctly; the post applied for is never your name', () => {
  assert.equal(C.labelKey('Name / नाम'), 'personal.fullName');
  assert.equal(C.labelKey('Father’s/Husband’s Name / पिता/पति का नाम'), 'family.fatherName');
  assert.equal(C.labelKey('Address for Communication / संचार के लिए पता'), 'currentAddress.full');
  assert.equal(C.heuristicKey({ label: 'Date of Birth / जन्म तिथि' }), 'personal.dob');
  assert.equal(C.heuristicKey({ label: 'Mobile Number / मोबाइल नंबर' }), 'contact.mobile');
  assert.equal(C.heuristicKey({ label: 'Email ID / ईमेल आईडी' }), 'contact.email');
  for (const l of ['Name of the Post applied for / आवेदित पद का नाम', 'Post Applied For', 'Name of Post', 'आवेदित पद का नाम', 'Position applied for']) {
    assert.ok(C.isPostApplied(l), l);
    assert.equal(C.labelKey(l), null, l);
    assert.equal(C.heuristicKey({ label: l }), null, l);
  }
  assert.ok(!C.isPostApplied('Name / नाम') && !C.isPostApplied('Postal Address') && !C.isPostApplied('Post Office'));
});

test('an AI box placed on top of a label is moved after the colon', () => {
  const onLabel = { x: 95 / W, y: 106 / H, w: 305 / W, h: 14 / H }; // covers "Name / नाम :"
  assert.ok(G.overlapsText(onLabel, items));
  const fixed = G.repairBox(onLabel, items);
  assert.ok(fixed && !G.overlapsText(fixed, items));
  assert.ok(fixed.x * W > 157 && fixed.x * W < 165, `starts after the colon (${(fixed.x * W).toFixed(1)})`);
  const fine = { x: 330 / W, y: 148 / H, w: 200 / W, h: 13 / H };
  assert.deepEqual(G.repairBox(fine, items), fine, 'a box in free space is left alone');
});

test('document checklist lines are not mistaken for labels', () => {
  const list = [
    { text: 'Proof of Date of birth /', x: 0.15, y: 0.78, w: 0.18, h: 0.016 },
    { text: 'जन्म तिथि का प्रमाण', x: 0.37, y: 0.78, w: 0.1, h: 0.016 },
    { text: 'Experience certificates/testimonials /', x: 0.15, y: 0.82, w: 0.29, h: 0.016 }
  ];
  // as in the app: without a colon (and no printed line), only precise labels count
  const accepted = G.blanksFromTextLayer(list, known).filter((b) => b.colon || C.labelKey(b.label));
  assert.deepEqual(accepted.map((b) => b.label), []);
  // a line ending in "/" continues on the next line: never a label on its own
  assert.deepEqual(G.blanksFromTextLayer([list[2]], known), []);
});

test('free band under a label is offered when there is room', () => {
  const sparse = [
    { text: 'Address :', x: 0.1, y: 0.2, w: 0.1, h: 0.015 },
    { text: 'Next field :', x: 0.1, y: 0.3, w: 0.12, h: 0.015 }
  ];
  const [addr] = G.blanksFromTextLayer(sparse);
  assert.ok(addr.alt && addr.alt.y > 0.215 && addr.alt.y + addr.alt.h < 0.3, 'band between the rows');
  assert.equal(G.overlapsText(addr.alt, sparse), false);
});

test('shorter address versions for tight spaces', () => {
  const parts = ['12-B, Gandhi Marg', 'Near Hanuman Mandir', 'Aliganj', 'PO Aliganj', 'Lucknow', 'Dist. Lucknow Rural', 'Uttar Pradesh - 226024'];
  const v = G.addressVariants(parts);
  assert.deepEqual(v[0], parts);
  assert.ok(!v[1].includes('Near Hanuman Mandir'));
  assert.deepEqual(v.at(-1), ['12-B, Gandhi Marg', 'Lucknow', 'Uttar Pradesh - 226024']);
});
