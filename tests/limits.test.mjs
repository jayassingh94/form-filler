import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createLimiter } from '../server/limits.mjs';
import { createServer } from '../server/server.mjs';

const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';

test('10 calls per install per day, then a friendly message', () => {
  const L = createLimiter({ perInstall: 10, perIp: 100, global: 1000 });
  for (let i = 0; i < 10; i++) assert.equal(L.take(A, '1.2.3.4').remaining, 9 - i);
  const no = L.take(A, '1.2.3.4');
  assert.equal(no.ok, false);
  assert.equal(no.code, 'daily_limit');
  assert.match(no.message, /used today's 10 free AI matches\. Offline matching still works/);
  assert.equal(L.take(B, '5.6.7.8').ok, true, 'another install is unaffected');
});

test('per-network and global caps; refunds; daily reset', () => {
  let t = Date.parse('2026-11-20T10:00:00Z');
  const L = createLimiter({ perInstall: 10, perIp: 3, global: 5, now: () => t });
  // new install IDs from the same network don't get around the limit
  for (let i = 0; i < 3; i++) assert.ok(L.take(`0000000${i}-0000-4000-8000-000000000000`, '9.9.9.9').ok);
  assert.equal(L.take('00000009-0000-4000-8000-000000000000', '9.9.9.9').code, 'daily_limit');
  // a failed call is refunded
  const r = L.take(A, '1.1.1.1'); r.refund(); r.refund();
  assert.equal(L.stats().total, 3);
  assert.ok(L.take(A, '1.1.1.1').ok && L.take(B, '2.2.2.2').ok);
  const g = L.take('33333333-3333-4333-8333-333333333333', '3.3.3.3');
  assert.equal(g.code, 'global_limit');
  assert.match(g.message, /limit for everyone\. Offline matching still works/);
  // next UTC day: everything resets
  t = Date.parse('2026-11-21T00:00:01Z');
  assert.ok(L.take(A, '9.9.9.9').ok);
  assert.equal(L.stats().total, 1);
});

test('server: the 11th call of the day gets HTTP 429 with the message; failed calls are not counted', async () => {
  let fail = false;
  const gemini = http.createServer(async (req, res) => {
    for await (const _ of req);
    res.writeHead(fail ? 500 : 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(fail ? { error: { message: 'boom' } } : { candidates: [{ content: { parts: [{ text: '{}' }] } }] }));
  }).listen(0);
  const server = createServer({
    env: { GEMINI_API_KEY: 'K', GEMINI_API_BASE: `http://127.0.0.1:${gemini.address().port}/v1beta` },
    limiter: createLimiter({ perInstall: 10, perIp: 100, global: 100 }),
    log: () => {}, sleep: async () => {}
  }).listen(0);
  const url = `http://127.0.0.1:${server.address().port}/v1/ai`;
  const call = () => fetch(url, { method: 'POST', body: JSON.stringify({ installId: A, task: 'rules', payload: { label: 'Photo', snippets: ['20-50 KB'] } }) });
  try {
    fail = true;
    assert.equal((await call()).status, 502);
    fail = false;
    let last;
    for (let i = 0; i < 10; i++) { last = await call(); assert.equal(last.status, 200); }
    assert.equal((await last.json()).remaining, 0, 'the failed call was not counted');
    const r = await call();
    assert.equal(r.status, 429);
    const j = await r.json();
    assert.equal(j.error, 'daily_limit');
    assert.match(j.message, /Offline matching still works/);
    // a connection test never uses up the allowance
    const ping = await fetch(url, { method: 'POST', body: JSON.stringify({ installId: A, task: 'ping', payload: {} }) });
    assert.equal(ping.status, 200);
  } finally { server.close(); gemini.close(); }
});
