// Daily limits for the free AI service, kept only in memory (nothing written to disk, reset every UTC day
// and whenever the server restarts).
//  - per install: each extension install has a random anonymous ID; default 10 AI calls per day
//  - per network: a salted hash of the caller's IP (salt changes daily, never stored); default 30 per day,
//    because install IDs are free to regenerate
//  - global: a cap for everyone together, to bound the cost of the shared key

import crypto from 'node:crypto';

export const RESET_NOTE = 'It resets at midnight UTC (5:30 AM IST).';

export function limitMessage(code, perInstall) {
  if (code === 'global_limit') {
    return `Form Filler's free AI has reached today's limit for everyone. Offline matching still works, or add your own Gemini key in Settings. ${RESET_NOTE}`;
  }
  return `You've used today's ${perInstall} free AI matches. Offline matching still works, or add your own Gemini key in Settings. ${RESET_NOTE}`;
}

export function createLimiter({ perInstall = 10, perIp = 30, global = 1000, now = () => Date.now() } = {}) {
  let day = null, installs = new Map(), ips = new Map(), total = 0, salt = null;
  const roll = () => {
    const d = new Date(now()).toISOString().slice(0, 10);
    if (d !== day) { day = d; installs = new Map(); ips = new Map(); total = 0; salt = crypto.randomBytes(16); }
  };
  const h = (v) => crypto.createHmac('sha256', salt).update(String(v)).digest('base64url').slice(0, 22);

  return {
    /** Reserve one AI call. Returns { ok, remaining, refund() } or { ok: false, code, message }. */
    take(installId, ip) {
      roll();
      const k = h(installId), n = installs.get(k) || 0;
      const ipKey = ip ? h('ip:' + ip) : null, m = ipKey ? ips.get(ipKey) || 0 : 0;
      if (total >= global) return { ok: false, code: 'global_limit', message: limitMessage('global_limit', perInstall) };
      if (n >= perInstall || (ipKey && m >= perIp)) return { ok: false, code: 'daily_limit', message: limitMessage('daily_limit', perInstall) };
      installs.set(k, n + 1);
      if (ipKey) ips.set(ipKey, m + 1);
      total++;
      const takenDay = day;
      let refunded = false;
      return {
        ok: true,
        remaining: perInstall - n - 1,
        refund() { // a failed call doesn't count
          if (refunded || takenDay !== day) return;
          refunded = true;
          installs.set(k, Math.max(0, (installs.get(k) || 1) - 1));
          if (ipKey) ips.set(ipKey, Math.max(0, (ips.get(ipKey) || 1) - 1));
          total = Math.max(0, total - 1);
        }
      };
    },
    stats() { roll(); return { day, total, installs: installs.size }; }
  };
}
