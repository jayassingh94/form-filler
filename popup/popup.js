import { loadVault, lock, isSetUp } from '../lib/vault.js';
import { aiMode, quotaToday, quotaLimit, serviceConfigured } from '../lib/ai.js';
import { showLock, onLocked } from '../lib/lockui.js';
import { sitePattern } from '../lib/site.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let tab = null;
let originPattern = null;
let alreadyGranted = false;

const openOptions = (hash) => {
  chrome.tabs.create({ url: chrome.runtime.getURL('options/options.html') + (hash ? '#' + hash : '') });
  window.close();
};
$('#open-profile').onclick = () => openOptions('profiles');
$('#open-docs').onclick = () => openOptions('docs');
$('#open-pdf').onclick = () => { chrome.tabs.create({ url: chrome.runtime.getURL('pdf/pdf.html') }); window.close(); };
$('#open-settings').onclick = $('#go-settings').onclick = () => openOptions('settings');
$('#lock-now').onclick = () => lock();
onLocked(() => boot());

async function boot() {
  $('#main').classList.add('hidden');
  $('#lock-now').classList.add('hidden');
  if (!(await isSetUp())) {
    await showLock($('#lock'), { allowSetup: false });
    return;
  }
  await showLock($('#lock'), { compact: true }).catch(() => {});
  let vault;
  try { vault = await loadVault(); } catch { return boot(); }
  $('#main').classList.remove('hidden');
  $('#lock-now').classList.remove('hidden');
  const last = (await chrome.storage.local.get('ff_last_profile')).ff_last_profile;
  $('#profile').innerHTML = vault.profiles.map((p) => `<option value="${p.id}">${esc(p.label)}</option>`).join('');
  if (vault.profiles.some((p) => p.id === last)) $('#profile').value = last;
  const mode = aiMode(vault.settings);
  const left = mode === 'service' ? await quotaToday() : null;
  const note = mode === 'off' ? 'AI matching is off: using offline keyword matching.'
    : mode === 'own' && !vault.settings.apiKey ? 'No Gemini key saved: using offline keyword matching.'
    : mode === 'service' && !serviceConfigured() ? 'Using offline keyword matching (free AI not set up in this version).'
    : mode === 'service' && left != null ? `Free AI: ${left} of ${await quotaLimit()} uses left today.`
    : '';
  $('#ai-note-text').textContent = note;
  $('#ai-note').classList.toggle('hidden', !note);
  // reopened after a fill (e.g. one finished in the background after Chrome's permission prompt): show it
  await tabReady;
  const lastFill = (await chrome.storage.session.get('ff_last_result')).ff_last_result;
  if (lastFill && tab && lastFill.tabId === tab.id && Date.now() - lastFill.at < 10 * 60 * 1000 && !$('#result').textContent.trim()) renderResult(lastFill.result);
}

// Work out the site permission pattern up front so the click handler can request it synchronously
// (Chrome only shows the permission prompt during a user gesture).
// tab.url is only visible thanks to the activeTab permission, which Chrome grants when you click the
// toolbar icon. It gives no access to the page itself; that is requested below when you click Fill.
async function readTab() {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const site = sitePattern(tab?.url || tab?.pendingUrl);
  originPattern = site.pattern || null;
  if (originPattern) alreadyGranted = await chrome.permissions.contains({ origins: [originPattern] }).catch(() => false);
  if (!originPattern) {
    $('#fill').disabled = true;
    $('#result').innerHTML = site.reason === 'restricted'
      ? '<div class="notice small">Chrome doesn\'t let extensions run on this page (browser settings, extension pages, the Web Store). Open the web form you want to fill.</div>'
      : '<div class="notice small">Couldn\'t read this tab\'s address. Reload the page, then click the Form Filler icon again.</div>';
  }
}
const tabReady = readTab();

