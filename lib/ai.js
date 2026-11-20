// Gemini field mapper. PRIVACY: the request contains only
//   (a) field descriptions scraped from the page (label, placeholder, name, type, option texts), and
//   (b) the generic profile key catalogue (key names + descriptions, never values).
// No profile values, documents, page URL or field values are sent.

const ENDPOINT = (model) => `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
const MAX_FIELDS_PER_CALL = 120;

const SYSTEM = `You map web form fields to keys of a personal profile.
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

const RESPONSE_SCHEMA = {
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

/** Strip a scanned field down to the label-only description that is sent to the AI. */
export function describeForAI(f, i) {
  const clip = (s, n) => (s ? String(s).replace(/\s+/g, ' ').trim().slice(0, n) : undefined);
  const d = {
    i,
    label: clip(f.label, 160),
    section: clip(f.section, 100),
    placeholder: clip(f.placeholder, 80),
    name: clip(f.name, 60),
    type: f.tag === 'select' ? 'select' : f.tag === 'textarea' ? 'textarea' : f.type
  };
  if (f.options?.length) d.options = f.options.filter((o) => !o.placeholder).slice(0, 60).map((o) => clip(o.text, 50));
  for (const k of Object.keys(d)) if (d[k] === undefined || d[k] === '') delete d[k];
  return d;
}

async function callGemini(apiKey, model, body) {
  const res = await fetch(ENDPOINT(model), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify(body),
    credentials: 'omit',
    referrerPolicy: 'no-referrer'
  });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).error?.message || ''; } catch { /* ignore */ }
    throw new Error(`Gemini error ${res.status}${detail ? ': ' + detail : ''}`);
  }
  const json = await res.json();
  const text = json.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
  if (!text) throw new Error('Gemini returned an empty response.');
  return text;
}

/**
 * fields: scanned (non-sensitive) fields; catalog: [{key, desc}]
 * Returns Map<index, {key, confidence, dateFormat}>
 */
export async function mapFieldsWithGemini(apiKey, model, fields, catalog) {
  const keySet = new Set(catalog.map((c) => c.key));
  const keysText = catalog.map((c) => `${c.key}: ${c.desc}`).join('\n');
  const out = new Map();
  for (let start = 0; start < fields.length; start += MAX_FIELDS_PER_CALL) {
    const chunk = fields.slice(start, start + MAX_FIELDS_PER_CALL).map((f, j) => describeForAI(f, start + j));
    const body = {
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: [{ role: 'user', parts: [{ text: `KEYS:\n${keysText}\n\nFIELDS:\n${JSON.stringify(chunk)}` }] }],
      generationConfig: { temperature: 0, responseMimeType: 'application/json', responseSchema: RESPONSE_SCHEMA }
    };
    const text = await callGemini(apiKey, model, body);
    let parsed;
    try { parsed = JSON.parse(text); } catch { throw new Error('Gemini returned invalid JSON.'); }
    for (const m of parsed.mappings || []) {
      if (typeof m.i !== 'number' || !m.key || !keySet.has(m.key)) continue;
      out.set(m.i, { key: m.key, confidence: m.confidence === 'high' ? 'high' : 'low', dateFormat: m.dateFormat || null });
    }
  }
  return out;
}

export async function testGemini(apiKey, model) {
  if (!apiKey) throw new Error('Enter an API key first.');
  await callGemini(apiKey, model, {
    contents: [{ role: 'user', parts: [{ text: 'Reply with the word OK.' }] }],
    generationConfig: { temperature: 0 }
  });
}
