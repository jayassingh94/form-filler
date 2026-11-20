// The extension's free-service mode: what it sends to the Form Filler server, and the daily-limit message.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as AI from '../lib/ai.js';
import { BACKEND_URL } from '../lib/config.js';

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

test('off mode never sends anything', async () => {
  let called = false;
  globalThis.fetch = async () => { called = true; };
  await assert.rejects(AI.testGemini({ aiMode: 'off' }), /switched off/);
  assert.equal(called, false);
});