$('#fill').onclick = async () => {
  if (!originPattern) await tabReady;
  if (!originPattern) return;
  const req = { tabId: tab.id, profileId: $('#profile').value, overwrite: $('#overwrite').checked };
  // On a new site Chrome's permission prompt usually closes this popup. Tell the background first, so it fills
  // the form by itself as soon as the site is allowed (and shows a notification).
  if (!alreadyGranted) chrome.runtime.sendMessage({ type: 'ff-pending', ...req, origin: originPattern });
  // Chrome shows the site-access prompt only during a user gesture, so request it right away.
  chrome.permissions.request({ origins: [originPattern] }).then(async (granted) => {
    if (!granted) {
      chrome.runtime.sendMessage({ type: 'ff-pending-cancel', tabId: tab.id });
      showResult(`<div class="err small">Permission for this site was not granted, so nothing was filled.</div>`);
      return;
    }
    await chrome.storage.local.set({ ff_last_profile: $('#profile').value });
    $('#fill').disabled = true;
    $('#fill').textContent = 'Filling…';
    showResult('<div class="muted small">Reading the form fields…</div>');
    try {
      // afterGrant: if the background already filled it right after the permission, reuse that result
      const r = await chrome.runtime.sendMessage({ type: 'ff-fill', ...req, afterGrant: !alreadyGranted });
      alreadyGranted = true;
      if (!r?.ok) throw new Error(r?.error || 'Unknown error');
      renderResult(r);
    } catch (e) {
      const m = e.message === 'LOCKED' ? 'Locked. Unlock and try again.'
        : /file:/.test(originPattern) && /Cannot access|permission/i.test(e.message)
          ? 'For local files, enable "Allow access to file URLs" for Form Filler in chrome://extensions, or serve the page over http://localhost.'
          : e.message;
      showResult(`<div class="err small">${esc(m)}</div>`);
      if (e.message === 'LOCKED') boot();
    } finally {
      $('#fill').disabled = false;
      $('#fill').textContent = 'Fill this form';
    }
  });
};

function showResult(html) { $('#result').innerHTML = html; }

function renderResult(r) {
  const lines = [];
  if (r.mode === 'none') {
    lines.push('<div class="notice small">No fillable fields found on this page.</div>');
  } else {
    // "Filled 12 fields · 2 need your input: Mobile, Course"
    const names = (list, max = 6) => list.length <= max ? list.map(esc).join(', ') : `${list.slice(0, max).map(esc).join(', ')} +${list.length - max} more`;
    const filled = r.filled ?? r.green;
    const needs = r.needs || [];
    lines.push(`<div class="summary"><b>Filled ${filled} field${filled === 1 ? '' : 's'}</b>${needs.length
      ? ` · ${needs.length} need${needs.length === 1 ? 's' : ''} your input: <span class="names">${names(needs)}</span>`
      : ' · nothing left for you'}</div>`);
    if (r.check?.length) lines.push(`<div class="small" style="margin-top:4px">Please check: ${names(r.check)}</div>`);
    if (r.kept) lines.push(`<div class="line small muted">${r.kept} already had a value (left as is)</div>`);
  }
  if (r.sensitive) lines.push(`<div class="line small muted">🛡️ ${r.sensitive} sensitive field(s) skipped (password, card, bank, OTP…)</div>`);
  if (r.fileInputs) lines.push(`<div class="line small muted">📎 ${r.fileInputs} upload field(s): use "Pick from locker" on the page</div>`);
  if (r.aiError) lines.push(`<div class="notice small" style="margin-top:6px">${r.aiLimit ? esc(r.aiError) + ' Used offline matching this time.' : `AI matching failed (${esc(r.aiError)}). Used offline matching instead.`}</div>`);
  else if (r.remaining != null) lines.push(`<div class="small muted">Free AI: ${r.remaining} of ${r.limit ?? 10} uses left today.</div>`);
  else if (r.mode === 'offline') lines.push('<div class="small muted">Matched with offline keywords.</div>');
  if (r.fallbackModel) lines.push(`<div class="small muted">Your Gemini model was busy, so ${esc(r.fallbackModel)} answered instead.</div>`);
  lines.push('<div class="small muted" style="margin-top:6px">Nothing was submitted. Please review the form before submitting.</div>');
  showResult(`<div class="card" style="padding:10px">${lines.join('')}</div>`);
}

boot();
