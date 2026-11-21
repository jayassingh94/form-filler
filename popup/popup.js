import { loadVault, lock, isSetUp } from '../lib/vault.js';
import { aiMode, quotaToday, quotaLimit, serviceConfigured } from '../lib/ai.js';
import { showLock, onLocked } from '../lib/lockui.js';
import { sitePattern } from '../lib/site.js';
import { icon, CHECK_ANIM } from '../lib/icons.js';

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
  $('#links').classList.add('hidden');
  $('#lock-now').classList.add('hidden');
  if (!(await isSetUp())) {
    await showLock($('#lock'), { allowSetup: false });
    return;
  }
  await showLock($('#lock'), { compact: true }).catch(() => {});
  let vault;
  try { vault = await loadVault(); } catch { return boot(); }
  $('#main').classList.remove('hidden');
  $('#links').classList.remove('hidden');
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
  $('#ai-note').classList.toggle('off', !(mode === 'service' && serviceConfigured()) && !(mode === 'own' && vault.settings.apiKey));
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
      ? `<div class="info small">Chrome doesn't let extensions run on this page (browser settings, extension pages, the Web Store). Open the web form you want to fill.</div>`
      : `<div class="notice small">Couldn't read this tab's address. Reload the page, then click the Form Filler icon again.</div>`;
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
    setBusy(true);
    showResult(`<div class="res" aria-busy="true"><div class="res-skel"><span class="skeleton circle"></span>
      <div class="lines"><span class="skeleton" style="width:70%;height:14px"></span><span class="skeleton" style="width:45%"></span></div></div>
      <span class="sr-only">Reading the form fields…</span></div>`);
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
      setBusy(false);
    }
  });
};

function setBusy(on) {
  const b = $('#fill');
  b.disabled = on;
  b.classList.toggle('busy', on);
  b.querySelector('.label').textContent = on ? 'Filling…' : 'Fill this form';
}

function showResult(html) { $('#result').innerHTML = html; }

function renderResult(r) {
  const meta = [];
  const m = (ic, html, cls = '') => meta.push(`<div class="m ${cls}">${icon(ic, 15)}<span>${html}</span></div>`);
  if (r.kept) m('check', `${r.kept} already had a value (left as is)`);
  if (r.sensitive) m('shield', `${r.sensitive} sensitive field${r.sensitive === 1 ? '' : 's'} skipped (password, card, bank, OTP…)`);
  if (r.fileInputs) m('paperclip', `${r.fileInputs} upload field${r.fileInputs === 1 ? '' : 's'}: use <b>Pick from locker</b> on the page`);
  if (r.aiError) m('alert', r.aiLimit ? `${esc(r.aiError)} Used offline matching this time.` : `AI matching failed (${esc(r.aiError)}). Used offline matching instead.`, 'warn');
  else if (r.remaining != null) m('sparkle', `Free AI: ${r.remaining} of ${r.limit ?? 10} uses left today`);
  else if (r.mode === 'offline') m('sparkle', 'Matched with offline keywords');
  if (r.fallbackModel) m('info', `Your Gemini model was busy, so ${esc(r.fallbackModel)} answered instead.`);

  let top, secs = '';
  if (r.mode === 'none') {
    top = `<div class="res-top">${CHECK_ANIM(true)}<div><div class="headline">No form fields here</div>
      <div class="sub">Open the page with the application form, then try again.</div></div></div>`;
  } else {
    // "Filled 12 · 2 need you"
    const filled = r.filled ?? r.green;
    const needs = r.needs || [];
    const chips = (list, cls = '', max = 8) => `<div class="chips">${list.slice(0, max).map((n) => `<span class="c ${cls}" title="${esc(n)}">${esc(n)}</span>`).join('')}${list.length > max ? `<span class="c ${cls}">+${list.length - max} more</span>` : ''}</div>`;
    top = `<div class="res-top">${CHECK_ANIM(!filled)}<div>
      <div class="headline">Filled ${filled}${needs.length ? `<span class="sep">·</span><span class="need">${needs.length} need${needs.length === 1 ? 's' : ''} you</span>` : ''}</div>
      <div class="sub">${needs.length ? 'Fill these in yourself:' : filled ? 'Everything we could match is filled.' : 'Nothing matched your profile.'}</div></div></div>`;
    if (needs.length) secs += `<div class="res-sec">${chips(needs)}</div>`;
    if (r.check?.length) secs += `<div class="res-sec"><div class="eyebrow">Please check</div>${chips(r.check, 'check')}</div>`;
  }
  showResult(`<div class="res fade-in">${top}${secs}${meta.length ? `<div class="res-meta">${meta.join('')}</div>` : ''}</div>
    <div class="res-foot">${icon('info', 13)} Nothing was submitted. Review the form before you submit.</div>`);
}
window.__ffRenderResult = renderResult; // used by store/make-screenshots.mjs

boot();
