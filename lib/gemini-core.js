// Shared Gemini logic for the extension (own-key mode) and the Form Filler server.
// Pure ES module: no DOM, no chrome.*, works in browsers and Node 20+.
//
// Only three kinds of requests exist ("tasks"), and the prompt is always built here from structured input,
// so neither the extension nor anyone calling the server can send free-form prompts:
//   map   – web/PDF form field descriptions (labels, placeholders, option texts) + generic profile key names
//   flat  – one image of a BLANK form page + generic profile key names
//   rules – short snippets of a web page's own text about upload sizes + the upload field's label
//   ping  – connection test
// Profile values are never part of any task.

export const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';
export const DEFAULT_MODEL = 'gemini-3.5-flash-lite';
export const FALLBACK_MODEL = 'gemini-3.6-flash';
export const MAX_RETRIES = 3;
const RETRY_WAITS_MS = [1000, 2000, 4000];
const MAX_WAIT_MS = 10000;
/** One Gemini request may take this long before it is abandoned. */
export const REQUEST_TIMEOUT_MS = 40000;
/** All retries and the fallback together stop after this long. */
export const CALL_DEADLINE_MS = 60000;
export const MAX_FIELDS_PER_CALL = 120;

// ---------------- limits on what a request may contain ----------------
export const LIMITS = {
  fields: 150, labelLen: 200, optionCount: 60, optionLen: 60,
  keys: 400, keyLen: 80, keyDescLen: 160,
  imageBytes: 4 * 1024 * 1024, // decoded JPEG/PNG
  snippets: 30, snippetLen: 300, snippetsTotal: 4000
};

/** Mask things that look personal (defence in depth; the extension already never sends values). */
export function redact(s) {
  return String(s ?? '')
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[email]')
    .replace(/(\+?\d[\d\s-]{8,}\d)/g, (m) => (m.replace(/\D/g, '').length >= 8 ? '[number]' : m))
    .replace(/\b\d{6,}\b/g, '[number]');
}

const isStr = (v) => typeof v === 'string';
const clip = (v, n) => redact(String(v ?? '').replace(/\s+/g, ' ').trim()).slice(0, n);

function bad(msg) { const e = new Error(msg); e.status = 400; e.code = 'bad_request'; return e; }

/** Check and clean a task's input. Returns a safe copy or throws (status 400). */
export function validateTask(task, payload) {
  const p = payload || {};
  const keysOf = (keys) => {
    if (!Array.isArray(keys) || keys.length > LIMITS.keys) throw bad('keys: expected a list');
    return keys.map((k) => {
      if (!k || !isStr(k.key) || !/^[A-Za-z0-9_.]{1,80}$/.test(k.key)) throw bad('keys: invalid key name');
      return { key: k.key, desc: clip(k.desc, LIMITS.keyDescLen) };
    });
  };
  switch (task) {
    case 'ping': return {};
    case 'map': {
      if (!Array.isArray(p.fields) || !p.fields.length || p.fields.length > LIMITS.fields) throw bad(`fields: 1–${LIMITS.fields} expected`);
      const fields = p.fields.map((f, n) => {
        const d = { i: Number.isInteger(f?.i) ? f.i : n };
        for (const k of ['label', 'section', 'placeholder', 'name', 'type']) if (isStr(f?.[k]) && f[k].trim()) d[k] = clip(f[k], LIMITS.labelLen);
        if (Array.isArray(f?.options)) d.options = f.options.slice(0, LIMITS.optionCount).map((o) => clip(o, LIMITS.optionLen));
        // nothing else (in particular no "value") is passed on
        return d;
      });
      return { fields, keys: keysOf(p.keys) };
    }
    case 'flat': {
      const mime = p.mimeType === 'image/png' ? 'image/png' : 'image/jpeg';
      if (!isStr(p.image) || !/^[A-Za-z0-9+/]+=*$/.test(p.image)) throw bad('image: base64 expected');
      if ((p.image.length * 3) / 4 > LIMITS.imageBytes) throw bad('image: too large');
      return { image: p.image, mimeType: mime, keys: keysOf(p.keys) };
    }
    case 'rules': {
      if (!Array.isArray(p.snippets) || p.snippets.length > LIMITS.snippets) throw bad('snippets: list expected');
      let total = 0;
      const snippets = [];
      for (const s of p.snippets) {
        const c = clip(s, LIMITS.snippetLen);
        if (!c || total + c.length > LIMITS.snippetsTotal) continue;
        snippets.push(c); total += c.length;
      }
      return { label: clip(p.label || 'upload', 120), accept: clip(p.accept, 80), snippets };
    }
    default: throw bad('unknown task');
  }
}

