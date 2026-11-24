// Service worker: orchestrates "Fill this form", relays locker files to the page, and auto-locks.
import './content/fillcore.js';
import { loadVault, checkAutoLock } from './lib/vault.js';
import { keyCatalog, resolveValue, resolveFirst } from './lib/schema.js';
import { mapFieldsWithGemini, lastModelUsed, lastRemaining, lastLimit, aiAvailable, aiMode } from './lib/ai.js';
import { DEFAULT_MODEL } from './lib/gemini-core.js';
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

  if (msg?.type === 'ff-pending' && page.startsWith('popup/')) {
    // Chrome's site-permission prompt usually closes the popup: remember the fill so it can run once the site is allowed.
    const { tabId, profileId, overwrite, origin } = msg;
    chrome.storage.session.set({ ff_pending: { tabId, profileId, overwrite: !!overwrite, origin, at: Date.now() } }).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg?.type === 'ff-pending-cancel' && page.startsWith('popup/')) {
    clearPending(msg.tabId).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg?.type === 'ff-fill' && page.startsWith('popup/')) {
    // the popup is still open and does it itself: the pending fill for this tab isn't needed any more
    clearPending(msg.tabId)
      .then(() => fillOnce(msg, { reuseRecent: !!msg.afterGrant }))
      .then(sendResponse, (e) => sendResponse({ ok: false, error: e.message }));
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
  if (msg?.type === 'ff-rule-text' && page.startsWith('picker/') && sender.tab) {
    chrome.tabs.sendMessage(sender.tab.id, { type: 'ff-rule-text', token: msg.token }).then(
      (r) => sendResponse(r || { ok: false, error: 'The upload field is no longer on the page.' }),
      (e) => sendResponse({ ok: false, error: e.message })
    );
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

// ---------------- fill after the site permission is granted ----------------
const PENDING_TTL_MS = 2 * 60 * 1000;
const inflight = new Map(); // tabId -> Promise of the running fill
const recent = new Map();   // tabId -> { result, at } (so a fill requested right after another isn't run twice)

async function clearPending(tabId) {
  const { ff_pending: p } = await chrome.storage.session.get('ff_pending');
  if (p && (tabId == null || p.tabId === tabId)) await chrome.storage.session.remove('ff_pending');
}

/** One fill per tab at a time; with reuseRecent, a fill that just finished (≤ 10 s) is reused. */
function fillOnce(args, { reuseRecent = false } = {}) {
  const tabId = args.tabId;
  if (inflight.has(tabId)) return inflight.get(tabId);
  const r = recent.get(tabId);
  if (reuseRecent && r && Date.now() - r.at < 10000) return Promise.resolve(r.result);
  const p = handleFill(args)
    .then(async (result) => {
      recent.set(tabId, { result, at: Date.now() });
      // the popup shows this result if it is opened again on this tab
      await chrome.storage.session.set({ ff_last_result: { tabId, result, at: Date.now() } });
      return result;
    })
    .finally(() => inflight.delete(tabId));
  inflight.set(tabId, p);
  return p;
}

/** "Filled 12 fields · 2 need your input: Mobile, Course" */
function summaryText(r) {
  if (r.mode === 'none') return 'No fillable fields found on this page.';
  const filled = r.filled ?? r.green ?? 0;
  const needs = r.needs || [];
  const names = needs.length <= 4 ? needs.join(', ') : `${needs.slice(0, 4).join(', ')} +${needs.length - 4} more`;
  return `Filled ${filled} field${filled === 1 ? '' : 's'}${needs.length ? ` · ${needs.length} need${needs.length === 1 ? 's' : ''} your input: ${names}` : ''}`;
}

async function notify(tabId, title, message) {
  const id = `ff-${tabId}-${Date.now()}`;
  await chrome.notifications.create(id, { type: 'basic', iconUrl: chrome.runtime.getURL('icons/icon128.png'), title, message, priority: 1 });
  await chrome.storage.session.set({ [`ff_note_${id}`]: tabId });
}

chrome.notifications.onClicked.addListener(async (id) => {
  const key = `ff_note_${id}`;
  const tabId = (await chrome.storage.session.get(key))[key];
  if (tabId != null) {
    try { const t = await chrome.tabs.update(tabId, { active: true }); await chrome.windows.update(t.windowId, { focused: true }); } catch { /* tab closed */ }
  }
  chrome.notifications.clear(id);
  chrome.storage.session.remove(key);
});

/** Chrome granted new site access: finish a fill that was waiting for it. */
async function onPermissionAdded(perm) {
  const { ff_pending: p } = await chrome.storage.session.get('ff_pending');
  if (!p || !(perm.origins || []).includes(p.origin)) return;
  await chrome.storage.session.remove('ff_pending');
  if (Date.now() - p.at > PENDING_TTL_MS) return;
  // the tab must still be open and on the site that was allowed
  let tab;
  try { tab = await chrome.tabs.get(p.tabId); } catch { return; }
  if (!originMatches(p.origin, tab.url)) {
    await notify(p.tabId, 'Form Filler', 'That tab moved to another page, so nothing was filled. Click Fill this form again.');
    return;
  }
  try {
    const result = await fillOnce({ tabId: p.tabId, profileId: p.profileId, overwrite: p.overwrite });
    // if the popup is still open it shows the result itself
    const popupOpen = chrome.runtime.getContexts ? (await chrome.runtime.getContexts({ contextTypes: ['POPUP'] })).length > 0 : false;
    const text = summaryText(result);
    if (!popupOpen) await notify(p.tabId, 'Form Filler', `${text}${/[.…]$/.test(text) ? '' : '.'} Nothing was submitted.`);
  } catch (e) {
    await notify(p.tabId, 'Form Filler', e.message === 'LOCKED'
      ? 'Form Filler is locked. Open it, unlock, and click Fill this form again.'
      : `Couldn't fill this page: ${e.message}`);
  }
}
chrome.permissions.onAdded.addListener(onPermissionAdded);

/** Does a match pattern like "https://example.com/*" or "file:///*" cover this URL? */
function originMatches(pattern, url) {
  try {
    const u = new URL(url);
    if (pattern === 'file:///*') return u.protocol === 'file:';
    const m = pattern.match(/^(https?):\/\/([^/]+)\/\*$/);
    return !!m && u.protocol === m[1] + ':' && u.hostname === m[2];
  } catch { return false; }
}

// Every step of a fill has a time limit, so the popup never waits forever (a frame that never finishes
// loading, a page dialog that blocks the page, a slow AI answer).
const LIMITS = { inject: 8000, scan: 8000, ai: 30000, fillFrame: 20000, lateForm: [1200, 2500] };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function withTimeout(promise, ms, what) {
  let t;
  return Promise.race([promise, new Promise((_, rej) => { t = setTimeout(() => rej(Object.assign(new Error(`${what} took longer than ${Math.round(ms / 1000)} s`), { timeout: true })), ms); })])
    .finally(() => clearTimeout(t));
}

/**
 * Run a script in every frame of the tab without waiting for slow frames to finish loading; if some frame
 * can't be used (an error page, a frame that hangs), fall back to the main frame. Returns the per-frame results.
 */
async function runInFrames(tabId, what, inj) {
  try {
    return await withTimeout(chrome.scripting.executeScript({ target: { tabId, allFrames: true }, injectImmediately: true, ...inj }), LIMITS[what], what);
  } catch (e) {
    try {
      return await withTimeout(chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, injectImmediately: true, ...inj }), LIMITS[what], what);
    } catch { throw e; }
  }
}

