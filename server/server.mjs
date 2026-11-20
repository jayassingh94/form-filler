// Form Filler AI server: lets people use AI matching without their own Gemini key.
//
// What it does: receives one of the fixed tasks from lib/gemini-core.js (field labels, a blank form page
// image, or upload-rule text), checks and cleans it, builds the Gemini prompt itself, calls Gemini with the
// GEMINI_API_KEY from the environment and returns only the model's answer.
//
// What it does NOT do: store requests or answers, log content, install IDs or IP addresses, accept free-form
// prompts, or accept profile values (the extension never sends them; e-mails / phone numbers / long numbers
// are masked again here as a safety net).
//
// No dependencies: Node 20+ (built-in http, crypto, fetch).

import http from 'node:http';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validateTask, buildBody, callGemini, DEFAULT_MODEL, FALLBACK_MODEL, GEMINI_BASE } from '../lib/gemini-core.js';

const ROOT = new URL('..', import.meta.url);
const MAX_BODY = 6 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * opts: { env, limiter, log, fetchImpl, sleep } (overrides for tests)
 */
export function createServer(opts = {}) {
  const env = { ...process.env, ...(opts.env || {}) };
  const apiKey = env.GEMINI_API_KEY;
  const model = env.GEMINI_MODEL || DEFAULT_MODEL;
  const fallbackModel = env.GEMINI_FALLBACK_MODEL ?? FALLBACK_MODEL;
  const base = env.GEMINI_API_BASE || GEMINI_BASE;
  const allowed = String(env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const limiter = opts.limiter || null;
  const log = opts.log || ((o) => console.log(JSON.stringify(o)));
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  let privacyHtml = null;
  try { privacyHtml = fs.readFileSync(new URL('privacy.html', ROOT), 'utf8').replace(/href="lib\/ui\.css"/, 'href="/ui.css"'); } catch { /* optional */ }
  let uiCss = null;
  try { uiCss = fs.readFileSync(new URL('lib/ui.css', ROOT), 'utf8'); } catch { /* optional */ }

  const corsHeaders = (origin) => {
    if (!origin) return {};
    const ok = allowed.length ? allowed.includes(origin) : /^chrome-extension:\/\/[a-p]{32}$/.test(origin);
    return ok ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Vary': 'Origin' } : {};
  };

  const send = (res, status, obj, origin, extra = {}) => {
    const body = typeof obj === 'string' ? obj : JSON.stringify(obj);
    res.writeHead(status, {
      'Content-Type': typeof obj === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...corsHeaders(origin),
      ...extra
    });
    res.end(body);
  };

  return http.createServer(async (req, res) => {
    const started = Date.now();
    const origin = req.headers.origin || '';
    const path = (req.url || '/').split('?')[0];
    let task = null, status = 500;
    const done = (s, obj, extra) => { status = s; send(res, s, obj, origin, extra); };
    try {
      if (req.method === 'OPTIONS') return done(204, '');
      if (req.method === 'GET' && path === '/healthz') return done(200, { ok: true, configured: !!apiKey });
      if (req.method === 'GET' && path === '/privacy' && privacyHtml) {
        status = 200;
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=3600' });
        return res.end(privacyHtml);
      }
      if (req.method === 'GET' && path === '/ui.css' && uiCss) {
        status = 200;
        res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'public, max-age=3600' });
        return res.end(uiCss);
      }
      if (req.method === 'GET' && path === '/') return done(200, 'Form Filler AI server. See /privacy for what it does with your data.');
      if (req.method !== 'POST' || path !== '/v1/ai') return done(404, { error: 'not_found' });

      if (allowed.length && !allowed.includes(origin)) return done(403, { error: 'forbidden', message: 'This server only answers the Form Filler extension.' });
      if (!apiKey) return done(503, { error: 'not_configured', message: 'The server has no Gemini key configured.' });

      // read the body (bounded)
      const chunks = [];
      let size = 0;
      for await (const c of req) {
        size += c.length;
        if (size > MAX_BODY) {
          // answer, then drop the connection so the unread rest of the upload can't confuse the next request
          done(413, { error: 'too_large', message: 'Request too large.' }, { Connection: 'close' });
          res.on('finish', () => req.destroy());
          return;
        }
        chunks.push(c);
      }
      let input;
      try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return done(400, { error: 'bad_request', message: 'Invalid JSON.' }); }
      task = String(input?.task || '');
      if (!UUID.test(String(input?.installId || ''))) return done(400, { error: 'bad_request', message: 'Missing install ID.' });

      let payload;
      try { payload = validateTask(task, input.payload); } catch (e) { return done(400, { error: 'bad_request', message: e.message }); }

      // daily limits (per install, per network, and for everyone)
      let ticket = null;
      if (limiter && task !== 'ping') {
        ticket = limiter.take(input.installId, clientIp(req));
        if (!ticket.ok) return done(429, { error: ticket.code, message: ticket.message, remaining: 0 });
      }

      try {
        const out = await callGemini({ apiKey, model, body: buildBody(task, payload), fetchImpl, base, fallbackModel, sleep: opts.sleep });
        return done(200, { text: out.text, model: out.model, remaining: ticket?.remaining ?? null, limit: ticket?.limit ?? null });
      } catch (e) {
        ticket?.refund(); // don't count failed calls against anyone
        const busy = e.status === 503;
        return done(busy ? 503 : 502, { error: busy ? 'busy' : 'upstream', message: busy ? e.message : 'The AI service failed. Offline matching still works.' });
      }
    } catch {
      return done(500, { error: 'server_error', message: 'Something went wrong on the server.' });
    } finally {
      // Content-free log line: no payload, no install ID, no IP.
      if (path !== '/healthz') log({ t: new Date().toISOString(), path, task, status, ms: Date.now() - started });
    }
  });
}

/** Caller's IP as seen behind Render's proxy (used only to make a hashed, in-memory counter). */
export function clientIp(req) {
  const xf = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xf || req.socket?.remoteAddress || '';
}

// Start when run directly: `node server/server.mjs`
if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  const { createLimiter } = await import('./limits.mjs').catch(() => ({}));
  const env = process.env;
  const limiter = createLimiter ? createLimiter({
    perInstall: Number(env.DAILY_LIMIT_PER_INSTALL || 10),
    perIp: Number(env.DAILY_LIMIT_PER_IP || 30),
    global: Number(env.GLOBAL_DAILY_CAP || 1000)
  }) : null;
  const port = Number(env.PORT || 8787);
  createServer({ limiter }).listen(port, () => console.log(`Form Filler AI server on :${port}${env.GEMINI_API_KEY ? '' : ' (GEMINI_API_KEY not set!)'}`));
}
