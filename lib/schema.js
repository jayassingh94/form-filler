import '../content/fillcore.js'; // provides globalThis.FFCore (properCase)
const FF = () => globalThis.FFCore;

// Profile schema. Keys are fixed and generic, so the list of keys sent to the AI
// reveals nothing about you. Values never leave the device.

const opt = (...xs) => xs;

const EDU_FIELDS = [
  { k: 'qualification', l: 'Degree / qualification name (e.g. B.Sc, Secondary)' },
  { k: 'stream', l: 'Subject / stream / specialisation' },
  { k: 'board', l: 'Board / University' },
  { k: 'institute', l: 'School / College / Institute' },
  { k: 'rollNo', l: 'Roll number' },
  { k: 'year', l: 'Year of passing' },
  { k: 'marksObtained', l: 'Marks obtained' },
  { k: 'maxMarks', l: 'Maximum marks' },
  { k: 'percentage', l: 'Percentage (%)' },
  { k: 'cgpa', l: 'CGPA / Grade' },
  { k: 'division', l: 'Division / Class' },
  { k: 'mode', l: 'Mode (Regular / Distance)' }
];

const EDU_LEVELS = [
  ['class10', 'Class 10 / Matriculation / SSC'],
  ['class12', 'Class 12 / Intermediate / HSC'],
  ['diploma', 'Diploma / ITI'],
  ['graduation', 'Graduation / Bachelor degree'],
  ['postGraduation', 'Post-graduation / Master degree'],
  ['phd', 'PhD / Doctorate'],
  ['other', 'Other qualification (e.g. B.Ed, certification)']
];

const WORK_FIELDS = [
  { k: 'employer', l: 'Employer / organisation' },
  { k: 'designation', l: 'Designation / post' },
  { k: 'from', l: 'From date', t: 'date' },
  { k: 'to', l: 'To date (blank if current)', t: 'date' },
  { k: 'location', l: 'Location' },
  { k: 'salary', l: 'Salary / pay' },
  { k: 'employmentType', l: 'Type (Govt / Private / Contract)' },
  { k: 'duties', l: 'Nature of duties', t: 'textarea' }
];

const WORK_SLOTS = [
  ['current', 'Current / latest job'],
  ['previous1', 'Previous job 1'],
  ['previous2', 'Previous job 2']
];

const ADDRESS_FIELDS = [
  { k: 'houseNo', l: 'House / Flat no.' },
  { k: 'line1', l: 'Address line 1 (street / area)' },
  { k: 'line2', l: 'Address line 2' },
  { k: 'landmark', l: 'Landmark' },
  { k: 'village', l: 'Village / Town / Locality' },
  { k: 'postOffice', l: 'Post office' },
  { k: 'policeStation', l: 'Police station' },
  { k: 'tehsil', l: 'Tehsil / Taluka / Block' },
  { k: 'city', l: 'City' },
  { k: 'district', l: 'District' },
  { k: 'state', l: 'State' },
  { k: 'pincode', l: 'PIN code / ZIP' },
  { k: 'country', l: 'Country' }
];

