// Run: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const C = require('../content/fillcore.js');

const opts = (...xs) => xs.map((t) => ({ text: t, value: t }));

test('sensitive fields are detected', () => {
  const s = (o) => C.isSensitive(o);
  assert.ok(s({ type: 'password' }));
  assert.ok(s({ label: 'CVV' }));
  assert.ok(s({ name: 'cardNumber' }));
  assert.ok(s({ label: 'Enter OTP' }));
  assert.ok(s({ label: 'Bank Account Number' }));
  assert.ok(s({ label: 'IFSC Code' }));
  assert.ok(s({ autocomplete: 'cc-number' }));
  assert.ok(s({ label: 'UPI PIN' }));
  assert.ok(s({ label: 'Enter Captcha' }));
  assert.ok(!s({ label: 'Aadhaar Card Number' }));
  assert.ok(!s({ label: 'PIN Code' }));
  assert.ok(!s({ label: 'Passport Number' }));
  assert.ok(!s({ label: 'Year of Passing' }));
  assert.ok(!s({ label: 'Full Name' }));
});

test('date formats', () => {
  assert.equal(C.detectDateFormat('Date of Birth (DD/MM/YYYY)'), 'dd/mm/yyyy');
  assert.equal(C.detectDateFormat('mm-dd-yyyy'), 'mm-dd-yyyy');
  assert.equal(C.detectDateFormat('dd-mon-yyyy'), 'dd-mon-yyyy');
  assert.equal(C.detectDateFormat('Name'), null);
  assert.equal(C.formatDate('1996-03-07', 'dd/mm/yyyy'), '07/03/1996');
  assert.equal(C.formatDate('1996-03-07', 'mm-dd-yyyy'), '03-07-1996');
  assert.equal(C.formatDate('1996-03-07', 'dd-mon-yyyy'), '07-Mar-1996');
  assert.equal(C.formatDate('1996-03-07', 'yyyy.mm.dd'), '1996.03.07');
  assert.equal(C.formatDate('1996-03-07', 'd/m/yy'), '7/3/96');
});

test('option matching', () => {
  const g = opts('-- Select --', 'Male', 'Female', 'Transgender');
  g[0].placeholder = true;
  assert.equal(C.matchOption(g, 'Female').index, 2);
  assert.equal(C.matchOption(opts('M', 'F'), 'Male').index, 0);
  const cat = opts('UR', 'OBC (Non-Creamy Layer)', 'SC', 'ST', 'EWS');
  assert.equal(C.matchOption(cat, 'General').index, 0);
  assert.equal(C.matchOption(cat, 'OBC').index, 1);
  assert.equal(C.matchOption(cat, 'SC').index, 2);
  const blood = opts('A+', 'A-', 'B+', 'O+');
  assert.equal(C.matchOption(blood, 'A-').index, 1);
  assert.equal(C.matchOption(opts('A Positive', 'A Negative'), 'A+').index, 0);
  assert.equal(C.matchOption(opts('01', '02', '03'), '3').index, 2);
  assert.equal(C.matchOption(opts('Jan', 'Feb', 'Mar'), '3', 'month').index, 2);
  assert.equal(C.matchOption(opts('January', 'February', 'March'), '2', 'month').index, 1);
  assert.equal(C.matchOption(opts('Bihar', 'Uttar Pradesh'), 'uttar pradesh').index, 1);
  assert.equal(C.matchOption(opts('Bihar', 'Delhi'), 'Kerala').index, -1);
  assert.ok(C.matchOption(opts('Yes', 'No'), 'No').score >= 0.8);
});

test('upload requirement parsing', () => {
  assert.deepEqual(C.parseUploadRequirements('Photo (JPG, 20 KB to 50 KB, 200x230 px)'), { minKB: 20, maxKB: 50, width: 200, height: 230 });
  assert.deepEqual(C.parseUploadRequirements('Signature max 20kb, 140 x 60 pixels'), { maxKB: 20, width: 140, height: 60 });
  assert.deepEqual(C.parseUploadRequirements('PDF less than 1 MB'), { maxKB: 1024 });
  assert.deepEqual(C.parseUploadRequirements('10-100 KB'), { minKB: 10, maxKB: 100 });
});

test('offline keyword mapping', () => {
  const k = (label, extra = {}) => C.heuristicKey({ label, ...extra });
  assert.equal(k("Father's Name"), 'family.fatherName');
  assert.equal(k('Date of Birth'), 'personal.dob');
  assert.equal(k('Email Address'), 'contact.email');
  assert.equal(k('Mobile No.'), 'contact.mobile');
  assert.equal(k('PIN Code', { section: 'Permanent Address' }), 'permanentAddress.pincode');
  assert.equal(k('District', { section: 'Correspondence Address' }), 'currentAddress.district');
  assert.equal(k('Board', { section: 'Class 10th details' }), 'education.class10.board');
  assert.equal(k('Roll Number', { section: 'Graduation' }), 'education.graduation.rollNo');
  assert.equal(k('Percentage', { section: 'Class XII / Intermediate' }), 'education.class12.percentage');
  assert.equal(k('Category'), 'category.category');
  assert.equal(k('Name of the Candidate'), 'personal.fullName');
  assert.equal(k('Gender'), 'personal.gender');
});
