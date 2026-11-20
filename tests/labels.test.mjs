// Mapping for the labels reported from a real "Fill a PDF" form, plus common variations.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { newProfile, keyCatalog, resolveValue, resolveFirst, addressParts, addressPartsFor } from '../lib/schema.js';
import * as G from '../lib/pdfgeom.js';
const C = createRequire(import.meta.url)('../content/fillcore.js');

const layout = JSON.parse(fs.readFileSync(new URL('./fixtures/labels-layout.json', import.meta.url)));

function profile() {
  const p = newProfile('Test');
  Object.assign(p.personal, { firstName: 'asha', middleName: 'kumari', lastName: 'VERMA', dob: '1996-03-07' });
  Object.assign(p.family, { fatherName: 'ramesh chandra verma', motherName: 'SUNITA VERMA' });
  Object.assign(p.contact, { mobile: '9000000001' });
  // line 1 deliberately empty: the address is in house no. / landmark / locality / city
  Object.assign(p.permanentAddress, { houseNo: '12-b', landmark: 'hanuman mandir', village: 'aliganj', city: 'lucknow', district: 'LUCKNOW', state: 'uttar pradesh', pincode: '226024', country: 'India' });
  Object.assign(p.currentAddress, { sameAsPermanent: false, houseNo: 'Flat 4', line1: 'sector 9', village: 'rohini', city: 'new delhi', district: 'north west delhi', state: 'DELHI', pincode: '110085' });
  return p;
}

test("this PDF's labels map to the right profile keys", () => {
  const got = Object.fromEntries(layout.items.filter((i) => i.kind === 'text' && i.label).map((i) => [i.label, C.labelKey(i.label) || C.heuristicKey({ label: i.label })]));
  assert.equal(got['Full Name'], 'personal.fullName');
  assert.equal(got['Father’s Name'], 'family.fatherName');
  assert.equal(got["Mother's Name"], 'family.motherName');
  assert.equal(got['Permanent Address'], 'permanentAddress.full');
  assert.equal(got['Address for Correspondence'], 'currentAddress.full');
  assert.equal(got['Date of Birth'], 'personal.dob');
  assert.equal(got['Mobile No.'], 'contact.mobile');
});

test('common label variations', () => {
  const cases = {
    'personal.fullName': ['FULL NAME:', '1. Full Name', 'Name in Full', 'Name (in Block Letters)', 'Name of the Applicant', 'Applicant’s Name', 'Candidate Name', 'Your Name', 'Name'],
    'family.fatherName': ['Father Name', 'Fathers Name', 'Name of Father', "Father's / Husband's Name", 'S/o', 'D/O', 'Son of'],
    'family.motherName': ['Mother’s Name', 'Name of Mother', 'Mothers Name'],
    'family.spouseName': ["Husband's Name", 'W/o', 'Spouse Name'],
    'permanentAddress.full': ['Address (Permanent)', 'Permanent Residential Address', 'Home Address', 'Native Address'],
    'currentAddress.full': ['Correspondence Address', 'Present Address', 'Current Address', 'Address for Communication', 'Mailing Address', 'Postal Address', 'Address', 'Complete Address with PIN code']
  };
  for (const [key, labels] of Object.entries(cases)) for (const l of labels) assert.equal(C.labelKey(l), key, l);
  for (const l of ['Same as permanent address', 'Correspondence address same as permanent', 'Same as above']) {
    assert.equal(C.labelKey(l), 'currentAddress.sameAsPermanent', l);
  }
  for (const l of ['E-mail Address', 'Office Address', "Father's Occupation", 'Mother Tongue', 'Name of School', 'Bank Name', 'First Name', 'Surname', 'Nominee Name', 'Address Line 1', 'PIN Code']) {
    assert.notEqual(C.labelKey(l), 'personal.fullName', l);
    assert.ok(!/\.full$/.test(C.labelKey(l) || ''), l);
  }
});

