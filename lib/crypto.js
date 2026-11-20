// AES-GCM encryption with a key derived from the user's PIN (PBKDF2-SHA256).
// Works in extension pages, the service worker, and Node 20+ (for tests).

export const PBKDF2_ITERATIONS = 600000;

const enc = new TextEncoder();
const dec = new TextDecoder();

export function toB64(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

export function fromB64(b64) {
  const s = atob(b64);
  const u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
  return u8;
}

export function randomBytes(n) {
  return crypto.getRandomValues(new Uint8Array(n));
}

export async function deriveKey(pin, salt, iterations = PBKDF2_ITERATIONS) {
  const base = await crypto.subtle.importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    true, // extractable so the unlocked key can be held in memory-only session storage
    ['encrypt', 'decrypt']
  );
}

export async function exportKey(key) {
  return toB64(await crypto.subtle.exportKey('raw', key));
}

export async function importKey(b64) {
  return crypto.subtle.importKey('raw', fromB64(b64), { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']);
}

export async function encryptBytes(key, data) {
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data);
  return { iv, ct };
}

export async function decryptBytes(key, iv, ct) {
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
}

export async function encryptJSON(key, obj) {
  const { iv, ct } = await encryptBytes(key, enc.encode(JSON.stringify(obj)));
  return { iv: toB64(iv), ct: toB64(ct) };
}

export async function decryptJSON(key, box) {
  const plain = await decryptBytes(key, fromB64(box.iv), fromB64(box.ct));
  return JSON.parse(dec.decode(plain));
}
