// Turns a tab URL into the Chrome match pattern Form Filler asks permission for.
// Match patterns ignore ports, so http://localhost:8765/... -> http://localhost/*

/** Returns {pattern} for pages we can fill, or {reason} explaining why not. */
export function sitePattern(url) {
  if (!url) return { reason: 'unknown' };
  let u;
  try { u = new URL(url); } catch { return { reason: 'unknown' }; }
  if ((u.protocol === 'http:' || u.protocol === 'https:') && u.hostname) {
    // Chrome Web Store pages can never be scripted by extensions.
    if (u.hostname === 'chromewebstore.google.com' || (u.hostname === 'chrome.google.com' && u.pathname.startsWith('/webstore'))) {
      return { reason: 'restricted' };
    }
    const host = u.hostname.includes(':') && !u.hostname.startsWith('[') ? `[${u.hostname}]` : u.hostname;
    return { pattern: `${u.protocol}//${host}/*` };
  }
  if (u.protocol === 'file:') return { pattern: 'file:///*' };
  return { reason: 'restricted' };
}
