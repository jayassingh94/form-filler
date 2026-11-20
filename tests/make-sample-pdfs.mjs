// Generates the sample PDFs used for testing "Fill a PDF":
//   test/sample-flat-form.pdf   flat form (lines, character boxes, tick boxes, table), no form fields
//   test/sample-acroform.pdf    form with real fillable fields
//   tests/fixtures/flat-layout.json  true positions of every blank on the flat form (for tests)
// Run: node tests/make-sample-pdfs.mjs
import fs from 'node:fs';
import { createRequire } from 'node:module';
import '../vendor/regenerator-runtime/runtime.js';
import { PDFDocument, StandardFonts, rgb } from '../vendor/pdf-lib/pdf-lib.esm.min.js';
const fontkit = createRequire(import.meta.url)('../vendor/fontkit/fontkit.umd.min.js');

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

// Labels exactly as reported in a real form (no colons, curly apostrophe, multi-line addresses).
async function labels() {
  const doc = await PDFDocument.create();
  const page = doc.addPage([W, H]);
  const f = await doc.embedFont(StandardFonts.Helvetica);
  const fb = await doc.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0, 0, 0);
  const t = (s, x, y, size = 10.5, font = f) => page.drawText(s, { x, y, size, font, color: ink });
  const line = (x0, x1, y) => page.drawLine({ start: { x: x0, y }, end: { x: x1, y }, thickness: 0.6, color: ink });
  const X0 = 200, X1 = 540, items = [];
  // what a model might return: label + messy/missing keys, one item per printed line
  const add = (label, y, key, extra = {}) => { line(X0, X1, y); items.push({ label, kind: 'text', box_2d: box2d(X0, y, X1, y + 15), key, confidence: 'high', cells: 0, uppercase: false, ...extra }); };
  t('APPLICATION FORM', 230, 790, 14, fb);
  t('Full Name', 50, 722); add('Full Name', 720, 'fullName');
  t('Father\u2019s Name', 50, 692); add('Father\u2019s Name', 690, 'father_name');
  t("Mother's Name", 50, 662); add("Mother's Name", 660, null, { confidence: 'low' });
  t('Date of Birth', 50, 632); add('Date of Birth', 630, 'personal.dob', { dateFormat: 'DD/MM/YYYY' });
  t('Permanent Address', 50, 592);
  add('Permanent Address', 590, 'permanentAddress.line1');
  add('Permanent Address (contd.)', 566, null);
  add('Permanent Address (contd.)', 542, null);
  t('Address for Correspondence', 50, 502);
  add('Address for Correspondence', 500, 'currentAddress');
  add('', 476, null);
  add('', 452, null);
  t('Mobile No.', 50, 412); add('Mobile No.', 410, 'contact.mobile');
  t('Signature of Applicant', 400, 330, 9); line(380, 540, 342);
  items.push({ label: 'Signature of Applicant', kind: 'skip', box_2d: box2d(380, 342, 540, 370), key: null, confidence: 'high' });
  fs.writeFileSync(ROOT + 'test/sample-labels-form.pdf', await doc.save());
  fs.writeFileSync(ROOT + 'tests/fixtures/labels-layout.json', JSON.stringify({ page: { w: W, h: H }, items }, null, 1));
}

