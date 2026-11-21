// Regression: sentence-style blanks (identity certificate page 3) and the ICMR bilingual form's writing areas.
// Text pieces are [x, baseline from top, width, text] in pt, as pdf.js reports them for those files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as G from '../lib/pdfgeom.js';
import { resolveValue, newProfile, educationSummary, workSummary } from '../lib/schema.js';
const C = createRequire(import.meta.url)('../content/fillcore.js');

const W = 612, H = 792, FS = 10.5;
const mk = (rows) => rows.map(([x, base, w, text]) => ({ text, x: x / W, y: (base - FS) / H, w: w / W, h: (FS * 1.15) / H }));
const known = (l) => l.length <= 60 && !!(C.labelKey(l) || C.heuristicKey({ label: l }));
const keyOf = (b) => C.labelKey(b.label) || C.heuristicKey({ label: b.label }) || (C.isPostApplied(b.label) ? 'post' : null);

const sentence = mk([
  [106, 219, 445, 'This is to certify that the details and photograph of Shri _________________________'],
  [106, 239, 445, 'S/o._________________________________________________ and resident of (R/O)'],
  [106, 258, 427, '____________________________________________________________________'],
  [106, 278, 445, 'who has applied for the post of _____________________________________________ is'],
  [106, 297, 230, 'verified and certified as correct and genuine.'],
  [106, 330, 137, 'PERMANENT ADDRESS :'],
  [140, 343, 364, '__________________________________________________________']
]);

test('sentence blanks: one per underline, in reading order, with the right key', () => {
  const bs = G.blanksFromTextLayer(sentence, known).filter((b) => b.sentence);
  assert.deepEqual(bs.map(keyOf), ['personal.fullName', 'family.fatherName', 'permanentAddress.full', 'post']);
  // each on its own printed line (bottom of the box on the underline), one text line high
  for (const [b, base] of bs.map((b, i) => [b, [219, 239, 258, 278][i]])) {
    const bottom = (b.box.y + b.box.h) * H;
    assert.ok(bottom > base - 1 && bottom < base + 4, `${b.label}: on its line (${bottom.toFixed(1)} vs ${base})`);
    assert.ok(b.box.h * H < FS * 1.4, `${b.label}: never spans two lines`);
  }
  // none overlap
  for (let i = 0; i < bs.length; i++) for (let j = i + 1; j < bs.length; j++) {
    const a = bs[i].box, c = bs[j].box;
    assert.ok(!(a.x < c.x + c.w && a.x + a.w > c.x && a.y < c.y + c.h && a.y + a.h > c.y), `${bs[i].label} × ${bs[j].label}`);
  }
});

test('"Label : ____" is not a sentence blank', () => {
  const bs = G.blanksFromTextLayer(sentence, known);
  const perm = bs.find((b) => /PERMANENT ADDRESS/.test(b.label));
  assert.ok(perm && !perm.sentence);
});

test('"Shri ____ ____": two underlines with only a space between are one blank', () => {
  const two = mk([[106, 219, 200, 'photograph of Shri'], [210, 219, 120, '______________'], [334, 219, 120, '______________']]);
  const bs = G.blanksFromTextLayer(two, known).filter((b) => b.underline);
  assert.equal(bs.length, 1);
  assert.ok(Math.abs((bs[0].box.x + bs[0].box.w) * W - 454) < 1, 'spans both underlines');
});

// ICMR "Application Form" (bilingual; English part of the labels)
const icmr = mk([
  [77, 96, 12, '1.'], [95, 96, 155, 'Name of the Post applied for /'], [250, 96, 85, 'आवेदित पद का नाम'], [337, 96, 3, ':'],
  [77, 117, 12, '2.'], [95, 117, 38, 'Name /'], [134, 117, 18, 'नाम'], [153, 117, 3, ':'],
  [77, 221, 12, '7.'], [95, 221, 55, 'Email ID /'], [151, 221, 52, 'ईमेल आईडी'], [205, 221, 3, ':'],
  [77, 265, 12, '8.'], [95, 265, 440, 'Academic Qualifications indicating subject, year of passing, Division (as per Essential'],
  [95, 279, 190, 'Qualifications of the Advertisement) /'], [290, 279, 210, 'शैक्षणिक योग्यता जिसमें विषय'],
  [95, 292, 200, '(विज्ञापन की आवश्यक योग्यता के अनुसार)'],
  [77, 389, 12, '9.'], [95, 389, 355, 'Work Experience in chronological order beginning from first to last /'], [452, 389, 85, 'पहले से अंतिम तक'],
  [95, 402, 110, 'कालानुक्रमिक क्रम में कार्य अनुभव'],
  [77, 598, 16, '10.'], [95, 598, 300, 'Copy of documents to be submitted with application form'],
  [77, 625, 10, 'a.'], [95, 625, 112, 'Proof of Date of birth /'],
  [77, 639, 10, 'b.'], [95, 639, 120, 'Education qualification /']
]);

