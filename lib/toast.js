// Small toast notifications for extension pages: toast('Saved'), toast('Could not save', 'err').
import { icon } from './icons.js';

let host;
export function toast(text, kind = 'ok', ms = 2600) {
  if (!host) {
    host = document.createElement('div');
    host.className = 'toasts';
    host.setAttribute('role', 'status');
    host.setAttribute('aria-live', 'polite');
    document.body.append(host);
  }
  const t = document.createElement('div');
  t.className = `toast ${kind}`;
  t.innerHTML = `<span class="ti">${icon(kind === 'err' ? 'x' : kind === 'info' ? 'info' : 'check', 13)}</span><span></span>`;
  t.lastChild.textContent = text;
  host.append(t);
  while (host.children.length > 3) host.firstChild.remove();
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 200); }, ms);
}
