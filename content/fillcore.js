// Pure helper logic shared by the content script, background worker and Node tests.
// No DOM access and no personal data stored here.
(function (root) {
  'use strict';
  if (root.FFCore) return;

  const humanize = (s) => String(s || '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_\[\].]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const norm = (s) => String(s ?? '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();

  // Keeps + and - so blood groups (A+ / A-) stay distinct.
  const compactSym = (s) => String(s ?? '').toLowerCase()
    .replace(/\bpositive\b|\+ ?ve\b|\bpos\b/g, '+')
    .replace(/\bnegative\b|- ?ve\b|\bneg\b/g, '-')
    .replace(/[^a-z0-9+-]/g, '');

  // ---------------- sensitive fields (never filled, never sent to AI) ----------------
  const SENSITIVE_RE = new RegExp([
    'pass ?word', '\\bpasswd\\b', '\\bpwd\\b', '\\bpass ?code\\b', '\\bpass ?phrase\\b',
    '\\bcvv\\d?\\b', '\\bcvc\\b', '\\bcsc\\b',
    // "card number" is a payment card unless it's an ID card (Aadhaar card number, PAN card no, ...)
    '(?<!(aadha?ar|pan|ration|voter|id|identity|election|health|ayushman|admit|student|employee) )card ?(no|num|number|holder|expiry|exp|verification|security)',
    '\\bcc ?(num|number|no|exp|cvv|csc|name)\\b',
    'credit ?card', 'debit ?card', 'name on (the )?card', '\\biban\\b', '\\bifsc\\b', '\\bswift\\b', '\\bmicr\\b', '\\brouting\\b',
    '\\bbank', 'account ?(no|num|number|holder)', '\\ba ?/ ?c ?(no|number)', '\\bacc ?no\\b',
    '\\botp\\b', 'one ?time', 'verification ?code', 'security ?(code|question|answer)',
    '\\b(m|atm|upi|transaction|login|card|security|secret)[ -]?pin\\b', '\\bmpin\\b', '\\bupi\\b', 'captcha', '\\btan code\\b'
  ].join('|'), 'i');

  function isSensitive(f) {
    const type = String(f.type || '').toLowerCase();
    if (type === 'password') return true;
    const ac = String(f.autocomplete || '').toLowerCase();
    if (/\bcc-|one-time-code|current-password|new-password|transaction-/.test(ac)) return true;
    const text = humanize([f.label, f.name, f.idAttr, f.placeholder, f.aria].filter(Boolean).join(' '));
    return SENSITIVE_RE.test(text);
  }

  // ---------------- dates ----------------
  const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
  const TOKEN = '(dd|d|mmmm|mmm|mon|mm|m|yyyy|yy)';
  const FMT_RE = new RegExp(`\\b${TOKEN}([\\/\\-. ])${TOKEN}\\2${TOKEN}\\b`, 'i');

  /** Find a date format like DD/MM/YYYY in hint text. Returns e.g. "dd/mm/yyyy" or null. */
  function detectDateFormat(text) {
    const m = String(text || '').match(FMT_RE);
    if (!m) return null;
    const parts = [m[1], m[3], m[4]].map((x) => x.toLowerCase());
    const kinds = parts.map((p) => p[0] === 'd' ? 'd' : p[0] === 'y' ? 'y' : 'm');
    if (new Set(kinds).size !== 3) return null;
    return `${parts[0]}${m[2]}${parts[1]}${m[2]}${parts[2]}`;
  }

  /** iso = YYYY-MM-DD, fmt like "dd/mm/yyyy", "mm-dd-yy", "dd-mon-yyyy". */
  function formatDate(iso, fmt) {
    const [y, mo, d] = String(iso).split('-').map(Number);
    if (!y || !mo || !d) return String(iso);
    fmt = (fmt || 'dd/mm/yyyy').toLowerCase();
    const p2 = (n) => String(n).padStart(2, '0');
    return fmt.replace(/yyyy|yy|mmmm|mmm|mon|mm|m|dd|d/g, (t) => {
      switch (t) {
        case 'yyyy': return String(y);
        case 'yy': return String(y).slice(-2);
        case 'mmmm': return cap(MONTHS[mo - 1]);
        case 'mmm': case 'mon': return cap(MONTHS[mo - 1].slice(0, 3));
        case 'mm': return p2(mo);
        case 'm': return String(mo);
        case 'dd': return p2(d);
        case 'd': return String(d);
      }
      return t;
    });
  }
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

  /** Value for an <input type=...> that has a native date/time format. */
  function nativeDateValue(iso, inputType) {
    if (inputType === 'date') return iso;
    if (inputType === 'month') return iso.slice(0, 7);
    if (inputType === 'datetime-local') return iso + 'T00:00';
    return null;
  }

  // ---------------- option matching ----------------
  const SYN = {
    male: ['m', 'man', 'boy', 'purush'],
    female: ['f', 'woman', 'girl', 'mahila'],
    transgender: ['third gender', 'tg', 'other', 'others'],
    other: ['others', 'third gender'],
    general: ['gen', 'ur', 'unreserved', 'open', 'gn', 'general ur', 'oc', 'gen ur'],
    obc: ['other backward class', 'other backward classes', 'bc', 'obc ncl', 'backward class'],
    sc: ['scheduled caste', 'scheduled castes'],
    st: ['scheduled tribe', 'scheduled tribes'],
    ews: ['economically weaker section', 'economically weaker sections', 'gen ews'],
    yes: ['y', 'true'],
    no: ['n', 'false'],
    unmarried: ['single', 'never married', 'not married'],
    widowed: ['widow', 'widower'],
    mr: ['mr', 'shri', 'sri'],
    ms: ['miss', 'kumari'],
    mrs: ['smt', 'shrimati'],
    india: ['ind', 'in', 'bharat'],
    indian: ['india']
  };

  function candidatesFor(value, kind) {
    const v = String(value).trim();
    const out = [{ s: v, w: 1 }];
    const n = norm(v);
    (SYN[n] || []).forEach((s) => out.push({ s, w: 0.95 }));
    if (kind === 'month') {
      const mi = Number(v);
      if (mi >= 1 && mi <= 12) {
        out.push({ s: MONTHS[mi - 1], w: 1 }, { s: MONTHS[mi - 1].slice(0, 3), w: 1 });
      }
    }
    return out;
  }

  /**
   * options: [{text, value}] ; returns {index, score} (index -1 when nothing fits).
   * score 1 = exact; >= 0.8 counts as confident.
   */
  function matchOption(options, value, kind) {
    if (value === undefined || value === null || value === '') return { index: -1, score: 0 };
    const cands = candidatesFor(value, kind);
    let best = { index: -1, score: 0 }, second = 0;
    options.forEach((o, i) => {
      if (o.placeholder) return;
      let s = 0;
      for (const c of cands) s = Math.max(s, scorePair(c.s, o.text, c.w), scorePair(c.s, o.value, c.w * 0.98));
      if (s > best.score) { second = best.score; best = { index: i, score: s }; }
      else if (s > second) second = s;
    });
    if (best.score < 0.6) return { index: -1, score: best.score };
    // Ambiguous partial match: two options look equally good.
    if (best.score < 1 && second >= best.score) best.score = Math.min(best.score, 0.65);
    return best;
  }

  function scorePair(cand, opt, w) {
    if (opt === undefined || opt === null || opt === '') return 0;
    const a = compactSym(cand), b = compactSym(opt);
    if (!a || !b) return 0;
    if (a === b) return w;
    if (/^\d+$/.test(a) && /^\d+$/.test(b)) return Number(a) === Number(b) ? w : 0;
    if (/[+-]$/.test(a) || /[+-]$/.test(b)) return 0; // blood groups etc. must match exactly
    const ta = norm(cand).split(' ').filter(Boolean), tb = norm(opt).split(' ').filter(Boolean);
    if (!ta.length || !tb.length) return 0;
    const setB = new Set(tb), setA = new Set(ta);
    // Option contains all of the value's words, e.g. "OBC" -> "OBC (Non-Creamy Layer)"
    if (ta.join('').length >= 2 && ta.every((t) => setB.has(t))) return 0.85 * w;
    // Value contains all of the option's words, e.g. "B.Sc Physics" -> "B Sc"
    if (tb.join('').length >= 3 && tb.every((t) => setA.has(t))) return 0.7 * w;
    return 0;
  }

  const PLACEHOLDER_OPT = /^(-+|select.*|choose.*|please select.*|--.*|none selected|\s*)$/i;
  function isPlaceholderOption(text, value) {
    return (value === '' || value == null) && PLACEHOLDER_OPT.test(String(text || '').trim())
      || /^-*\s*(select|choose)\b/i.test(String(text || '').trim());
  }

  // ---------------- truthy for checkboxes ----------------
  function toBool(v) {
    if (typeof v === 'boolean') return v;
    const n = norm(v);
    if (['yes', 'y', 'true', '1', 'checked'].includes(n)) return true;
    if (['no', 'n', 'false', '0'].includes(n)) return false;
    return null;
  }

  // ---------------- upload requirements ----------------
  /**
   * Read upload rules from nearby page text (offline, regex based).
   * Returns any of: minKB, maxKB, width, height, minWidth, maxWidth, minHeight, maxHeight,
   * aspect (w/h), format ('jpg'|'png'|'pdf'), kind ('photo'|'signature'|'thumb'|'document').
   * `label` (the field's own label) decides the kind, because nearby text often mentions several uploads.
   */
  function parseUploadRequirements(text, label) {
    const t = String(text || '').toLowerCase().replace(/,/g, '');
    const req = {};
    const sizes = [];
    const re = /(\d+(?:\.\d+)?)\s*(kb|k\.b\.?|kilobytes?|mb|m\.b\.?|megabytes?)\b/g;
    let m;
    while ((m = re.exec(t))) sizes.push(parseFloat(m[1]) * (m[2][0] === 'm' ? 1024 : 1));
    const range = t.match(/(\d+(?:\.\d+)?)\s*(kb|mb)?\s*(?:-|to|–|and)\s*(\d+(?:\.\d+)?)\s*(kb|mb)\b/);
    if (range) {
      const u1 = range[2] || range[4];
      const a = parseFloat(range[1]) * (u1 === 'mb' ? 1024 : 1);
      const b = parseFloat(range[3]) * (range[4] === 'mb' ? 1024 : 1);
      req.minKB = Math.min(a, b); req.maxKB = Math.max(a, b);
    } else if (sizes.length >= 2) {
      req.minKB = Math.min(...sizes); req.maxKB = Math.max(...sizes);
    } else if (sizes.length === 1) {
      req.maxKB = sizes[0];
    }
    const PX = '(\\d{2,4})\\s*(?:px|pixels?)?\\s*[x×*]\\s*(\\d{2,4})\\s*(?:px|pixels?)?';
    const pxRange = t.match(new RegExp(`${PX}\\s*(?:-|to|–)\\s*${PX}`));
    const dim = t.match(new RegExp(PX));
    const cm = t.match(/(\d+(?:\.\d+)?)\s*(cm|mm)\s*(?:\(?\s*(?:w|width)\s*\)?)?\s*[x×*]\s*(\d+(?:\.\d+)?)\s*(cm|mm)/);
    if (pxRange) {
      const [w1, h1, w2, h2] = [pxRange[1], pxRange[2], pxRange[3], pxRange[4]].map(Number);
      Object.assign(req, { minWidth: Math.min(w1, w2), maxWidth: Math.max(w1, w2), minHeight: Math.min(h1, h2), maxHeight: Math.max(h1, h2) });
    } else if (dim) {
      req.width = Number(dim[1]); req.height = Number(dim[2]);
    } else if (cm) {
      // Physical size only: keep the shape; use 100 px per cm as the pixel target (≈254 dpi).
      const f = (v, u) => parseFloat(v) * (u === 'mm' ? 0.1 : 1);
      const wcm = f(cm[1], cm[2]), hcm = f(cm[3], cm[4]);
      req.aspect = wcm / hcm;
      req.width = Math.round(wcm * 100); req.height = Math.round(hcm * 100);
      req.fromCm = true;
    } else {
      const w = t.match(/width\D{0,12}(\d{2,4})/), h = t.match(/height\D{0,12}(\d{2,4})/);
      if (w) req.width = Number(w[1]);
      if (h) req.height = Number(h[1]);
    }
    if (/\bjpe?g\b|\.jpe?g|image\/jpeg/.test(t)) req.format = 'jpg';
    else if (/\bpng\b|image\/png/.test(t)) req.format = 'png';
    else if (/\bpdf\b/.test(t)) req.format = 'pdf';
    const k = String(label || text || '').toLowerCase();
    if (/signature|\bsign\b/.test(k)) req.kind = 'signature';
    else if (/thumb/.test(k)) req.kind = 'thumb';
    else if (/photo|photograph|picture|selfie/.test(k)) req.kind = 'photo';
    else if (/certificate|marksheet|mark sheet|document|proof|pdf/.test(k)) req.kind = 'document';
    return req;
  }

  // ---------------- offline keyword mapper (used when no API key / AI fails) ----------------
  const EDU = [
    [/post ?grad|\bmaster|\bm\.? ?(a|sc|com|tech|e)\b|\bpg\b|\bmba\b|\bmca\b/, 'postGraduation'],
    [/ph\.? ?d|doctor(ate|al)/, 'phd'],
    [/\b(12|xii)(th)?\b|intermediate|\bhsc\b|senior secondary|higher secondary|\bplus two\b/, 'class12'],
    [/\b(10|x)(th)?\b|matric|\bssc\b|high school|\bsecondary\b/, 'class10'],
    [/diploma|\biti\b|polytechnic/, 'diploma'],
    [/graduat|bachelor|\bb\.? ?(a|sc|com|tech|e)\b|\bug\b|degree/, 'graduation']
  ];
  const EDU_FIELD = [
    [/roll/, 'rollNo'], [/board|universit/, 'board'], [/percent|%/, 'percentage'], [/cgpa|gpa|grade/, 'cgpa'],
    [/obtain/, 'marksObtained'], [/max|total marks|full marks|out of/, 'maxMarks'], [/year|passing/, 'year'],
    [/school|college|institut/, 'institute'], [/subject|stream|special|discipline|branch/, 'stream'],
    [/division|class obtained/, 'division'], [/mode/, 'mode'], [/qualification|degree|course|exam/, 'qualification']
  ];
  const ADDR_FIELD = [
    [/pin ?code|postal ?code|\bzip\b|\bpin\b/, 'pincode'], [/district/, 'district'], [/\bstate\b/, 'state'],
    [/country/, 'country'], [/landmark/, 'landmark'], [/post ?office|\bp\.? ?o\b/, 'postOffice'],
    [/police|\bp\.? ?s\b|thana/, 'policeStation'], [/tehsil|taluk|block|mandal/, 'tehsil'],
    [/village|locality/, 'village'], [/city|town/, 'city'], [/house|flat|building|door/, 'houseNo'],
    [/line ?2|address ?2/, 'line2'], [/address|street|line ?1/, 'line1']
  ];

  function heuristicKey(f) {
    const label = humanize([f.label, f.placeholder, f.name, f.idAttr].filter(Boolean).join(' ')).toLowerCase();
    const ctx = (label + ' ' + humanize(f.section).toLowerCase()).trim();
    const own = label;
    const first = (rules, s) => { for (const [re, k] of rules) if (re.test(s)) return k; return null; };
    const isDob = /birth|\bdob\b/.test(own);
    const hasFullFormat = !!detectDateFormat(own) || f.type === 'date';

    if (isDob && !/place/.test(own) && hasFullFormat) return 'personal.dob';
    if (isDob && /\bday\b|\bdd\b/.test(own)) return 'personal.dobDay';
    if (isDob && /\bmonth\b|\bmm\b/.test(own)) return 'personal.dobMonth';
    if (isDob && /\byear\b|\byyyy\b/.test(own)) return 'personal.dobYear';
    if (isDob && !/place/.test(own)) return 'personal.dob';
    if (/place of birth|birth ?place/.test(own)) return 'personal.placeOfBirth';
    if (/father|\bs ?\/ ?o\b/.test(own)) return /occupation/.test(own) ? 'family.fatherOccupation' : 'family.fatherName';
    if (/mother tongue/.test(own)) return 'personal.motherTongue';
    if (/mother/.test(own)) return /occupation/.test(own) ? 'family.motherOccupation' : 'family.motherName';
    if (/spouse|husband|wife/.test(own)) return /occupation/.test(own) ? 'family.spouseOccupation' : 'family.spouseName';
    if (/guardian/.test(own)) return /relation/.test(own) ? 'family.guardianRelation' : 'family.guardianName';
    if (/family income|annual income|income/.test(own)) return 'family.annualFamilyIncome';
    if (/same as permanent|same as above/.test(own)) return 'currentAddress.sameAsPermanent';
    if (/certificate/.test(ctx) && /\bdate\b/.test(own) && /categor|caste|obc|ews|\bsc\b|\bst\b/.test(ctx)) return 'category.certificateDate';
    if (/working since|joining|date of appointment|employed since|\bfrom\b.*\bdate\b|\bdate\b.*\bfrom\b/.test(own)) return 'work.current.from';

    const level = first(EDU, ctx);
    if (level && (/qualif|education|exam|board|universit|roll|passing|percent|marks|cgpa|school|college|subject|stream|division/.test(ctx))) {
      const fk = first(EDU_FIELD, own);
      if (fk) return `education.${level}.${fk}`;
    }

    if (/name/.test(own) && /hindi|devanagari|regional|vernacular|local language|in your mother tongue/.test(own)) return 'personal.nameHindi';
    if (/first ?name|given ?name|\bfname\b/.test(own)) return 'personal.firstName';
    if (/middle ?name/.test(own)) return 'personal.middleName';
    if (/last ?name|surname|family ?name|\blname\b/.test(own)) return 'personal.lastName';
    if (/gender|\bsex\b/.test(own)) return 'personal.gender';
    if (/marital/.test(own)) return 'personal.maritalStatus';
    if (/nationality/.test(own)) return 'personal.nationality';
    if (/religion/.test(own)) return 'personal.religion';
    if (/blood/.test(own)) return 'personal.bloodGroup';
    if (/aadha?ar|\buid\b/.test(own)) return 'personal.aadhaar';
    if (/\bpan\b/.test(own)) return 'personal.pan';
    if (/passport/.test(own)) return 'personal.passport';
    if (/identification mark/.test(own)) return 'personal.identificationMark';
    if (/\bage\b/.test(own)) return 'personal.age';
    if (/salutation|\btitle\b|prefix/.test(own)) return 'personal.salutation';
    if (/e ?-? ?mail/.test(own)) return /alt|alternate|secondary|other/.test(own) ? 'contact.altEmail' : 'contact.email';
    if (/mobile|phone|contact (no|number)|\bcell\b|whats ?app/.test(own)) {
      if (/emergency/.test(own)) return 'contact.emergencyContactPhone';
      if (/landline|std/.test(own)) return 'contact.landline';
      return /alt|alternate|secondary|other/.test(own) ? 'contact.altMobile' : 'contact.mobile';
    }
    if (/domicile/.test(own)) return 'category.domicileState';
    if (/disab|\bpw ?b?d\b|handicap/.test(own)) return /type/.test(own) ? 'category.disabilityType' : 'category.pwd';
    if (/ex ?-? ?service/.test(own)) return 'category.exServiceman';
    if (/minority/.test(own)) return 'category.minority';
    if (/categor|reservation|\bcaste\b/.test(own)) return /certificate/.test(own) ? 'category.certificateNo' : 'category.category';

    const addrField = first(ADDR_FIELD, own);
    if (addrField) {
      const cur = /current|present|correspond|communication|mailing|postal address|residential/.test(ctx);
      const prefix = cur ? 'currentAddress' : 'permanentAddress';
      const bare = own.replace(/\b(permanent|current|present|correspondence|communication|postal|mailing|residential|full|complete)\b/g, '').trim();
      if (addrField === 'line1' && (f.tag === 'textarea' || /^address( for (correspondence|communication))?$/.test(bare))) return `${prefix}.full`;
      return `${prefix}.${addrField}`;
    }
    if (/^place$/.test(own.trim())) return 'currentAddress.city';
    if (/experience/.test(own)) return /month/.test(own) ? 'experience.totalMonths' : 'experience.totalYears';
    if (/employer|organi[sz]ation|company/.test(own)) return 'work.current.employer';
    if (/designation|post held/.test(own)) return 'work.current.designation';
    if (/full ?name|^name$|candidate'?s? name|applicant'?s? name|your name|name of (the )?(candidate|applicant)|^name\b/.test(own)) return 'personal.fullName';
    return null;
  }

  const api = {
    humanize, norm, isSensitive, detectDateFormat, formatDate, nativeDateValue,
    matchOption, isPlaceholderOption, toBool, parseUploadRequirements, heuristicKey, MONTHS
  };
  root.FFCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