// ---------------- prompts ----------------
const SYSTEM_MAP = `You map web form fields to keys of a personal profile.
You receive FIELDS (from a web form) and KEYS (available profile keys with descriptions).
For every field, return the single best key, or null if no key fits or the field should be left alone
(e.g. search boxes, declarations/consent checkboxes, captcha, login, payment fields).
Rules:
- Use the field's section/heading to disambiguate (e.g. "Board" under "Class 12" -> education.class12.board;
  "City" under "Correspondence address" -> currentAddress.city).
- For a full-name field use personal.fullName; separate first/middle/last fields use their own keys.
- Split date-of-birth fields (day / month / year dropdowns or boxes) use personal.dobDay / dobMonth / dobYear.
- A single textarea for a whole address uses permanentAddress.full or currentAddress.full.
- A checkbox like "Correspondence address same as permanent" uses currentAddress.sameAsPermanent.
- confidence "high" only when the field clearly asks for exactly that key; otherwise "low".
- If the field shows a date format (e.g. DD/MM/YYYY, dd-mon-yyyy) put it in dateFormat, else omit.
Return JSON only.`;

const MAP_SCHEMA = {
  type: 'OBJECT',
  properties: {
    mappings: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          i: { type: 'INTEGER' },
          key: { type: 'STRING', nullable: true },
          confidence: { type: 'STRING', enum: ['high', 'low'] },
          dateFormat: { type: 'STRING', nullable: true }
        },
        required: ['i', 'key', 'confidence']
      }
    }
  },
  required: ['mappings']
};

const SYSTEM_FLAT = `You are looking at ONE page of a printed application form (it may be a scan or photo).
Find every place where the applicant is expected to write or tick something.
For each place return:
- label: the printed label/question it belongs to (e.g. "Father's Name", "Sex"). For table cells use "<row header> - <column header>", e.g. "10th - Board/University".
- kind: "text" for a blank line, empty box or empty table cell; "checkbox" for a small square/circle to tick next to an option;
  "skip" for photo, signature, thumb impression, "for office use only" areas, and payment/bank/card/OTP/password fields.
- option: for a checkbox, the option text printed next to that box (e.g. "Male", "OBC"); otherwise omit.
- box_2d: [ymin, xmin, ymax, xmax] normalised to 0-1000 covering ONLY the empty writing area, never the label text.
  For a ruled line, span from the line's start to its end, with the top about one text-line above the line.
  For a row of character boxes, cover all the boxes. For a checkbox, the small square itself.
- cells: number of separate character boxes if the answer is written one character per box, else 0.
- uppercase: true if the form asks for CAPITAL/BLOCK letters or uses character boxes.
- key: the best profile key from KEYS, or null. Every checkbox in one group uses the group's key (e.g. personal.gender for Male/Female/Other).
- dateFormat: the date format if one is printed (e.g. DD/MM/YYYY), else omit.
- confidence: "high" only when label and key clearly match, else "low".
Skip places that are already filled in. Return JSON only.`;

const FLAT_SCHEMA = {
  type: 'OBJECT',
  properties: {
    items: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          label: { type: 'STRING' },
          kind: { type: 'STRING', enum: ['text', 'checkbox', 'skip'] },
          option: { type: 'STRING', nullable: true },
          box_2d: { type: 'ARRAY', items: { type: 'INTEGER' } },
          cells: { type: 'INTEGER', nullable: true },
          uppercase: { type: 'BOOLEAN', nullable: true },
          key: { type: 'STRING', nullable: true },
          dateFormat: { type: 'STRING', nullable: true },
          confidence: { type: 'STRING', enum: ['high', 'low'] }
        },
        required: ['label', 'kind', 'box_2d', 'confidence']
      }
    }
  },
  required: ['items']
};

