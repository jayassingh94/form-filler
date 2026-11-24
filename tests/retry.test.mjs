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
  await assert.rejects(AI.testGemini('K', 'gemini-3.5-flash-lite'), /busy right now \(503; tried gemini-3\.5-flash-lite 4 times and gemini-3\.6-flash\)\. Try again in about \d+ s\./);
  assert.equal(calls.length, 5);
  assert.equal(AI.lastModelUsed, null);
});

test('Retry-After header is respected; a long one goes to the fallback model instead of waiting', async () => {
  waits.length = 0;
  const calls = script(busy({ 'retry-after': '3' }), busy({ 'retry-after': '60' }), ok('OK'));
  await AI.testGemini('K', 'gemini-3.5-flash-lite');
  assert.ok(waits[0] >= 3000 && waits[0] < 3300, `waited ${waits[0]}`);
  assert.equal(waits.length, 1, 'no 60 s wait');
  assert.deepEqual(calls, ['gemini-3.5-flash-lite', 'gemini-3.5-flash-lite', 'gemini-3.6-flash']);
});

test('other errors are not retried', async () => {
  const calls = script(new Response(JSON.stringify({ error: { message: 'API key not valid' } }), { status: 400 }));
  await assert.rejects(AI.testGemini('bad', 'gemini-3.5-flash-lite'), /Gemini error 400: API key not valid/);
  assert.equal(calls.length, 1);
});

const rateLimited = (secs) => new Response(JSON.stringify({ error: { code: 429, message: 'Resource has been exhausted', status: 'RESOURCE_EXHAUSTED',
  details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: `${secs}s` }] } }), { status: 429 });

test('per-minute limit (429): a short retryDelay is waited for, then it succeeds', async () => {
  waits.length = 0;
  const calls = script(rateLimited(2), ok('OK'));
  await AI.testGemini('K', 'gemini-3.5-flash-lite');
  assert.equal(calls.length, 2);
  assert.ok(waits[0] >= 2000 && waits[0] < 2300, `waited ${waits[0]}`);
});

test('per-minute limit with a long retryDelay: fallback model, then a clear "try again in N s"', async () => {
  waits.length = 0;
  const calls = script(rateLimited(34), rateLimited(34));
  const err = await AI.testGemini('K', 'gemini-3.5-flash-lite').catch((e) => e);
  assert.deepEqual(calls, ['gemini-3.5-flash-lite', 'gemini-3.6-flash'], 'no long waits; the fallback has its own quota');
  assert.match(err.message, /per-minute limit is used up \(429.*Try again in about 34 s/);
  assert.equal(err.busy, true);
  assert.equal(err.retryAfterSec, 34);
  assert.equal(waits.length, 0);
});

test('a request that never answers is abandoned (504) instead of hanging', async () => {
  const { callGemini } = await import('../lib/gemini-core.js');
  const never = (url, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
  const t0 = Date.now();
  const err = await callGemini({ apiKey: 'K', model: 'm', body: {}, fetchImpl: never, timeoutMs: 150, fallbackModel: null, sleep: async () => {} }).catch((e) => e);
  assert.ok(Date.now() - t0 < 2000, 'gave up quickly');
  assert.equal(err.status, 504);
  assert.match(err.message, /no answer within/);
});

test('the whole call stops at its deadline', async () => {
  const { callGemini } = await import('../lib/gemini-core.js');
  let clock = 0;
  const slowBusy = async () => { clock += 25000; return busy(); }; // each try "takes" 25 s
  const err = await callGemini({ apiKey: 'K', model: 'm', body: {}, fetchImpl: slowBusy, deadlineMs: 60000, now: () => clock, sleep: async (ms) => { clock += ms; } }).catch((e) => e);
  assert.ok(err.busy && clock <= 60000 + 25000, `stopped near the deadline (${clock / 1000} s)`);
});

test('no fallback when the chosen model already is the fallback', async () => {
  const calls = script(busy(), busy(), busy(), busy());
  await assert.rejects(AI.testGemini('K', 'gemini-3.6-flash'), /tried gemini-3\.6-flash 4 times\)\. Try again in about/);
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