test('ICMR: numbered headings with empty space below are writing areas with the right keys', () => {
  const areas = G.blanksFromTextLayer(icmr, known).filter((b) => b.area);
  assert.deepEqual(areas.map((a) => C.labelKey(a.label)), ['education.summary', 'work.summary']);
  const [q, w] = areas;
  assert.ok(q.box.y * H > 292 && (q.box.y + q.box.h) * H < 389 - 8, 'qualifications: between its heading and item 9');
  assert.ok(w.box.y * H > 402 && (w.box.y + w.box.h) * H < 598 - 8, 'experience: between its heading and item 10');
  assert.ok(Math.abs(q.box.x * W - 95) < 1, 'starts under the heading text, not the number');
  // the documents list (short gaps) is not a writing area
  assert.ok(!areas.some((a) => a.box.y * H > 598));
});

test('ICMR: colon fields still sit after the colon; the post label is recognised as "post applied for"', () => {
  const bs = G.blanksFromTextLayer(icmr, known);
  const name = bs.find((b) => /^Name \/ नाम$/.test(b.label) || /^Name/.test(b.label) && C.labelKey(b.label) === 'personal.fullName');
  assert.ok(name && name.box.x * W > 153, 'Name after its colon');
  const post = bs.find((b) => C.isPostApplied(b.label));
  assert.ok(post && post.box.x * W > 337 && C.labelKey(post.label) === null, 'post: after its colon, never your name');
  assert.ok(C.isPostApplied('who has applied for the post of'));
});

test('labels for qualification / experience areas (English and Hindi), not for single fields', () => {
  for (const l of ['Academic Qualifications indicating subject, year of passing, Division', 'Academic Qualifications', 'शैक्षणिक योग्यता'])
    assert.equal(C.labelKey(l), 'education.summary', l);
  for (const l of ['Work Experience in chronological order beginning from first to last', 'Work experience', 'कार्य अनुभव'])
    assert.equal(C.labelKey(l), 'work.summary', l);
  for (const l of ['Educational Qualification', 'Experience', 'Total work experience (years)', 'Experience certificates/testimonials', 'अनुभव प्रमाण पत्र'])
    assert.notEqual(C.labelKey(l)?.endsWith('summary'), true, l);
});

test('education and work summaries: highest qualification first, jobs oldest first', () => {
  const p = newProfile('Test');
  Object.assign(p.education.class10, { board: 'UP Board', year: '2011', marksObtained: '452', maxMarks: '600' });
  Object.assign(p.education.graduation, { qualification: 'B.Sc', stream: 'physics', board: 'University of Lucknow', year: '2016', percentage: '71' });
  Object.assign(p.education.postGraduation, { qualification: 'M.A.', stream: 'public administration', board: 'University of Lucknow', year: '2018', division: 'First Division' });
  Object.assign(p.work.current, { employer: 'Example Pvt Ltd', designation: 'Data Analyst', from: '2019-07-01' });
  Object.assign(p.work.previous1, { employer: 'City Hospital', designation: 'office assistant', from: '2016-08-01', to: '2019-06-30', location: 'Lucknow' });
  assert.equal(educationSummary(p), [
    'M.A. (Public Administration), University of Lucknow, 2018, First Division',
    'B.Sc (Physics), University of Lucknow, 2016, 71%',
    'Class 10, UP Board, 2011, 75.33%'
  ].join('\n'));
  assert.equal(workSummary(p), 'Office Assistant, City Hospital, Lucknow: 01/08/2016 to 30/06/2019\nData Analyst, Example Pvt Ltd: 01/07/2019 to present');
  assert.equal(resolveValue(p, 'education.summary').value, educationSummary(p));
  assert.equal(resolveValue(newProfile('Empty'), 'work.summary'), null);
});