test('AI key names are repaired, not dropped', () => {
  const keys = new Set(keyCatalog(newProfile('x')).map((c) => c.key));
  assert.equal(C.normalizeKey('fullName', keys), 'personal.fullName');
  assert.equal(C.normalizeKey('father_name', keys), 'family.fatherName');
  assert.equal(C.normalizeKey('FatherName', keys), 'family.fatherName');
  assert.equal(C.normalizeKey('currentAddress', keys), 'currentAddress.full');
  assert.equal(C.normalizeKey('permanent_address', keys), 'permanentAddress.full');
  assert.equal(C.normalizeKey('personal.dob', keys), 'personal.dob');
  assert.equal(C.normalizeKey('made.up', keys), null);
});

test('values are built locally and capitalised properly', () => {
  const p = profile();
  assert.equal(resolveValue(p, 'personal.fullName').value, 'Asha Kumari Verma');
  assert.equal(resolveValue(p, 'family.fatherName').value, 'Ramesh Chandra Verma');
  assert.equal(resolveValue(p, 'family.motherName').value, 'Sunita Verma');
  assert.deepEqual(addressParts(p.permanentAddress), ['12-B', 'Near Hanuman Mandir', 'Aliganj', 'Lucknow', 'Uttar Pradesh - 226024']);
  assert.deepEqual(addressPartsFor(p, 'currentAddress'), ['Flat 4, Sector 9', 'Rohini', 'New Delhi', 'Dist. North West Delhi', 'Delhi - 110085']);
  assert.equal(resolveValue(p, 'currentAddress.full').value, 'Flat 4, Sector 9, Rohini, New Delhi, Dist. North West Delhi, Delhi - 110085');
  assert.equal(C.properCase('UNIVERSITY OF LUCKNOW'), 'University of Lucknow');
  assert.equal(C.properCase('UP BOARD'), 'UP Board');
  assert.equal(resolveValue(p, 'contact.mobile').value, '9000000001', 'numbers untouched');
  p.contact.email = 'Asha.Demo@Example.com';
  assert.equal(resolveValue(p, 'contact.email').value, 'Asha.Demo@Example.com', 'e-mail untouched');
});

test('the reported bug: AI picks an empty "address line 1" -> full address is used instead', () => {
  const p = profile();
  assert.equal(resolveValue(p, 'permanentAddress.line1'), null, 'line 1 really is empty');
  const hit = resolveFirst(p, [C.labelKey('Permanent Address'), 'permanentAddress.line1']);
  assert.equal(hit.key, 'permanentAddress.full');
  assert.match(hit.value, /^12-B, Near Hanuman Mandir, Aliganj, Lucknow, Uttar Pradesh - 226024$/);
  // and when only the AI key is known but empty, the keyword guess still finds the address
  const hit2 = resolveFirst(p, ['permanentAddress.line1', C.heuristicKey({ label: 'Address for Correspondence' })]);
  assert.equal(hit2.key, 'currentAddress.full');
});

test('address spread over the printed lines, readable size, commas at line ends', () => {
  const measure = (t, s) => t.length * s * 0.5; // ~Helvetica average
  const widths = [337, 337, 337];
  const r = G.distributeParts(addressPartsFor(profile(), 'permanentAddress'), widths, 11, measure);
  assert.ok(r.size >= 10 && r.size <= 12, `size ${r.size}`);
  assert.equal(r.overflow, false);
  assert.ok(r.lines.length >= 2 && r.lines.length <= 3);
  assert.ok(r.lines.slice(0, -1).every((l) => l.endsWith(',')));
  assert.equal(r.lines.join(' ').replace(/,$/, ''), '12-B, Near Hanuman Mandir, Aliganj, Lucknow, Uttar Pradesh - 226024');
  // a narrow single line forces shrinking, but never below 8 pt, and reports overflow if still too long
  const tight = G.distributeParts(['A very long locality name indeed', 'Another long part'], [60], 11, measure);
  assert.ok(tight.size >= 8 && tight.overflow);
  // a single tall box holds several lines without splitting a piece
  const tall = G.distributeParts(addressPartsFor(profile(), 'currentAddress'), Array(G.lineCapacity(44, 11)).fill(150), 11, measure);
  assert.ok(tall.lines.length >= 2 && tall.lines.every((l) => !/^,/.test(l)));
});
