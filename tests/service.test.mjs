// The extension's free-service mode: what it sends to the Form Filler server, and the daily-limit message.
import { test } from 'node:test';
import assert from 'node:assert/strict';
// this test needs a server address; the repo ships with none (lib/config.js), so point at a fake one
import fs from 'node:fs';
const cfgPath = new URL('../lib/config.js', import.meta.url);
const original = fs.readFileSync(cfgPath, 'utf8');
const BACKEND_URL = 'https://ff-test.example';
fs.writeFileSync(cfgPath, original.replace(/export const BACKEND_URL = '[^']*';/, `export const BACKEND_URL = '${BACKEND_URL}';`));
const AI = await import('../lib/ai.js?service-test');
fs.writeFileSync(cfgPath, original);

// minimal chrome.storage stand-in (install ID + quota)
const store = {};
globalThis.chrome = { storage: { local: { get: async (k) => ({ [k]: store[k] }), set: async (o) => Object.assign(store, o) } } };

test('mode selection', () => {
  assert.equal(AI.aiMode({}), 'service', 'default: free service');
  assert.equal(AI.aiMode({ apiKey: 'K' }), 'own', 'existing users with a key keep it');
  assert.equal(AI.aiMode({ aiMode: 'off', apiKey: 'K' }), 'off');
  assert.ok(AI.aiAvailable({}) && !AI.aiAvailable({ aiMode: 'off' }) && !AI.aiAvailable({ aiMode: 'own' }));
});

test('service mode sends labels + an anonymous install ID to the server, never values or a key', async () => {
  const sent = [];
  globalThis.fetch = async (url, init) => {
    sent.push({ url, body: JSON.parse(init.body), headers: init.headers });
    return new Response(JSON.stringify({ text: JSON.stringify({ mappings: [{ i: 0, key: 'fullName', confidence: 'high' }] }), model: 'gemini-3.5-flash-lite', remaining: 7 }), { status: 200 });
  };
  const m = await AI.mapFieldsWithGemini({ aiMode: 'service' }, [{ tag: 'input', type: 'text', label: 'Full Name', value: 'Asha Verma' }], [{ key: 'personal.fullName', desc: 'Full name' }]);
  assert.equal(m.get(0).key, 'personal.fullName', 'key names still repaired');
  assert.equal(sent[0].url, `${BACKEND_URL}/v1/ai`);
  assert.equal(sent[0].body.task, 'map');
  assert.match(sent[0].body.installId, /^[0-9a-f-]{36}$/);
  assert.ok(!JSON.stringify(sent[0]).includes('Asha'), 'no values');
  assert.ok(!JSON.stringify(sent[0]).includes('x-goog-api-key'), 'no Gemini key from the browser');
  assert.equal(AI.lastRemaining, 7);
  assert.equal(await AI.quotaToday(), 7);
  // same install ID next time
  await AI.mapFieldsWithGemini({ aiMode: 'service' }, [{ label: 'Name' }], [{ key: 'personal.fullName', desc: 'x' }]);
  assert.equal(sent[1].body.installId, sent[0].body.installId);
});

test('daily limit: friendly error, quota 0; unreachable server: clear message', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ error: 'daily_limit', message: "You've used today's 10 free AI matches. Offline matching still works, or add your own Gemini key in Settings." }), { status: 429 });
  await assert.rejects(AI.testGemini({ aiMode: 'service' }), (e) => e.limit && /Offline matching still works/.test(e.message));
  globalThis.fetch = async () => new Response(JSON.stringify({ error: 'daily_limit', message: 'limit' }), { status: 429 });
  await assert.rejects(AI.extractUploadRules({ aiMode: 'service' }, { label: 'Photo', snippets: ['20 KB'] }));
  assert.equal(await AI.quotaToday(), 0);
  globalThis.fetch = async () => { throw new TypeError('fetch failed'); };
  await assert.rejects(AI.testGemini({}), /Couldn't reach Form Filler's AI service.*Offline matching still works/);
});

test('no server address configured (as shipped): free mode is unavailable and nothing is contacted', async () => {
  assert.match(original, /export const BACKEND_URL = '';/, 'the repo ships without a server address');
  // a fresh Node process loads the real (empty) config
  const { execFileSync } = await import('node:child_process');
  const code = `
    globalThis.chrome = { storage: { local: { get: async () => ({}), set: async () => {} } } };
    let called = false; globalThis.fetch = async () => { called = true; };
    const AI = await import(${JSON.stringify(new URL('../lib/ai.js', import.meta.url).href)});
    let msg = ''; try { await AI.testGemini({}); } catch (e) { msg = e.message; }
    console.log(JSON.stringify({ configured: AI.serviceConfigured(), available: AI.aiAvailable({}), called, msg }));`;
  const out = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' }).trim().split('\n').pop());
  assert.deepEqual([out.configured, out.available, out.called], [false, false, false]);
  assert.match(out.msg, /isn't set up in this version/);
});

test('off mode never sends anything', async () => {
  let called = false;
  globalThis.fetch = async () => { called = true; };
  await assert.rejects(AI.testGemini({ aiMode: 'off' }), /switched off/);
  assert.equal(called, false);
});