// Bilingual government-style form without blank lines (labels "Name / नाम :" with empty space after the
// colon), modelled on an ICMR consultant application form. Labels are drawn in pieces, like real PDFs.
async function bilingual() {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const PW = 612, PH = 792;
  const page = doc.addPage([PW, PH]);
  const f = await doc.embedFont(StandardFonts.Helvetica);
  const fb = await doc.embedFont(StandardFonts.HelveticaBold);
  const hi = await doc.embedFont(fs.readFileSync(ROOT + 'vendor/fonts/NotoSansDevanagari-Regular.ttf'), { subset: true });
  const top = (y) => PH - y; // y measured from the top like the original
  const t = (str, x, y, font = f, size = 11.5) => { page.drawText(str, { x, y: top(y), size, font }); return x + font.widthOfTextAtSize(str, size); };
  const b2d = (x0, y0, x1, y1) => [Math.round((y0 / PH) * 1000), Math.round((x0 / PW) * 1000), Math.round((y1 / PH) * 1000), Math.round((x1 / PW) * 1000)];
  const items = [];
  t('Application Form', 255, 66, fb, 14);
  const row = (n, en, hiText, y, key, aiBox) => {
    t(`${n}.`, 77, y);
    let x = t(en + ' /', 95, y);
    x = t(hiText, x + 3, y, hi, 11);
    const colonX = t(':', x + 3, y) ;
    items.push({ label: `${en} / ${hiText}`, kind: 'text', key, confidence: 'high', box_2d: aiBox ? b2d(...aiBox(colonX)) : b2d(colonX + 6, y - 11, 540, y + 3), cells: 0, uppercase: false, colonX });
  };
  // AI mistakes on purpose: boxes on top of labels, and the post field mapped to the applicant's name
  row(1, 'Name of the Post applied for', 'आवेदित पद का नाम', 96, 'personal.fullName', () => [95, 85, 420, 99]);
  row(2, 'Name', 'नाम', 117, 'personal.fullName', () => [95, 106, 400, 120]);
  row(3, 'Father\u2019s/Husband\u2019s Name', 'पिता/पति का नाम', 138, 'family.fatherName', () => [239, 127, 540, 141]);
  row(4, 'Date of Birth', 'जन्म तिथि', 159, 'personal.dob');
  row(5, 'Address for Communication', 'संचार के लिए पता', 179, 'currentAddress.full');
  row(6, 'Mobile Number', 'मोबाइल नंबर', 200, 'contact.mobile');
  row(7, 'Email ID', 'ईमेल आईडी', 221, 'email');
  t('8.', 77, 265);
  t('Academic Qualifications indicating subject, year of passing, Division (as per Essential', 95, 265);
  let x = t('Qualifications of the Advertisement) /', 95, 279);
  t('शैक्षणिक योग्यता जिसमें विषय, उत्तीर्ण होने का वर्ष, डिवीजन', x + 3, 279, hi, 11);
  t('(विज्ञापन की आवश्यक योग्यता के अनुसार) दर्शाया गया हो', 95, 292, hi, 11);
  t('9.', 77, 389);
  x = t('Work Experience in chronological order beginning from first to last /', 95, 389);
  t('पहले से अंतिम तक', x + 3, 389, hi, 11);
  t('कालानुक्रमिक क्रम में कार्य अनुभव', 95, 402, hi, 11);
  x = t('Copy of documents to be submitted with application form /', 95, 598);
  t('आवेदन पत्र के साथ', x + 3, 598, hi, 11);
  t('Proof of Date of birth / जन्म तिथि का प्रमाण'.split(' / ')[0] + ' /', 95, 625);
  t('Education qualification /', 95, 639);
  t('Experience certificates/testimonials /', 95, 653);
  fs.writeFileSync(ROOT + 'test/sample-bilingual-form.pdf', await doc.save());
  fs.writeFileSync(ROOT + 'tests/fixtures/bilingual-layout.json', JSON.stringify({ page: { w: PW, h: PH }, items }, null, 1));
}