async function scanTab(tabId) {
  await runInFrames(tabId, 'inject', { files: ['content/fillcore.js', 'content/content.js'] });
  return runInFrames(tabId, 'scan', { func: () => window.__formFiller?.scan() });
}

/** Origins of form frames from other sites that Form Filler has no access to yet ("https://forms.example/*"). */
async function blockedFrames(scans) {
  const origins = [...new Set(scans.flatMap((r) => r.result?.frames || []))];
  const out = [];
  for (const o of origins) {
    const pattern = `${o}/*`;
    if (!(await chrome.permissions.contains({ origins: [pattern] }).catch(() => true))) out.push(pattern);
  }
  return out;
}

async function handleFill({ tabId, profileId, overwrite }) {
  const vault = await loadVault(); // throws LOCKED if locked
  const profile = vault.profiles.find((p) => p.id === profileId) || vault.profiles[0];

  // forms that appear a moment after the page loads (rendered by JavaScript, opened in a dialog): look again
  let scans = await scanTab(tabId);
  // (also when only a side frame has fields but the page itself has none yet)
  const mainCount = (sc) => sc.find((r) => r.frameId === 0)?.result?.fields?.length || 0;
  for (const wait of LIMITS.lateForm) {
    if (mainCount(scans) > 0) break;
    await sleep(wait);
    scans = await scanTab(tabId);
  }
  const blocked = await blockedFrames(scans);

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
    return { ok: true, green: 0, yellow: 0, kept: 0, sensitive, fileInputs, mode: 'none', blockedFrames: blocked };
  }

  // Map fields -> profile keys. Only labels/options go to the AI.
  let mapping = new Map();
  let mode = 'offline';
  let aiError = null;
  const model = aiMode(vault.settings) === 'own' ? (vault.settings.model || DEFAULT_MODEL) : DEFAULT_MODEL;
  if (aiAvailable(vault.settings)) {
    try {
      // a slow or failing AI never blocks the fill: offline matching takes over
      mapping = await withTimeout(mapFieldsWithGemini(vault.settings, candidates.map((x) => x.d), keyCatalog(profile)), LIMITS.ai, 'AI matching');
      mode = 'ai';
    } catch (e) {
      mapping = new Map();
      aiError = e.timeout ? 'AI matching took too long' : e.message;
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
    // Try, in order: a precise label rule ("Full Name", "Address for Correspondence"), the AI's key,
    // then the keyword guess, and use the first that has a value in the profile.
    const precise = C.labelKey(x.d.label);
    const keys = [precise, m?.key, mode === 'ai' ? C.heuristicKey(x.d) : null];
    const val = resolveFirst(profile, keys);
    if (!val) { bucket.review.push(x.d.ffId); return; }
    bucket.assignments.push({
      ffId: x.d.ffId, key: val.key, value: val.value, kind: val.kind,
      sure: val.key === precise || (m?.key === val.key ? m.confidence === 'high' : mode !== 'ai'), dateFormat: m?.dateFormat
    });
  });

  const totals = { green: 0, yellow: 0, kept: 0, filled: 0, needs: [], check: [] };
  const highlight = !!vault.settings.highlight; // off by default: no colours on the page
  const stuck = [];
  for (const [frameId, args] of perFrame) {
    let res;
    try {
      [res] = await withTimeout(chrome.scripting.executeScript({
        target: { tabId, frameIds: [frameId] },
        func: (a) => window.__formFiller.fill(a),
        args: [{ ...args, overwrite: !!overwrite, highlight }]
      }), LIMITS.fillFrame, 'Filling');
    } catch (e) {
      // e.g. the page opened a dialog (alert) when a value changed, which pauses everything on the page
      stuck.push(frameId);
      continue;
    }
    const r = res?.result;
    if (!r) continue;
    for (const k of ['green', 'yellow', 'kept', 'filled']) totals[k] += r[k] || 0;
    totals.needs.push(...(r.needs || []));
    totals.check.push(...(r.check || []));
  }
  totals.needs = [...new Set(totals.needs)];
  totals.check = [...new Set(totals.check)];
  const fallbackModel = mode === 'ai' && lastModelUsed && lastModelUsed !== model ? lastModelUsed : null;
  return { ok: true, ...totals, sensitive, fileInputs, mode, aiError, fallbackModel, aiLimit: /daily limit|today's/.test(aiError || ''),
    remaining: aiMode(vault.settings) === 'service' ? lastRemaining : null, limit: lastLimit,
    stuck: stuck.length ? 'Part of the page stopped responding while filling (often a pop-up message on the page). Some fields may be filled: check the form.' : null,
    blockedFrames: blocked };
}