export const SCHEMA = [
  {
    id: 'personal', title: 'Personal information',
    fields: [
      { k: 'salutation', l: 'Title (Mr / Ms / Mrs / Dr)', t: 'select', o: opt('', 'Mr', 'Ms', 'Mrs', 'Miss', 'Dr') },
      { k: 'firstName', l: 'First name' },
      { k: 'middleName', l: 'Middle name' },
      { k: 'lastName', l: 'Last name / Surname' },
      { k: 'fullName', l: 'Full name (leave blank to auto-join)' },
      { k: 'nameHindi', l: 'Name in Hindi / regional language' },
      { k: 'gender', l: 'Gender', t: 'select', o: opt('', 'Male', 'Female', 'Transgender', 'Other') },
      { k: 'dob', l: 'Date of birth', t: 'date' },
      { k: 'placeOfBirth', l: 'Place of birth' },
      { k: 'maritalStatus', l: 'Marital status', t: 'select', o: opt('', 'Unmarried', 'Married', 'Divorced', 'Widowed', 'Separated') },
      { k: 'nationality', l: 'Nationality' },
      { k: 'religion', l: 'Religion' },
      { k: 'motherTongue', l: 'Mother tongue' },
      { k: 'bloodGroup', l: 'Blood group', t: 'select', o: opt('', 'A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-') },
      { k: 'heightCm', l: 'Height (cm)' },
      { k: 'weightKg', l: 'Weight (kg)' },
      { k: 'identificationMark', l: 'Identification mark' },
      { k: 'aadhaar', l: 'Aadhaar number' },
      { k: 'pan', l: 'PAN' },
      { k: 'passport', l: 'Passport number' },
      { k: 'voterId', l: 'Voter ID' },
      { k: 'drivingLicence', l: 'Driving licence number' }
    ]
  },
  {
    id: 'family', title: 'Family details',
    fields: [
      { k: 'fatherName', l: "Father's name" },
      { k: 'fatherOccupation', l: "Father's occupation" },
      { k: 'motherName', l: "Mother's name" },
      { k: 'motherOccupation', l: "Mother's occupation" },
      { k: 'spouseName', l: "Spouse's name" },
      { k: 'spouseOccupation', l: "Spouse's occupation" },
      { k: 'guardianName', l: "Guardian's name" },
      { k: 'guardianRelation', l: 'Relation with guardian' },
      { k: 'annualFamilyIncome', l: 'Annual family income' },
      { k: 'numberOfChildren', l: 'Number of children' }
    ]
  },
  {
    id: 'contact', title: 'Contact',
    fields: [
      { k: 'email', l: 'Email', t: 'email' },
      { k: 'altEmail', l: 'Alternate email', t: 'email' },
      { k: 'countryCode', l: 'Country calling code (e.g. +91)' },
      { k: 'mobile', l: 'Mobile number', t: 'tel' },
      { k: 'altMobile', l: 'Alternate mobile', t: 'tel' },
      { k: 'landline', l: 'Landline (with STD code)', t: 'tel' },
      { k: 'emergencyContactName', l: 'Emergency contact name' },
      { k: 'emergencyContactPhone', l: 'Emergency contact phone', t: 'tel' }
    ]
  },
  { id: 'permanentAddress', title: 'Permanent address', fields: ADDRESS_FIELDS },
  {
    id: 'currentAddress', title: 'Current / correspondence address',
    fields: [{ k: 'sameAsPermanent', l: 'Same as permanent address', t: 'checkbox' }, ...ADDRESS_FIELDS]
  },
  {
    id: 'category', title: 'Category & reservation',
    fields: [
      { k: 'category', l: 'Category', t: 'select', o: opt('', 'General', 'OBC', 'SC', 'ST', 'EWS') },
      { k: 'obcType', l: 'OBC type (Creamy / Non-creamy layer)' },
      { k: 'caste', l: 'Caste / sub-caste' },
      { k: 'certificateNo', l: 'Category certificate number' },
      { k: 'certificateDate', l: 'Category certificate issue date', t: 'date' },
      { k: 'certificateAuthority', l: 'Certificate issuing authority' },
      { k: 'domicileState', l: 'Domicile state' },
      { k: 'pwd', l: 'Person with disability (PwD)', t: 'select', o: opt('', 'No', 'Yes') },
      { k: 'disabilityType', l: 'Type of disability' },
      { k: 'disabilityPercent', l: 'Disability %' },
      { k: 'exServiceman', l: 'Ex-serviceman', t: 'select', o: opt('', 'No', 'Yes') },
      { k: 'minority', l: 'Minority', t: 'select', o: opt('', 'No', 'Yes') }
    ]
  },
  ...EDU_LEVELS.map(([id, title]) => ({ id: `education.${id}`, title: `Education: ${title}`, group: 'education', fields: EDU_FIELDS })),
  {
    id: 'experience', title: 'Work experience (summary)',
    fields: [
      { k: 'totalYears', l: 'Total experience (years)' },
      { k: 'totalMonths', l: 'Total experience (extra months)' }
    ]
  },
  ...WORK_SLOTS.map(([id, title]) => ({ id: `work.${id}`, title: `Work: ${title}`, group: 'work', fields: WORK_FIELDS }))
];