// A generated lookalike of a typical government "application form + identity certificate" (3 pages):
// labels and underscore blanks as separate text pieces, "Sex : Male : Female :" with tick boxes, a category
// table, a photo box drawn from thin bars, a fee/DD line, a declaration and an officer section.
// Used as the regression sample for underscore forms (test/sample-identity-certificate.pdf).
async function identity() {
  const doc = await PDFDocument.create();
  doc.setTitle('Application form and identity certificate (sample)');
  doc.setAuthor('Form Filler test suite');
  doc.setCreator('tests/make-sample-pdfs.mjs');
  doc.setProducer('pdf-lib');
  const PW = 612, PH = 792, FS = 10.5;
  const f = await doc.embedFont(StandardFonts.Helvetica);
  const fb = await doc.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0, 0, 0);
  const U = f.widthOfTextAtSize('_', FS);
  const us = (w) => '_'.repeat(Math.max(3, Math.round(w / U)));
  const newPage = (n) => {
    const page = doc.addPage([PW, PH]);
    const t = (str, x, base, font = f, size = FS) => page.drawText(str, { x, y: PH - base, size, font, color: ink });
    // boxes are drawn from thin filled bars, like the original form (their edges must not count as writing lines)
    const bar = (x, top, w, h) => page.drawRectangle({ x, y: PH - top - h, width: w, height: h, color: ink });
    const box = (x0, top, x1, bottom) => { bar(x0, top, x1 - x0, 0.8); bar(x0, bottom, x1 - x0, 0.8); bar(x0, top, 0.8, bottom - top); bar(x1, top, 0.8, bottom - top + 0.8); };
    t(`Page ${n}`, 519, 743);
    page.drawRectangle({ x: 106, y: PH - 730, width: 440, height: 2.5, color: rgb(0.45, 0.12, 0.12) });
    return { page, t, bar, box };
  };

  // ---- page 1: application form
  {
    const { t, bar, box } = newPage(1);
    t('APPLICATION FORM', 256, 54, fb, 14);
    t('Post Applied for :' + us(130), 106, 83, f, 12);
    box(430, 72, 540, 200); bar(430, 105, 110, 0.8);
    for (const [s, y] of [['Affix recent passport', 87], ['size photograph', 100], ['Identity should be', 126], ['certified by an officer as', 139],
      ['mentioned in the', 152], ['advertisement with', 165], ['designation / seal of', 178], ['office.', 191]]) t(s, 485 - f.widthOfTextAtSize(s, 9.5) / 2, y, f, 9.5);
    const row = (label, base, w = 246) => { t(label, 106, base); t(': ' + us(w - 8), 275, base); };
    row('1. Full Name', 246); row('2. Father’s Name', 267); row('3. Permanent Address', 289);
    t(us(241), 281, 338); t(us(241), 281, 370);
    t('4. Address for Correspondence /', 106, 392); t('Present Address', 116, 403); t(': ' + us(235), 275, 403);
    t(us(235), 283, 424); t(us(235), 283, 446);
    t('5. Date of Birth : ' + us(70), 106, 489);
    t('6. Sex : Male :', 275, 489); box(350, 478, 392, 492);
    t('Female :', 411, 489); box(456, 478, 498, 492);
    t('7. Religion : ' + us(88), 106, 511); t('8.', 274, 511); t('Nationality : ' + us(180), 289, 511);
    t('9. Domicile : ' + us(86), 106, 533); t('(State)', 117, 543); t('10.', 276, 533); t('Category:', 297, 533);
    const cols = [347, 372, 397, 432, 475, 520];
    for (let i = 0; i < cols.length - 1; i++) t(['SC', 'ST', 'OBC', 'EXSM', 'PH'][i], cols[i] + 5, 532);
    box(347, 521, 520, 557); bar(347, 537, 173, 0.8); for (const x of cols.slice(1, -1)) bar(x, 521, 0.8, 36);
    t('11. Ex-Serviceman', 106, 587);
    for (const [label, base] of [['Date of Joining Service', 608], ['Date of Discharge from Service', 630]]) { t(label, 117, base); t(':', 275, base); t(us(157), 302, base); }
    for (const [label, base] of [['12. E-mail id', 652], ['13. Telephone No. (With Std Code)', 673]]) { t(label, 106, base); t(':', 275, base); t(us(147), 309, base); }
    t('14. Mobile No.', 106, 695); t('(If any)', 174, 695); t(':', 275, 695); t(us(147), 309, 695);
  }
  // ---- page 2: education, experience, fee, declaration
  {
    const { t, bar, box } = newPage(2);
    t('15. Educational Qualification :', 106, 49);
    box(106, 40, 546, 210); bar(106, 78, 440, 0.8);
    for (const x of [200, 246, 340, 455]) bar(x, 40, 0.8, 170);
    for (let y = 106; y < 210; y += 26) bar(106, y, 440, 0.6);
    t('Qualification', 115, 60, f, 9.5); t('Subjects', 251, 60, f, 9.5); t('Principal', 208, 71, f, 9.5); t('Subsidiary', 289, 71, f, 9.5);
    t('Percentage of', 366, 60, f, 9.5); t('marks', 384, 71, f, 9.5); t('Year of Passing', 464, 60, f, 9.5);
    t('16. Experience :', 106, 236);
    box(106, 255, 546, 350); bar(106, 286, 440, 0.8);
    for (const x of [200, 285, 380, 460]) bar(x, 255, 0.8, 95);
    t('Name of the', 120, 269, f, 9.5); t('Organisation', 117, 279, f, 9.5); t('Designation', 211, 269, f, 9.5); t('Nature of duties', 293, 269, f, 9.5);
    t('Period', 405, 269, f, 9.5); t('From', 385, 280, f, 9.5); t('To', 437, 280, f, 9.5); t('Duration.', 492, 269, f, 9.5);
    t('17. If employed in Govt. Dept. / PSU, whether applied through proper channel : Yes / No.', 106, 368);
    t(`18. DD No. ${us(58)} Date.${us(92)} Name of Issuing Branch ${us(62)}`, 106, 390);
    t(`Branch Code No. ${us(92)}.`, 119, 401);
    const decl = ['Declaration : I hereby declare that all statements made in this application are true, complete and',
      'correct to the best of my knowledge and belief. I understand that if any information is found to be untrue,',
      'or if I do not meet the eligibility criteria, my candidature may be cancelled without notice. I have read',
      'the advertisement and agree to abide by its rules and procedures for appointment to the post applied for.'];
    decl.forEach((line, i) => t(line, 106, 426 + i * 16, f, 10));
    t('Date :', 106, 572); t('Place :', 106, 604); t('(Signature of Applicant)', 377, 604);
  }
  // ---- page 3: identity certificate with officer section
  {
    const { t, box, bar } = newPage(3);
    t('IDENTITY CERTIFICATE', 255, 63, fb, 14);
    box(240, 70, 400, 200); bar(240, 104, 160, 0.8);
    t('Affix photograph', 282, 98, f, 9.5);
    for (const [s, y] of [['Seal of office & Signature of the', 113], ['officer attesting this certificate', 126], ['should appear on the', 139], ['Photograph.', 152]]) t(s, 320 - f.widthOfTextAtSize(s, 9.5) / 2, y, f, 9.5);
    t('This is to certify that the details and photograph of Shri ' + us(140), 106, 219);
    t('S/o.' + us(268) + ' and resident of (R/O)', 106, 239);
    t(us(427), 106, 258);
    t('who has applied for the post of ' + us(260) + ' is', 106, 278);
    t('verified and certified as correct and genuine.', 106, 297);
    t('PERMANENT ADDRESS :', 106, 330, fb);
    for (const y of [343, 369, 395]) t(us(364), 140, y);
    t('PRESENT ADDRESS :', 106, 421, fb);
    for (const y of [434, 459, 485]) t(us(358), 140, y);
    for (const [label, base, colon] of [['Signature of the Candidate', 511, true], ['Signature of the Certifying Officer:', 537, false],
      ['Name of Certifying Officer', 563, true], ['Phone No. of Certifying Officer', 589, true], ['Designation', 628, true]]) {
      t(label, 106, base); if (colon) t(':', 275, base); t(us(188), 309, base);
    }
    t('(Seal of Office )', 106, 641);
    const note = ['[Note : Identity of the candidate should be certified by an officer not below the rank of Tehsildar /',
      'Sub-Divisional Officer of the candidate’s domicile or native place, or the Principal of the school / college',
      'from where the candidate passed Class 10, Intermediate, Graduation or Diploma, with name, designation and seal.]'];
    note.forEach((line, i) => t(line, 106, 680 + i * 13, fb, 9));
  }
  fs.writeFileSync(ROOT + 'test/sample-identity-certificate.pdf', await doc.save({ useObjectStreams: false }));
}

const only = process.argv[2];
if (!only || only === 'flat') await flat();
if (!only || only === 'acro') await acro();
if (!only || only === 'labels') await labels();
if (!only || only === 'bilingual') await bilingual();
if (!only || only === 'identity') await identity();
console.log(`wrote ${only ? only + ' sample' : 'sample PDFs in test/ and layouts in tests/fixtures/'}`);
