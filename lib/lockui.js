// Shared PIN screen for the popup, options page and locker picker.
import { isSetUp, isUnlocked, setupPin, unlock } from './vault.js';
import { icon } from './icons.js';

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
export async function showLock(el, { allowSetup = true, compact = false, bare = false } = {}) {
  const setUp = await isSetUp();
  if (setUp && (await isUnlocked())) {
    el.classList.add('hidden');
    el.innerHTML = '';
    return;
  }
  el.classList.remove('hidden');
  return new Promise((resolve) => {
    const cls = `card lock-card fade-in${compact ? ' compact' : ''}${bare ? ' compact' : ''}`;
    if (!setUp && !allowSetup) {
      el.innerHTML = `<div class="${cls}">
        <div class="lock-ic">${icon('sparkle', 22)}</div>
        <h2>Welcome to Form Filler</h2>
        <p>Set up takes a minute: create a PIN, add your details, and you're ready to fill forms.</p>
        <div class="actions"><button class="primary lg" id="ff-open-setup">Get started</button></div></div>`;
      el.querySelector('#ff-open-setup').onclick = () => chrome.runtime.openOptionsPage();
      return;
    }
    el.innerHTML = setUp
      ? `<form class="${cls}" id="ff-lock-form">
          <div class="lock-ic">${icon('lock', 22)}</div>
          <h2>Welcome back</h2>
          <p>${compact ? 'Enter your PIN to unlock.' : 'Enter your PIN to unlock your details. Form Filler locks itself after 5 minutes without use.'}</p>
          <label><span>PIN</span><input type="password" id="ff-pin" autocomplete="off" autofocus required></label>
          <div class="actions"><button class="primary lg" type="submit">Unlock</button>
          <span id="ff-lock-msg" class="small"></span></div>
        </form>`
      : `<form class="${cls}" id="ff-lock-form">
          ${bare ? '' : `<div class="lock-ic">${icon('shield', 22)}</div>`}
          <h2>Create your PIN</h2>
          <p>Your details and documents are encrypted with this PIN and stay on this computer.
          Use at least 6 characters; letters make it stronger.</p>
          <label><span>New PIN</span><input type="password" id="ff-pin" autocomplete="new-password" minlength="6" required autofocus></label>
          <label><span>Confirm PIN</span><input type="password" id="ff-pin2" autocomplete="new-password" minlength="6" required></label>
          <div class="info small" style="margin-top:16px">There's no way to recover your data if you forget the PIN, so keep it somewhere safe.</div>
          <div class="actions"><button class="primary lg" type="submit">Create PIN</button>
          <span id="ff-lock-msg" class="small"></span></div>
          <div class="fine">${icon('lock', 14)} AES-256 encryption · stored only on this computer</div>
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
      msg.textContent = '';
      btn.dataset.label = btn.textContent;
      btn.textContent = setUp ? 'Unlocking…' : 'Encrypting…';
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
        form.animate?.([{ transform: 'translateX(0)' }, { transform: 'translateX(-6px)' }, { transform: 'translateX(6px)' }, { transform: 'translateX(0)' }], { duration: 220 });
        msg.textContent = err.message;
        pin.value = '';
        pin.focus();
      } finally {
        btn.disabled = false;
        if (btn.dataset.label) btn.textContent = btn.dataset.label;
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