export function newProfile(label) {
  const p = { id: crypto.randomUUID(), label, custom: [] };
  for (const sec of SCHEMA) {
    const obj = {};
    for (const f of sec.fields) obj[f.k] = f.t === 'checkbox' ? false : '';
    setPath(p, sec.id, obj);
  }
  return p;
}

export function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

export function setPath(obj, path, val) {
  const parts = path.split('.');
  let o = obj;
  for (let i = 0; i < parts.length - 1; i++) o = o[parts[i]] ??= {};
  o[parts[parts.length - 1]] = val;
}

// Keys computed from other values.
const DERIVED = [
  ['personal.dobDay', 'Day of birth (1-31), for split date fields'],
  ['personal.dobMonth', 'Month of birth (1-12 / name), for split date fields'],
  ['personal.dobYear', 'Year of birth, for split date fields'],
  ['personal.age', 'Age in completed years (today)'],
  ['contact.mobileWithCode', 'Mobile number with country code'],
  ['permanentAddress.full', 'Permanent address as one line / textarea'],
  ['currentAddress.full', 'Current/correspondence address as one line / textarea']
];

/** Generic key catalogue for the AI. Contains key names and descriptions only, never values. */
export function keyCatalog(profile) {
  const out = [];
  for (const sec of SCHEMA) {
    for (const f of sec.fields) {
      if (f.t === 'checkbox') continue;
      out.push({ key: `${sec.id}.${f.k}`, desc: `${sec.title} - ${f.l}`, ...(f.t === 'date' ? { date: true } : {}) });
    }
  }
  out.push({ key: 'currentAddress.sameAsPermanent', desc: 'Checkbox: current address same as permanent', bool: true });
  for (const [key, desc] of DERIVED) out.push({ key, desc });
  (profile?.custom || []).forEach((c, i) => {
    if (c.label) out.push({ key: `custom.${i}`, desc: `Custom field: ${String(c.label).slice(0, 80)}` });
  });
  return out;
}

const DATE_KEYS = new Set(
  SCHEMA.flatMap((s) => s.fields.filter((f) => f.t === 'date').map((f) => `${s.id}.${f.k}`))
);

function isEmpty(v) {
  return v === undefined || v === null || v === '';
}

function joinName(p) {
  // capitalise each part on its own, so "asha" + "VERMA" -> "Asha Verma"
  return [p.personal?.firstName, p.personal?.middleName, p.personal?.lastName]
    .map((x) => String(x || '').trim()).filter(Boolean).map((x) => FF().properCase(x)).join(' ');
}

/**
 * Neat address pieces in reading order, e.g.
 * ["12, Gandhi Marg", "Near Hanuman Mandir", "Aliganj", "Lucknow", "Uttar Pradesh - 226024"].
 * Empty parts are skipped, the district only appears when it differs from the city, India is implied.
 */
export function addressParts(a) {
  if (!a) return [];
  const pc = (x) => FF().properCase(String(x || '').trim());
  const t = (x) => String(x || '').trim();
  const street = [t(a.houseNo), t(a.line1)].filter(Boolean).map(pc).join(', ');
  const landmark = t(a.landmark) ? (/^near\b/i.test(t(a.landmark)) ? pc(a.landmark) : `Near ${pc(a.landmark)}`) : '';
  const city = pc(a.city), district = pc(a.district);
  const stateLine = [pc(a.state), t(a.pincode)].filter(Boolean).join(' - ');
  const country = t(a.country) && !/^(india|bharat)$/i.test(t(a.country)) ? pc(a.country) : '';
  return [
    street, pc(a.line2), landmark, pc(a.village),
    t(a.postOffice) && `PO ${pc(a.postOffice)}`, t(a.policeStation) && `PS ${pc(a.policeStation)}`, pc(a.tehsil),
    city, district && district.toLowerCase() !== city.toLowerCase() ? `Dist. ${district}` : '',
    stateLine, country
  ].filter(Boolean);
}

function addressLine(a) {
  return addressParts(a).join(', ');
}

/** Address pieces for permanentAddress / currentAddress (current = permanent when "same as" is ticked). */
export function addressPartsFor(profile, which) {
  const same = !!profile?.currentAddress?.sameAsPermanent;
  return addressParts(which === 'currentAddress' && same ? profile.permanentAddress : profile?.[which]);
}

