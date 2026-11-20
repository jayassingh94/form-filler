import { test } from 'node:test';
import assert from 'node:assert/strict';

// Minimal in-memory chrome.storage stand-in
function area() {
  let d = {};
  return {
    async get(keys) {
      const ks = keys == null ? Object.keys(d) : Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(ks.filter((k) => k in d).map((k) => [k, structuredClone(d[k])]));
    },
    async set(o) { Object.assign(d, structuredClone(o)); },
    async remove(keys) { for (const k of [].concat(keys)) delete d[k]; },
    async clear() { d = {}; },
    _dump: () => d
  };
}
globalThis.chrome = { storage: { local: area(), session: area() } };

const V = await import('../lib/vault.js');
const S = await import('../lib/schema.js');

test('setup, encrypt at rest, lock, unlock', async () => {
  await V.setupPin('123456');
  assert.ok(await V.isUnlocked());
  const v = await V.loadVault();
  v.profiles[0].personal.firstName = 'Asha';
  v.settings.apiKey = 'SECRET-KEY';
  await V.saveVault(v);
  const raw = JSON.stringify(chrome.storage.local._dump());
  assert.ok(!raw.includes('Asha') && !raw.includes('SECRET-KEY'), 'plaintext must not be stored');
  await V.lock();
  await assert.rejects(V.loadVault(), /LOCKED/);
  assert.deepEqual(await V.unlock('wrong!'), { ok: false, wait: 0 });
  assert.equal((await V.unlock('123456')).ok, true);
  assert.equal((await V.loadVault()).profiles[0].personal.firstName, 'Asha');
});

test('auto-lock after 5 minutes idle', async () => {
  await chrome.storage.session.set({ ff_last: Date.now() - V.AUTO_LOCK_MS - 1000 });
  assert.equal(await V.isUnlocked(), false);
});

test('wrong PIN throttling', async () => {
  for (let i = 0; i < 3; i++) await V.unlock('nope-nope');
  const r = await V.unlock('123456');
  assert.equal(r.ok, false);
  assert.ok(r.wait > 0);
});

test('resolveValue and derived keys', () => {
  const p = S.newProfile('Me');
  Object.assign(p.personal, { firstName: 'Asha', lastName: 'Verma', dob: '1996-03-07' });
  Object.assign(p.permanentAddress, { city: 'Lucknow', state: 'Uttar Pradesh', pincode: '226001' });
  p.currentAddress.sameAsPermanent = true;
  Object.assign(p.education.class10, { marksObtained: '450', maxMarks: '500' });
  p.custom.push({ label: 'Employee code', value: 'E-77' });
  assert.equal(S.resolveValue(p, 'personal.fullName').value, 'Asha Verma');
  assert.deepEqual(S.resolveValue(p, 'personal.dob'), { value: '1996-03-07', kind: 'date' });
  assert.equal(S.resolveValue(p, 'personal.dobMonth').value, '3');
  assert.equal(S.resolveValue(p, 'currentAddress.city').value, 'Lucknow');
  assert.equal(S.resolveValue(p, 'education.class10.percentage').value, '90');
  assert.equal(S.resolveValue(p, 'custom.0').value, 'E-77');
  assert.equal(S.resolveValue(p, 'personal.middleName'), null);
  const cat = S.keyCatalog(p);
  assert.ok(cat.some((c) => c.key === 'custom.0' && c.desc.includes('Employee code')));
  assert.ok(!JSON.stringify(cat).includes('Asha'), 'catalog must not contain values');
});
