// Shared PIN screen for the popup, options page and locker picker.
import { isSetUp, isUnlocked, setupPin, unlock } from './vault.js';

// ---------------- show / hide PIN ----------------
const EYE = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_OFF = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.6-7 10-7c2 0 3.8.7 5.2 1.6M22 12s-3.6 7-10 7c-2 0-3.8-.7-5.2-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/><path d="M3 3l18 18"/></svg>';

/**
 * Adds an eye button inside a PIN/password input that toggles between dots and visible text.
 * Starts hidden. Use hideAllPins() to hide every PIN field again.
 */
export function addPinReveal(input) {
  if (!input || input.dataset.ffReveal) return;
  input.dataset.ffReveal = '1';
  input.spellcheck = false;
  input.setAttribute('autocapitalize', 'off');
  const wrap = document.createElement('span');
  wrap.className = 'pin-field';
  input.replaceWith(wrap);
  wrap.append(input);
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'pin-eye';
  if (input.id) btn.setAttribute('aria-controls', input.id);
  const set = (show) => {
    input.type = show ? 'text' : 'password';
    btn.innerHTML = show ? EYE_OFF : EYE;
    btn.setAttribute('aria-pressed', String(show));
    btn.setAttribute('aria-label', show ? 'Hide PIN' : 'Show PIN');
    btn.title = show ? 'Hide PIN' : 'Show PIN';
  };
  input._ffHidePin = () => set(false);
  btn.addEventListener('mousedown', (e) => e.preventDefault()); // keep the cursor in the field
  btn.addEventListener('click', () => {
    const pos = input.selectionStart;
    set(input.type === 'password');
    input.focus();
    try { input.setSelectionRange(pos, pos); } catch { /* not supported for this type */ }
  });
  set(false);
  wrap.append(btn);
}

/** Hide every PIN field on the page (dots again). */
export function hideAllPins(root = document) {
  root.querySelectorAll('input[data-ff-reveal]').forEach((i) => i._ffHidePin?.());
}

// Leaving the page or closing the popup hides any revealed PIN.
addEventListener('pagehide', () => hideAllPins());
document.addEventListener('visibilitychange', () => { if (document.hidden) hideAllPins(); });

/**
 * Renders a setup/unlock form into `el`. Resolves when the vault is unlocked.
 * `allowSetup` false shows a hint to open settings instead of creating a PIN here.
 */
export async function showLock(el, { allowSetup = true, compact = false } = {}) {
  const setUp = await isSetUp();
  if (setUp && (await isUnlocked())) {
    el.classList.add('hidden');
    el.innerHTML = '';
    return;
  }
  el.classList.remove('hidden');
  return new Promise((resolve) => {
    if (!setUp && !allowSetup) {
      el.innerHTML = `<div class="card"><h2>Welcome to Form Filler</h2>
        <p>Create your PIN and profile first.</p>
        <button class="primary" id="ff-open-setup">Open setup</button></div>`;
      el.querySelector('#ff-open-setup').onclick = () => chrome.runtime.openOptionsPage();
      return;
    }
    el.innerHTML = setUp
      ? `<form class="card" id="ff-lock-form">
          <h2>🔒 Form Filler is locked</h2>
          ${compact ? '' : '<p class="muted">Enter your PIN to unlock. It locks itself after 5 minutes without use.</p>'}
          <label><span>PIN</span><input type="password" id="ff-pin" autocomplete="off" autofocus required></label>
          <div class="row" style="margin-top:10px"><button class="primary" type="submit">Unlock</button>
          <span id="ff-lock-msg" class="small"></span></div>
        </form>`
      : `<form class="card" id="ff-lock-form">
          <h2>Create your PIN</h2>
          <p class="muted">Your profiles and documents are encrypted with this PIN and stored only on this computer.
          There is <b>no way to recover data if you forget it</b>. Use at least 6 characters; a longer PIN with letters is stronger.</p>
          <label><span>New PIN</span><input type="password" id="ff-pin" autocomplete="new-password" minlength="6" required autofocus></label>
          <label style="margin-top:8px"><span>Confirm PIN</span><input type="password" id="ff-pin2" autocomplete="new-password" minlength="6" required></label>
          <div class="row" style="margin-top:10px"><button class="primary" type="submit">Create PIN</button>
          <span id="ff-lock-msg" class="small"></span></div>
        </form>`;
    const form = el.querySelector('#ff-lock-form');
    const msg = el.querySelector('#ff-lock-msg');
    const pin = el.querySelector('#ff-pin');
    el.querySelectorAll('#ff-pin, #ff-pin2').forEach(addPinReveal);
    pin.focus();
    form.onsubmit = async (e) => {
      e.preventDefault();
      const btn = form.querySelector('button[type=submit]');
      btn.disabled = true;
      msg.className = 'small muted';
      msg.textContent = 'Working…';
      try {
        if (!setUp) {
          if (pin.value !== el.querySelector('#ff-pin2').value) throw new Error('PINs do not match.');
          await setupPin(pin.value);
        } else {
          const r = await unlock(pin.value);
          if (!r.ok) throw new Error(r.wait ? `Too many wrong attempts. Try again in ${r.wait} s.` : 'Wrong PIN.');
        }
        hideAllPins(el); // hidden again before the screen goes away
        el.classList.add('hidden');
        el.innerHTML = '';
        resolve();
      } catch (err) {
        msg.className = 'small err';
        msg.textContent = err.message;
        pin.value = '';
        pin.focus();
      } finally {
        btn.disabled = false;
      }
    };
  });
}

/** Calls cb when the vault gets locked (auto-lock or "Lock now" elsewhere). */
export function onLocked(cb) {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'session' && changes.ff_key && !changes.ff_key.newValue) cb();
    if (areaName === 'local' && changes.ff_meta && !changes.ff_meta.newValue) cb();
  });
}