// Text values written with proper capitals ("asha verma" -> "Asha Verma"); IDs, e-mails, codes, dates are left alone.
const PROPER_CASE_KEY = /^(personal\.(firstName|middleName|lastName|fullName|placeOfBirth|nationality|religion|motherTongue)|family\.\w*(Name|Occupation|Relation)|contact\.emergencyContactName|(permanentAddress|currentAddress)\.(houseNo|line1|line2|landmark|village|postOffice|policeStation|tehsil|city|district|state|country)|category\.(caste|domicileState|certificateAuthority|disabilityType)|education\.\w+\.(board|institute|stream|qualification|division|mode)|work\.\w+\.(employer|designation|location|employmentType))$/;

/** First candidate key that has a value: [{key, value, kind}] or null. */
export function resolveFirst(profile, keys) {
  for (const key of [...new Set(keys.filter(Boolean))]) {
    const v = resolveValue(profile, key);
    if (v && v.value !== '' && v.value !== null) return { key, ...v };
  }
  return null;
}

export function ageOn(dob, today = new Date()) {
  const [y, m, d] = String(dob).split('-').map(Number);
  if (!y || !m || !d) return '';
  let age = today.getFullYear() - y;
  if (today.getMonth() + 1 < m || (today.getMonth() + 1 === m && today.getDate() < d)) age--;
  return String(age);
}

/**
 * Resolve a key to a value for filling.
 * Returns {value, kind} where kind is 'date' (value = YYYY-MM-DD), 'month', 'bool' or 'text';
 * or null when there is nothing to fill.
 */
export function resolveValue(profile, key) {
  if (!profile || !key) return null;
  const p = profile;
  const cur = p.currentAddress || {};
  const same = !!cur.sameAsPermanent;

  if (key.startsWith('custom.')) {
    const c = p.custom?.[Number(key.slice(7))];
    return c && !isEmpty(c.value) ? { value: String(c.value), kind: 'text' } : null;
  }

  const dob = p.personal?.dob || '';
  const [dy, dm, dd] = dob.split('-');
  switch (key) {
    case 'personal.fullName': {
      const v = p.personal?.fullName ? FF().properCase(p.personal.fullName.trim()) : joinName(p);
      return v ? { value: v, kind: 'text' } : null;
    }
    case 'personal.dobDay': return dd ? { value: String(Number(dd)), kind: 'text' } : null;
    case 'personal.dobMonth': return dm ? { value: String(Number(dm)), kind: 'month' } : null;
    case 'personal.dobYear': return dy ? { value: dy, kind: 'text' } : null;
    case 'personal.age': return dob ? { value: ageOn(dob), kind: 'text' } : null;
    case 'contact.mobileWithCode': {
      const m = p.contact?.mobile;
      if (!m) return null;
      const cc = p.contact?.countryCode || '';
      return { value: cc ? `${cc.startsWith('+') ? cc : '+' + cc} ${m}` : m, kind: 'text' };
    }
    case 'permanentAddress.full': {
      const v = addressLine(p.permanentAddress);
      return v ? { value: v, kind: 'text' } : null;
    }
    case 'currentAddress.full': {
      const v = addressLine(same ? p.permanentAddress : cur);
      return v ? { value: v, kind: 'text' } : null;
    }
    case 'currentAddress.sameAsPermanent':
      return { value: same, kind: 'bool' };
  }

  if (key.startsWith('currentAddress.') && same) {
    key = 'permanentAddress.' + key.slice('currentAddress.'.length);
  }

  let v = getPath(p, key);
  if (isEmpty(v) && /^education\.\w+\.percentage$/.test(key)) {
    const base = key.replace(/\.percentage$/, '');
    const got = parseFloat(getPath(p, base + '.marksObtained'));
    const max = parseFloat(getPath(p, base + '.maxMarks'));
    if (got > 0 && max > 0) v = (Math.round((got / max) * 10000) / 100).toString();
  }
  if (isEmpty(v) || typeof v === 'object') return null;
  if (typeof v === 'boolean') return { value: v, kind: 'bool' };
  if (PROPER_CASE_KEY.test(key)) v = FF().properCase(String(v).trim());
  return { value: String(v), kind: DATE_KEYS.has(key) ? 'date' : 'text' };
}
