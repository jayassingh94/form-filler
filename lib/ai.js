// AI matching for the extension. Three modes (Settings → AI matching):
//   service – Form Filler's free AI server (default; no key needed; daily limit), see server/
//   own     – the user's own Gemini API key, called directly from the browser
//   off     – offline keyword matching only
// In every mode the request contains only: field labels / placeholders / option texts, a BLANK form page
// image (Fill a PDF, after consent), or short upload-rule text from the page, plus generic profile key
// names. Profile values are never sent. Prompts are built in lib/gemini-core.js (the server uses the same).

import '../content/fillcore.js'; // globalThis.FFCore.normalizeKey
import { validateTask, buildBody, callGemini, DEFAULT_MODEL, FALLBACK_MODEL, MAX_FIELDS_PER_CALL } from './gemini-core.js';
import { BACKEND_URL } from './config.js';

export { FALLBACK_MODEL, MAX_RETRIES } from './gemini-core.js';
const repairKey = (k, keySet) => globalThis.FFCore.normalizeKey(k, keySet);

/** 'service' | 'own' | 'off'. Older settings with a saved key keep using it. */
export function aiMode(settings = {}) {
  if (settings.aiMode === 'service' || settings.aiMode === 'own' || settings.aiMode === 'off') return settings.aiMode;
  return settings.apiKey ? 'own' : 'service';
}
/** True when this build has a Form Filler AI server address (see lib/config.js). */
export const serviceConfigured = () => /^https:\/\//.test(BACKEND_URL) || /^http:\/\/localhost[:/]/.test(BACKEND_URL);
export function aiAvailable(settings) {
  const m = aiMode(settings);
  return (m === 'service' && serviceConfigured()) || (m === 'own' && !!settings.apiKey);
}

let sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Tests only: replace the wait so they run instantly. */
export function __setSleepForTests(fn) { sleep = fn; }

/** Model that answered the most recent successful request (to tell the user about a fallback). */
export let lastModelUsed = null;
/** Free AI uses left today, from the server's last answer (null when unknown / own key). */
export let lastRemaining = null;
export let lastLimit = null;

/** Accept (settings, …) or the older (apiKey, model, …) call style. */
function cfg(args, n) {
  if (typeof args[0] === 'string' || args[0] == null) {
    return { settings: { aiMode: 'own', apiKey: args[0] || '', model: args[1] || DEFAULT_MODEL }, rest: [...args].slice(2, 2 + n) };
  }
  return { settings: args[0], rest: [...args].slice(1, 1 + n) };
}

// ---------------- transports ----------------
let sleepForCore = (ms) => sleep(ms);

async function getInstallId() {
  const k = 'ff_install_id';
  const got = await globalThis.chrome?.storage?.local.get(k);
  if (got?.[k]) return got[k];
  const id = crypto.randomUUID();
  await globalThis.chrome?.storage?.local.set({ [k]: id });
  return id;
}

async function viaService(task, payload) {
  if (!serviceConfigured()) throw Object.assign(new Error("The free Form Filler AI isn't set up in this version. Offline matching still works, or add your own Gemini key in Settings."), { offline: true });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 95000); // the free server may need ~50 s to wake up
  let res;
  try {
    res = await fetch(`${BACKEND_URL}/v1/ai`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ installId: await getInstallId(), task, payload }),
      credentials: 'omit', referrerPolicy: 'no-referrer', signal: ctrl.signal
    });
  } catch {
    throw Object.assign(new Error("Couldn't reach Form Filler's AI service (it may be starting up; try again in a minute). Offline matching still works."), { offline: true });
  } finally { clearTimeout(timer); }
  let j = {};
  try { j = await res.json(); } catch { /* ignore */ }
  if (!res.ok) {
    const e = new Error(j.message || "Form Filler's AI service isn't available right now. Offline matching still works.");
    e.status = res.status; e.code = j.error;
    if (res.status === 429) { e.limit = true; lastRemaining = 0; await saveQuota(0, lastLimit); }
    throw e;
  }
  lastModelUsed = j.model || null;
  if (typeof j.remaining === 'number') { lastRemaining = j.remaining; lastLimit = j.limit ?? lastLimit; await saveQuota(j.remaining, j.limit); }
  return j.text;
}

async function saveQuota(remaining, limit) {
  try {
    const prev = (await globalThis.chrome?.storage?.local.get('ff_ai_quota'))?.ff_ai_quota;
    await globalThis.chrome?.storage?.local.set({ ff_ai_quota: { day: new Date().toISOString().slice(0, 10), remaining, limit: limit ?? prev?.limit ?? 10 } });
  } catch { /* ignore */ }
}