const SYSTEM_RULES = `You read the instructions on an online application form and extract the upload rules
for ONE upload field (named in FIELD). Use only what the text says; never guess. Return JSON with any of:
kind ("photo" | "signature" | "thumb" | "document"), minKB, maxKB (numbers in KB; convert MB to KB),
width, height (exact pixels), minWidth, maxWidth, minHeight, maxHeight (pixel ranges),
widthCm, heightCm (if only a physical size is given; convert mm to cm),
format ("jpg" | "png" | "pdf"), background (e.g. "white"), notes (one short sentence of other important rules),
found (true if the text contains rules for this field).
If the text has rules for several uploads (photo, signature, thumb), return only those for FIELD.`;

const RULES_SCHEMA = {
  type: 'OBJECT',
  properties: {
    found: { type: 'BOOLEAN' },
    kind: { type: 'STRING', enum: ['photo', 'signature', 'thumb', 'document'], nullable: true },
    minKB: { type: 'NUMBER', nullable: true }, maxKB: { type: 'NUMBER', nullable: true },
    width: { type: 'INTEGER', nullable: true }, height: { type: 'INTEGER', nullable: true },
    minWidth: { type: 'INTEGER', nullable: true }, maxWidth: { type: 'INTEGER', nullable: true },
    minHeight: { type: 'INTEGER', nullable: true }, maxHeight: { type: 'INTEGER', nullable: true },
    widthCm: { type: 'NUMBER', nullable: true }, heightCm: { type: 'NUMBER', nullable: true },
    format: { type: 'STRING', enum: ['jpg', 'png', 'pdf'], nullable: true },
    background: { type: 'STRING', nullable: true },
    notes: { type: 'STRING', nullable: true }
  },
  required: ['found']
};

const keysText = (keys) => keys.map((c) => `${c.key}: ${c.desc}`).join('\n');

/** The Gemini request body for a (validated) task. */
export function buildBody(task, p) {
  const json = (schema) => ({ temperature: 0, responseMimeType: 'application/json', responseSchema: schema });
  switch (task) {
    case 'ping':
      return { contents: [{ role: 'user', parts: [{ text: 'Reply with the word OK.' }] }], generationConfig: { temperature: 0 } };
    case 'map':
      return {
        systemInstruction: { parts: [{ text: SYSTEM_MAP }] },
        contents: [{ role: 'user', parts: [{ text: `KEYS:\n${keysText(p.keys)}\n\nFIELDS:\n${JSON.stringify(p.fields)}` }] }],
        generationConfig: json(MAP_SCHEMA)
      };
    case 'flat':
      return {
        systemInstruction: { parts: [{ text: SYSTEM_FLAT }] },
        contents: [{ role: 'user', parts: [{ text: `KEYS:\n${keysText(p.keys)}\n\nThe form page:` }, { inlineData: { mimeType: p.mimeType, data: p.image } }] }],
        generationConfig: json(FLAT_SCHEMA)
      };
    case 'rules':
      return {
        systemInstruction: { parts: [{ text: SYSTEM_RULES }] },
        contents: [{ role: 'user', parts: [{ text: `FIELD: ${p.label}${p.accept ? ` (accepts ${p.accept})` : ''}\n\nPAGE TEXT:\n${p.snippets.map((s) => `- ${s}`).join('\n')}` }] }],
        generationConfig: json(RULES_SCHEMA)
      };
    default: throw bad('unknown task');
  }
}

// ---------------- Gemini call with retry + fallback ----------------
export class GeminiError extends Error {
  constructor(status, detail) {
    super(`Gemini error ${status}${detail ? ': ' + detail : ''}`);
    this.status = status;
  }
}

/** "Too many requests" (per-minute limit) and "high demand" both mean: busy, try again shortly. */
const isBusy = (err) => err.status === 503 || err.status === 429;

