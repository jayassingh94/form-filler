// Generates the sample PDFs used for testing "Fill a PDF":
//   test/sample-flat-form.pdf   flat form (lines, character boxes, tick boxes, table), no form fields
//   test/sample-acroform.pdf    form with real fillable fields
//   tests/fixtures/flat-layout.json  true positions of every blank on the flat form (for tests)
// Run: node tests/make-sample-pdfs.mjs
import fs from 'node:fs';
import { PDFDocument, StandardFonts, rgb } from '../vendor/pdf-lib/pdf-lib.esm.min.js';

const ROOT = new URL('..', import.meta.url).pathname;
const W = 595, H = 842; // A4
const box2d = (x0, y0, x1, y1) => [ // pdf coords (bottom-left origin) -> Gemini [ymin,xmin,ymax,xmax] 0..1000
  Math.round(((H - y1) / H) * 1000), Math.round((x0 / W) * 1000),
  Math.round(((H - y0) / H) * 1000), Math.round((x1 / W) * 1000)
];

async function flat() {
  const doc = await PDFDocument.create();
  const page = doc.addPage([W, H]);
  const f = await doc.embedFont(StandardFonts.Helvetica);
  const fb = await doc.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0, 0, 0);
  const t = (s, x, y, size = 10, font = f) => page.drawText(s, { x, y, size, font, color: ink });
  const line = (x0, x1, y) => page.drawLine({ start: { x: x0, y }, end: { x: x1, y }, thickness: 0.6, color: ink });
  const rect = (x, y, w, h) => page.drawRectangle({ x, y, width: w, height: h, borderColor: ink, borderWidth: 0.6 });
  const items = [];
  const add = (o) => items.push({ confidence: 'high', cells: 0, uppercase: true, ...o });

  t('APPLICATION FORM FOR THE POST OF OFFICE ASSISTANT', 105, 800, 13, fb);
  t('(Fill in CAPITAL LETTERS. Tick the appropriate box.)', 175, 784, 9);
  rect(470, 640, 90, 120);
  t('Affix recent', 488, 705, 8); t('passport size', 486, 695, 8); t('photograph', 491, 685, 8);
  add({ label: 'Photograph', kind: 'skip', box_2d: box2d(470, 640, 560, 760), key: null });

  // 1. Name in character boxes
  t('1. Name of Candidate:', 40, 744);
  const cells = 20, cw = 14;
  for (let i = 0; i < cells; i++) rect(170 + i * cw, 740, cw, 16);
  add({ label: 'Name of Candidate', kind: 'text', box_2d: box2d(170, 740, 170 + cells * cw, 756), cells, key: 'personal.fullName' });

  const lineField = (n, label, y, key, x0 = 170, x1 = 455, extra = {}) => {
    t(`${n}. ${label}:`, 40, y + 2);
    line(x0, x1, y);
    add({ label, kind: 'text', box_2d: box2d(x0, y, x1, y + 14), key, ...extra });
  };
  lineField(2, "Father's Name", 712, 'family.fatherName');
  lineField(3, "Mother's Name", 688, 'family.motherName');
  lineField(4, 'Date of Birth (DD/MM/YYYY)', 664, 'personal.dob', 190, 330, { dateFormat: 'DD/MM/YYYY' });

  const ticks = (n, label, y, key, opts) => {
    t(`${n}. ${label}:`, 40, y + 2);
    let x = 150;
    for (const o of opts) {
      rect(x, y, 10, 10);
      t(o, x + 14, y + 1);
      add({ label, kind: 'checkbox', option: o, box_2d: box2d(x, y, x + 10, y + 10), key });
      x += 22 + f.widthOfTextAtSize(o, 10) + 18;
    }
  };
  ticks(5, 'Sex', 638, 'personal.gender', ['Male', 'Female', 'Transgender']);
  ticks(6, 'Category', 614, 'category.category', ['GEN', 'OBC', 'SC', 'ST', 'EWS']);
  ticks(7, 'Marital Status', 590, 'personal.maritalStatus', ['Unmarried', 'Married']);

  lineField(8, 'Mobile No.', 566, 'contact.mobile', 170, 330);
  lineField(9, 'E-mail', 542, 'contact.email', 170, 455);
  t('10. Permanent Address:', 40, 520);
  line(170, 560, 518); line(40, 560, 498);
  add({ label: 'Permanent Address', kind: 'text', box_2d: box2d(170, 518, 560, 532), key: 'permanentAddress.full' });
  t('11. PIN Code:', 40, 476);
  for (let i = 0; i < 6; i++) rect(120 + i * cw, 472, cw, 16);
  add({ label: 'PIN Code', kind: 'text', box_2d: box2d(120, 472, 120 + 6 * cw, 488), cells: 6, key: 'permanentAddress.pincode' });
  t('State:', 240, 476);
  line(275, 455, 472);
  add({ label: 'State', kind: 'text', box_2d: box2d(275, 472, 455, 486), key: 'permanentAddress.state' });

  // 12. Education table
  t('12. Educational Qualifications:', 40, 446, 10, fb);
  const cols = [40, 150, 330, 440, 560];
  const heads = ['Examination', 'Board / University', 'Year of Passing', 'Percentage'];
  const rows = [['10th', 'class10'], ['12th', 'class12'], ['Graduation', 'graduation']];
  const top = 438, rh = 20;
  for (let r = 0; r <= rows.length + 1; r++) line(cols[0], cols[4], top - r * rh);
  for (const x of cols) page.drawLine({ start: { x, y: top }, end: { x, y: top - (rows.length + 1) * rh }, thickness: 0.6, color: ink });
  heads.forEach((h, i) => t(h, cols[i] + 4, top - 14, 9, fb));
  const colKey = ['board', 'year', 'percentage'];
  rows.forEach(([name, lvl], r) => {
    const y0 = top - (r + 2) * rh;
    t(name, cols[0] + 4, y0 + 6, 9);
    for (let c = 1; c <= 3; c++) {
      add({ label: `${name} - ${heads[c]}`, kind: 'text', uppercase: false, box_2d: box2d(cols[c] + 2, y0 + 2, cols[c + 1] - 2, y0 + rh - 2), key: `education.${lvl}.${colKey[c - 1]}` });
    }
  });

  lineField(13, 'Bank Account No. (for refund)', 330, null, 210, 455);
  items[items.length - 1].kind = 'skip';
  t('DECLARATION: I hereby declare that all statements made in this application are true.', 40, 296, 9);
  lineField(14, 'Place', 262, 'permanentAddress.city', 85, 230, { uppercase: false });
  t('Signature of Candidate', 420, 250, 9);
  line(400, 560, 262);
  add({ label: 'Signature of Candidate', kind: 'skip', box_2d: box2d(400, 262, 560, 290), key: null });
  lineField(15, 'Name in Hindi', 222, 'personal.nameHindi', 150, 455, { uppercase: false });

  fs.writeFileSync(ROOT + 'test/sample-flat-form.pdf', await doc.save());
  fs.mkdirSync(ROOT + 'tests/fixtures', { recursive: true });
  fs.writeFileSync(ROOT + 'tests/fixtures/flat-layout.json', JSON.stringify({ page: { w: W, h: H }, items }, null, 1));
}