/** Free AI uses left today, as last reported by the server (null if unknown). */
export async function quotaToday() {
  const q = (await globalThis.chrome?.storage?.local.get('ff_ai_quota'))?.ff_ai_quota;
  return q && q.day === new Date().toISOString().slice(0, 10) ? q.remaining : null;
}
/** The daily allowance as last reported by the server (default 10). */
export async function quotaLimit() {
  return (await globalThis.chrome?.storage?.local.get('ff_ai_quota'))?.ff_ai_quota?.limit ?? 10;
}

async function run(settings, task, payload) {
  lastModelUsed = null;
  const mode = aiMode(settings);
  if (mode === 'off') throw new Error('AI matching is switched off in Settings.');
  const clean = validateTask(task, payload);
  if (mode === 'service') return viaService(task, clean);
  if (!settings.apiKey) throw new Error('Enter your Gemini API key in Settings, or switch to the free Form Filler AI.');
  const out = await callGemini({ apiKey: settings.apiKey, model: settings.model || DEFAULT_MODEL, body: buildBody(task, clean), sleep: sleepForCore });
  lastModelUsed = out.model;
  return out.text;
}

const parse = (text) => { try { return JSON.parse(text); } catch { throw new Error('Gemini returned invalid JSON.'); } };

// ---------------- tasks ----------------
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

/**
 * mapFieldsWithGemini(settings, fields, catalog) — or (apiKey, model, fields, catalog).
 * Returns Map<index, {key, confidence, dateFormat}>.
 */
export async function mapFieldsWithGemini(...args) {
  const { settings, rest: [fields, catalog] } = cfg(args, 2);
  const keySet = new Set(catalog.map((c) => c.key));
  const out = new Map();
  for (let start = 0; start < fields.length; start += MAX_FIELDS_PER_CALL) {
    const chunk = fields.slice(start, start + MAX_FIELDS_PER_CALL).map((f, j) => describeForAI(f, start + j));
    const parsed = parse(await run(settings, 'map', { fields: chunk, keys: catalog }));
    for (const m of parsed.mappings || []) {
      // Repair near-miss key names ("fullName", "father_name") instead of dropping them.
      const key = typeof m.i === 'number' ? repairKey(m.key, keySet) : null;
      if (!key) continue;
      out.set(m.i, { key, confidence: m.confidence === 'high' ? 'high' : 'low', dateFormat: m.dateFormat || null });
    }
  }
  return out;
}

/** testGemini(settings) — or (apiKey, model). */
export async function testGemini(...args) {
  const { settings } = cfg(args, 0);
  if (aiMode(settings) === 'own' && !settings.apiKey) throw new Error('Enter an API key first.');
  await run(settings, 'ping', {});
}

/**
 * detectFlatPage(settings, imageB64, mimeType, catalog) — or (apiKey, model, imageB64, mimeType, catalog).
 * One BLANK form page image → raw items [{label, kind, option, box_2d, cells, uppercase, key, dateFormat, confidence}].
 */
export async function detectFlatPage(...args) {
  const { settings, rest: [imageB64, mimeType, catalog] } = cfg(args, 3);
  const keySet = new Set(catalog.map((c) => c.key));
  const parsed = parse(await run(settings, 'flat', { image: imageB64, mimeType, keys: catalog }));
  return (parsed.items || []).map((it) => ({ ...it, rawKey: it.key ?? null, key: repairKey(it.key, keySet) }));
}

/**
 * extractUploadRules(settings, {label, accept, snippets}) — or (apiKey, model, {…}).
 * Returns a cleaned rule object ({} when nothing was found).
 */
export async function extractUploadRules(...args) {
  const { settings, rest: [input] } = cfg(args, 1);
  const r = parse(await run(settings, 'rules', input));
  if (!r.found) return {};
  const num = (v, lo, hi) => (typeof v === 'number' && isFinite(v) && v >= lo && v <= hi ? v : undefined);
  const rule = {
    kind: r.kind || undefined,
    minKB: num(r.minKB, 0, 100000), maxKB: num(r.maxKB, 1, 100000),
    width: num(r.width, 16, 8000), height: num(r.height, 16, 8000),
    minWidth: num(r.minWidth, 16, 8000), maxWidth: num(r.maxWidth, 16, 8000),
    minHeight: num(r.minHeight, 16, 8000), maxHeight: num(r.maxHeight, 16, 8000),
    format: r.format || undefined, background: r.background || undefined, notes: r.notes || undefined
  };
  const wcm = num(r.widthCm, 0.3, 100), hcm = num(r.heightCm, 0.3, 100);
  if (!rule.width && !rule.height && !rule.minWidth && wcm && hcm) {
    rule.aspect = wcm / hcm; rule.width = Math.round(wcm * 100); rule.height = Math.round(hcm * 100); rule.fromCm = true;
  }
  if (rule.minKB && rule.maxKB && rule.minKB > rule.maxKB) [rule.minKB, rule.maxKB] = [rule.maxKB, rule.minKB];
  for (const k of Object.keys(rule)) if (rule[k] === undefined) delete rule[k];
  return rule;
}