async function requestOnce({ apiKey, model, body, fetchImpl, base, timeoutMs = REQUEST_TIMEOUT_MS }) {
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctrl && setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetchImpl(`${base}/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body),
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      ...(ctrl ? { signal: ctrl.signal } : {})
    });
    if (!res.ok) {
      let j = null;
      try { j = await res.json(); } catch { /* ignore */ }
      const err = new GeminiError(res.status, j?.error?.message || '');
      const ra = Number(res.headers?.get?.('retry-after'));
      if (ra > 0) err.retryAfterMs = ra * 1000;
      // 429 RESOURCE_EXHAUSTED carries { "@type": "…RetryInfo", "retryDelay": "27s" }
      const rd = (j?.error?.details || []).map((d) => d?.retryDelay).find(Boolean);
      if (rd && /^\d+(\.\d+)?s$/.test(rd)) err.retryAfterMs = Math.ceil(parseFloat(rd) * 1000);
      throw err;
    }
    const json = await res.json();
    const text = json.candidates?.[0]?.content?.parts?.map((x) => x.text || '').join('') || '';
    if (!text) throw new Error('Gemini returned an empty response.');
    return text;
  } catch (e) {
    if (e?.name === 'AbortError' || ctrl?.signal.aborted) {
      const err = new GeminiError(504, `no answer within ${Math.round(timeoutMs / 1000)} s`);
      err.timeout = true;
      throw err;
    }
    throw e;
  } finally { if (timer) clearTimeout(timer); }
}

/**
 * Call Gemini. On 503 ("high demand") retry the model up to MAX_RETRIES times (≈1 s, 2 s, 4 s, or the
 * server's Retry-After, max 10 s), then try FALLBACK_MODEL once. Other errors are thrown at once.
 * Returns { text, model } (the model that answered).
 */
export async function callGemini({ apiKey, model = DEFAULT_MODEL, body, fetchImpl = globalThis.fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), base = GEMINI_BASE, fallbackModel = FALLBACK_MODEL, timeoutMs = REQUEST_TIMEOUT_MS, deadlineMs = CALL_DEADLINE_MS, now = () => Date.now() }) {
  const start = now();
  let tries = 0, last = null;
  const left = () => deadlineMs - (now() - start);
  for (let attempt = 0; ; attempt++) {
    try {
      tries++;
      return { text: await requestOnce({ apiKey, model, body, fetchImpl, base, timeoutMs: Math.max(1000, Math.min(timeoutMs, left())) }), model };
    } catch (err) {
      if (!isBusy(err)) throw err;
      last = err;
      if (attempt >= MAX_RETRIES) break;
      const wait = Math.min(MAX_WAIT_MS, err.retryAfterMs ?? RETRY_WAITS_MS[attempt]);
      // a long "retry in 30 s" (per-minute limit) is not worth waiting for here: try the fallback model instead
      if ((err.retryAfterMs ?? 0) > MAX_WAIT_MS || wait + 2000 > left()) break;
      await sleep(wait + Math.round(Math.random() * 250));
    }
  }
  if (fallbackModel && model !== fallbackModel && left() > 3000) {
    try {
      return { text: await requestOnce({ apiKey, model: fallbackModel, body, fetchImpl, base, timeoutMs: Math.max(1000, Math.min(timeoutMs, left())) }), model: fallbackModel };
    } catch (err) {
      if (!isBusy(err)) { const e = new Error(`${model} was busy and the fallback ${fallbackModel} failed: ${err.message}`); e.status = err.status; e.timeout = err.timeout; throw e; }
      last = err;
    }
  }
  throw busyError(last, tries, model, fallbackModel);
}

/** A clear "busy" error: what happened and when to try again. */
function busyError(err, tries, model, fallbackModel) {
  const secs = Math.max(10, Math.min(120, Math.ceil((err?.retryAfterMs ?? 30000) / 1000)));
  const why = err?.status === 429 ? "Gemini's per-minute limit is used up" : 'Gemini is busy right now';
  const tried = fallbackModel && model !== fallbackModel ? `tried ${model} ${tries} times and ${fallbackModel}` : `tried ${model} ${tries} times`;
  const e = new Error(`${why} (${err?.status ?? 503}; ${tried}). Try again in about ${secs} s.`);
  e.status = err?.status === 429 ? 429 : 503;
  e.busy = true;
  e.retryAfterSec = secs;
  return e;
}