async function acro() {
  const doc = await PDFDocument.create();
  const page = doc.addPage([W, H]);
  const f = await doc.embedFont(StandardFonts.Helvetica);
  const form = doc.getForm();
  const t = (s, x, y, size = 10) => page.drawText(s, { x, y, size, font: f });
  t('SCHOLARSHIP APPLICATION (fillable)', 160, 790, 14);
  const text = (label, name, y, w = 280) => {
    t(label, 40, y + 5);
    const tf = form.createTextField(name);
    tf.addToPage(page, { x: 200, y, width: w, height: 18, font: f });
  };
  text('Applicant Name', 'applicant_name', 740);
  text("Father's Name", 'father_name', 710);
  text('Date of Birth (DD/MM/YYYY)', 'dob', 680, 120);
  text('Name in Hindi', 'name_hindi', 440);
  t('Gender', 40, 655);
  const g = form.createRadioGroup('gender');
  g.addOptionToPage('Male', page, { x: 200, y: 650, width: 12, height: 12 }); t('Male', 216, 652);
  g.addOptionToPage('Female', page, { x: 260, y: 650, width: 12, height: 12 }); t('Female', 276, 652);
  t('Category', 40, 625);
  const dd = form.createDropdown('category');
  dd.addOptions(['General', 'OBC', 'SC', 'ST', 'EWS']);
  dd.addToPage(page, { x: 200, y: 620, width: 120, height: 18, font: f });
  text('E-mail', 'email', 590);
  text('Mobile Number', 'mobile', 560, 150);
  t('Correspondence address same as permanent', 40, 535);
  form.createCheckBox('same_address').addToPage(page, { x: 300, y: 530, width: 12, height: 12 });
  text('Debit Card Number (fee)', 'card_number', 500);
  t('I declare the above is true', 40, 475);
  form.createCheckBox('declaration').addToPage(page, { x: 200, y: 470, width: 12, height: 12 });
  fs.writeFileSync(ROOT + 'test/sample-acroform.pdf', await doc.save());
}

await flat();
await acro();
console.log('wrote test/sample-flat-form.pdf, test/sample-acroform.pdf, tests/fixtures/flat-layout.json');
