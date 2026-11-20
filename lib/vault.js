// Encrypted local vault.
//  - chrome.storage.local  : salt, PIN verifier, encrypted vault (profiles, document metadata, settings)
//  - IndexedDB "formfiller": encrypted document bytes
//  - chrome.storage.session: the unlocked key (memory only, never written to disk) + last-activity time
// Nothing here ever leaves the device.

import {
  PBKDF2_ITERATIONS, deriveKey, exportKey, importKey, encryptJSON, decryptJSON,
  encryptBytes, decryptBytes, randomBytes, toB64, fromB64
} from './crypto.js';
import { newProfile } from './schema.js';

export const AUTO_LOCK_MS = 5 * 60 * 1000;
export const DEFAULT_MODEL = 'gemini-3.5-flash-lite';
const VERIFIER_TEXT = 'form-filler-ok';
const META = 'ff_meta';
const VAULT = 'ff_vault';
const FAILS = 'ff_fails';
const S_KEY = 'ff_key';
const S_LAST = 'ff_last';

// ---------- IndexedDB (document bytes) ----------
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('formfiller', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('docs', { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idb(mode, fn) {
  const db = await openDB();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('docs', mode);
      const store = tx.objectStore('docs');
      const req = fn(store);
      tx.oncomplete = () => resolve(req && req.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

// ---------- state ----------
export async function isSetUp() {
  const r = await chrome.storage.local.get(META);
  return !!r[META];
}

export async function getKey() {
  const s = await chrome.storage.session.get([S_KEY, S_LAST]);
  if (!s[S_KEY]) return null;
  if (Date.now() - (s[S_LAST] || 0) > AUTO_LOCK_MS) {
    await lock();
    return null;
  }
  await chrome.storage.session.set({ [S_LAST]: Date.now() });
  return importKey(s[S_KEY]);
}

export async function requireKey() {
  const key = await getKey();
  if (!key) throw new Error('LOCKED');
  return key;
}

export async function isUnlocked() {
  return !!(await getKey());
}

export async function lock() {
  await chrome.storage.session.remove([S_KEY, S_LAST]);
}

/** Called by the background alarm; locks if idle for AUTO_LOCK_MS. */
export async function checkAutoLock() {
  const s = await chrome.storage.session.get([S_KEY, S_LAST]);
  if (s[S_KEY] && Date.now() - (s[S_LAST] || 0) > AUTO_LOCK_MS) await lock();
}

async function holdKey(key) {
  await chrome.storage.session.set({ [S_KEY]: await exportKey(key), [S_LAST]: Date.now() });
}

export function defaultVault() {
  return {
    version: 1,
    profiles: [newProfile('Me')],
    docs: [], // metadata only: {id, name, tags[], type, size, width, height, added}
    settings: { apiKey: '', model: DEFAULT_MODEL }
  };
}

export async function setupPin(pin) {
  validatePin(pin);
  const salt = randomBytes(16);
  const key = await deriveKey(pin, salt, PBKDF2_ITERATIONS);
  const meta = {
    version: 1,
    salt: toB64(salt),
    iterations: PBKDF2_ITERATIONS,
    verifier: await encryptJSON(key, VERIFIER_TEXT)
  };
  await chrome.storage.local.set({ [META]: meta, [VAULT]: await encryptJSON(key, defaultVault()) });
  await holdKey(key);
}

export function validatePin(pin) {
  if (typeof pin !== 'string' || pin.length < 6) throw new Error('PIN must be at least 6 characters.');
}

/** Returns {ok:true} or {ok:false, wait:seconds} */
export async function unlock(pin) {
  const r = await chrome.storage.local.get([META, FAILS]);
  const meta = r[META];
  if (!meta) throw new Error('Not set up');
  const fails = r[FAILS] || { count: 0, at: 0 };
  // Slow down guessing: after 3 wrong PINs wait 2^(n-3) * 5 s (max 10 min).
  if (fails.count >= 3) {
    const waitMs = Math.min(600000, 5000 * 2 ** (fails.count - 3));
    const left = fails.at + waitMs - Date.now();
    if (left > 0) return { ok: false, wait: Math.ceil(left / 1000) };
  }
  const key = await deriveKey(pin, fromB64(meta.salt), meta.iterations);
  try {
    const v = await decryptJSON(key, meta.verifier);
    if (v !== VERIFIER_TEXT) throw new Error('bad');
  } catch {
    await chrome.storage.local.set({ [FAILS]: { count: fails.count + 1, at: Date.now() } });
    return { ok: false, wait: 0 };
  }
  await chrome.storage.local.remove(FAILS);
  await holdKey(key);
  return { ok: true };
}

// ---------- vault ----------
export async function loadVault() {
  const key = await requireKey();
  const r = await chrome.storage.local.get(VAULT);
  const v = await decryptJSON(key, r[VAULT]);
  return { ...defaultVault(), ...v, settings: { ...defaultVault().settings, ...(v.settings || {}) } };
}

export async function saveVault(vault) {
  const key = await requireKey();
  await chrome.storage.local.set({ [VAULT]: await encryptJSON(key, vault) });
}

// ---------- documents ----------
export async function putDocBytes(id, bytes) {
  const key = await requireKey();
  const { iv, ct } = await encryptBytes(key, bytes);
  await idb('readwrite', (s) => s.put({ id, iv, ct }));
}

export async function getDocBytes(id) {
  const key = await requireKey();
  const rec = await idb('readonly', (s) => s.get(id));
  if (!rec) throw new Error('Document not found');
  return decryptBytes(key, rec.iv, rec.ct);
}

export async function deleteDocBytes(id) {
  await idb('readwrite', (s) => s.delete(id));
}

async function allDocRecords() {
  return (await idb('readonly', (s) => s.getAll())) || [];
}

// ---------- PIN change ----------
export async function changePin(oldPin, newPin) {
  validatePin(newPin);
  const res = await unlock(oldPin);
  if (!res.ok) throw new Error(res.wait ? `Too many attempts. Wait ${res.wait}s.` : 'Current PIN is wrong.');
  const oldKey = await requireKey();
  const vault = await loadVault();
  const records = await allDocRecords();
  const salt = randomBytes(16);
  const newKey = await deriveKey(newPin, salt, PBKDF2_ITERATIONS);
  const reenc = [];
  for (const rec of records) {
    const plain = await decryptBytes(oldKey, rec.iv, rec.ct);
    const { iv, ct } = await encryptBytes(newKey, plain);
    reenc.push({ id: rec.id, iv, ct });
  }
  const meta = { version: 1, salt: toB64(salt), iterations: PBKDF2_ITERATIONS, verifier: await encryptJSON(newKey, VERIFIER_TEXT) };
  await idb('readwrite', (s) => { for (const r of reenc) s.put(r); });
  await chrome.storage.local.set({ [META]: meta, [VAULT]: await encryptJSON(newKey, vault) });
  await holdKey(newKey);
}

// ---------- backup ----------
// The backup stays encrypted with the PIN that was active when it was made.
export async function exportBackup() {
  await requireKey();
  const r = await chrome.storage.local.get([META, VAULT]);
  const docs = (await allDocRecords()).map((d) => ({ id: d.id, iv: toB64(d.iv), ct: toB64(d.ct) }));
  return { app: 'form-filler', format: 1, exported: new Date().toISOString(), meta: r[META], vault: r[VAULT], docs };
}

export async function importBackup(backup) {
  if (!backup || backup.app !== 'form-filler' || !backup.meta || !backup.vault) {
    throw new Error('This file is not a Form Filler backup.');
  }
  await deleteAll();
  await chrome.storage.local.set({ [META]: backup.meta, [VAULT]: backup.vault });
  const docs = (backup.docs || []).map((d) => ({ id: d.id, iv: fromB64(d.iv), ct: fromB64(d.ct).buffer }));
  await idb('readwrite', (s) => { for (const d of docs) s.put(d); });
}

// ---------- wipe ----------
export async function deleteAll() {
  await chrome.storage.session.clear();
  await chrome.storage.local.clear();
  await new Promise((resolve) => {
    const req = indexedDB.deleteDatabase('formfiller');
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  });
}
