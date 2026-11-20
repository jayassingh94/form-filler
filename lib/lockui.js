// Shared PIN screen for the popup, options page and locker picker.
import { isSetUp, isUnlocked, setupPin, unlock } from './vault.js';

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
