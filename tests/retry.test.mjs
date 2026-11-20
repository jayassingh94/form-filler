import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as AI from '../lib/ai.js';

const waits = [];
AI.__setSleepForTests(async (ms) => { waits.push(ms); });

const ok = (text) => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }), { status: 200 });
const busy = (headers = {}) => new Response(JSON.stringify({ error: { message: 'The model is overloaded. Please try again later.' } }), { status: 503, headers });

/** fetch mock answering from a script of responses; records which model each call used. */
function script(...responses) {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(decodeURIComponent(url.match(/models\/([^:]+):/)[1]));
    const r = responses.shift();
    if (!r) throw new Error('unexpected extra request');
    return typeof r === 'function' ? r() : r;
  };
  return calls;
}

test('retries a 503 and succeeds on the same model', async () => {
  waits.length = 0;
  const calls = script(busy(), busy(), ok('OK'));
  await AI.testGemini('K', 'gemini-3.5-flash-lite');
  assert.deepEqual(calls, ['gemini-3.5-flash-lite', 'gemini-3.5-flash-lite', 'gemini-3.5-flash-lite']);
  assert.equal(waits.length, 2);
  assert.ok(waits[0] >= 1000 && waits[0] < 1300 && waits[1] >= 2000 && waits[1] < 2300, `short growing waits: ${waits}`);
  assert.equal(AI.lastModelUsed, 'gemini-3.5-flash-lite');
});

test('after 3 retries falls back to gemini-3.6-flash', async () => {
  waits.length = 0;
  const calls = script(busy(), busy(), busy(), busy(), ok('OK'));
  await AI.testGemini('K', 'gemini-3.5-flash-lite');
  assert.deepEqual(calls, [...Array(4).fill('gemini-3.5-flash-lite'), 'gemini-3.6-flash'], '1 try + 3 retries, then fallback');
  assert.equal(waits.length, 3);
  assert.equal(AI.lastModelUsed, AI.FALLBACK_MODEL);
});

test('clear error when the fallback is busy too', async () => {
  const calls = script(busy(), busy(), busy(), busy(), busy());
  await assert.rejects(AI.testGemini('K', 'gemini-3.5-flash-lite'), /busy right now \(503\).*4 times.*gemini-3\.6-flash once/);
  assert.equal(calls.length, 5);
  assert.equal(AI.lastModelUsed, null);
});

test('Retry-After header is respected (capped at 10 s)', async () => {
  waits.length = 0;
  script(busy({ 'retry-after': '3' }), busy({ 'retry-after': '60' }), ok('OK'));
  await AI.testGemini('K', 'm');
  assert.ok(waits[0] >= 3000 && waits[0] < 3300, `waited ${waits[0]}`);
  assert.ok(waits[1] >= 10000 && waits[1] < 10300, `capped: ${waits[1]}`);
});

test('other errors are not retried', async () => {
  const calls = script(new Response(JSON.stringify({ error: { message: 'API key not valid' } }), { status: 400 }));
  await assert.rejects(AI.testGemini('bad', 'gemini-3.5-flash-lite'), /Gemini error 400: API key not valid/);
  assert.equal(calls.length, 1);
  const c2 = script(new Response('{}', { status: 429 }));
  await assert.rejects(AI.testGemini('K', 'm'), /429/);
  assert.equal(c2.length, 1, '429 (quota) is not treated as high demand');
});

test('no fallback when the chosen model already is the fallback', async () => {
  const calls = script(busy(), busy(), busy(), busy());
  await assert.rejects(AI.testGemini('K', 'gemini-3.6-flash'), /tried gemini-3\.6-flash 4 times\. Please/);
  assert.equal(calls.length, 4);
});

test('a non-503 failure of the fallback is reported clearly', async () => {
  script(busy(), busy(), busy(), busy(), new Response(JSON.stringify({ error: { message: 'model not found' } }), { status: 404 }));
  await assert.rejects(AI.testGemini('K', 'gemini-3.5-flash-lite'), /busy and the fallback gemini-3\.6-flash failed: Gemini error 404: model not found/);
});

test('field mapping goes through the same retry path', async () => {
  const calls = script(busy(), ok(JSON.stringify({ mappings: [{ i: 0, key: 'personal.firstName', confidence: 'high' }] })));
  const m = await AI.mapFieldsWithGemini('K', 'gemini-3.5-flash-lite', [{ tag: 'input', type: 'text', label: 'First name' }], [{ key: 'personal.firstName', desc: 'First name' }]);
  assert.equal(calls.length, 2);
  assert.equal(m.get(0).key, 'personal.firstName');
});
