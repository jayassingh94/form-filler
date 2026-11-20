// Service worker: orchestrates "Fill this form", relays locker files to the page, and auto-locks.
import './content/fillcore.js';
import { loadVault, checkAutoLock } from './lib/vault.js';
import { keyCatalog, resolveValue } from './lib/schema.js';
import { mapFieldsWithGemini } from './lib/ai.js';
import { getDocBytes } from './lib/vault.js';
import { addDocument } from './lib/docs.js';
import { toB64, fromB64 } from './lib/crypto.js';

const C = globalThis.FFCore;
const EXT_ORIGIN = `chrome-extension://${chrome.runtime.id}/`;

function ensureAlarm() {
  chrome.alarms.create('autolock', { periodInMinutes: 0.5 });
}
chrome.runtime.onInstalled.addListener((d) => {
  ensureAlarm();
  if (d.reason === 'install') chrome.runtime.openOptionsPage();
});
chrome.runtime.onStartup.addListener(ensureAlarm);
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'autolock') checkAutoLock(); });

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Only accept commands from this extension's own pages (popup / picker), never from web pages.
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(EXT_ORIGIN)) return;
  const page = sender.url.slice(EXT_ORIGIN.length);

  if (msg?.type === 'ff-fill' && page.startsWith('popup/')) {
    handleFill(msg).then(sendResponse, (e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  // The picker iframe lives inside a web page, where IndexedDB may be partitioned,
  // so it reads/writes locker files through this worker.
  if (msg?.type === 'ff-doc-get' && page.startsWith('picker/')) {
    getDocBytes(msg.id).then((buf) => sendResponse({ ok: true, b64: toB64(new Uint8Array(buf)) }),
      (e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg?.type === 'ff-doc-add' && page.startsWith('picker/')) {
    addDocument(new Blob([fromB64(msg.b64)], { type: msg.mime }), { name: msg.name, tags: msg.tags || [] })
      .then((meta) => sendResponse({ ok: true, meta }), (e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if ((msg?.type === 'ff-deliver' || msg?.type === 'ff-close') && page.startsWith('picker/') && sender.tab) {
    const out = msg.type === 'ff-deliver'
      ? { type: 'ff-attach', token: msg.token, name: msg.name, mime: msg.mime, b64: msg.b64 }
      : { type: 'ff-close-picker', token: msg.token };
    chrome.tabs.sendMessage(sender.tab.id, out).then(
      (r) => sendResponse(r || { ok: false, error: 'The upload field is no longer on the page.' }),
      (e) => sendResponse({ ok: false, error: e.message })
    );
    return true;
  }
});

async function handleFill({ tabId, profileId, overwrite }) {
  const vault = await loadVault(); // throws LOCKED if locked
  const profile = vault.profiles.find((p) => p.id === profileId) || vault.profiles[0];

  await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    files: ['content/fillcore.js', 'content/content.js']
  });
  const scans = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: () => window.__formFiller?.scan()
  });

  const all = [];
  let fileInputs = 0;
  for (const r of scans) {
    if (!r.result) continue;
    fileInputs += r.result.fileInputs || 0;
    for (const d of r.result.fields) all.push({ frameId: r.frameId, d });
  }
  const candidates = all.filter((x) => !x.d.sensitive);
  const sensitive = all.length - candidates.length;
  if (!candidates.length) {
    return { ok: true, green: 0, yellow: 0, kept: 0, sensitive, fileInputs, mode: 'none' };
  }

  // Map fields -> profile keys. Only labels/options go to the AI.
  let mapping = new Map();
  let mode = 'offline';
  let aiError = null;
  const { apiKey, model } = vault.settings;
  if (apiKey) {
    try {
      mapping = await mapFieldsWithGemini(apiKey, model, candidates.map((x) => x.d), keyCatalog(profile));
      mode = 'ai';
    } catch (e) {
      aiError = e.message;
    }
  }
  if (mode === 'offline') {
    const customs = (profile.custom || []).map((c, i) => ({ i, n: C.norm(c.label) })).filter((c) => c.n);
    candidates.forEach((x, i) => {
      const label = C.norm(x.d.label || x.d.placeholder || x.d.name);
      const custom = label && customs.find((c) => c.n === label || (c.n.length > 3 && label.includes(c.n)));
      if (custom) { mapping.set(i, { key: `custom.${custom.i}`, confidence: 'high', dateFormat: null }); return; }
      const key = C.heuristicKey(x.d);
      if (key) mapping.set(i, { key, confidence: 'high', dateFormat: null });
    });
  }

  // Resolve values locally and group per frame.
  const perFrame = new Map();
  candidates.forEach((x, i) => {
    if (!perFrame.has(x.frameId)) perFrame.set(x.frameId, { assignments: [], review: [] });
    const bucket = perFrame.get(x.frameId);
    const m = mapping.get(i);
    const val = m && resolveValue(profile, m.key);
    if (!val) { bucket.review.push(x.d.ffId); return; }
    bucket.assignments.push({
      ffId: x.d.ffId, key: m.key, value: val.value, kind: val.kind,
      sure: m.confidence === 'high', dateFormat: m.dateFormat
    });
  });

  const totals = { green: 0, yellow: 0, kept: 0 };
  for (const [frameId, args] of perFrame) {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      func: (a) => window.__formFiller.fill(a),
      args: [{ ...args, overwrite: !!overwrite }]
    });
    if (res?.result) for (const k of Object.keys(totals)) totals[k] += res.result[k] || 0;
  }
  return { ok: true, ...totals, sensitive, fileInputs, mode, aiError };
}
