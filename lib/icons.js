// Inline SVG icons (stroke icons, 24px grid) and empty-state illustrations. No external assets.
const svg = (d, size = 18, extra = '') =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"${extra}>${d}</svg>`;

const PATHS = {
  lock: '<rect x="4.5" y="10.5" width="15" height="10" rx="2.5"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/>',
  unlock: '<rect x="4.5" y="10.5" width="15" height="10" rx="2.5"/><path d="M8 10.5V7.5a4 4 0 0 1 7.6-1.7"/>',
  user: '<circle cx="12" cy="8" r="3.6"/><path d="M4.8 20a7.2 7.2 0 0 1 14.4 0"/>',
  folder: '<path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2.2h7a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>',
  file: '<path d="M14 3.5H7.5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V8z"/><path d="M14 3.5V8h4.5"/><path d="M9 13h6M9 16.5h4"/>',
  pdf: '<path d="M14 3.5H7.5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V8z"/><path d="M14 3.5V8h4.5"/><path d="M8.5 12.5h7M8.5 16h4.5"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  shield: '<path d="M12 3.2 5 6v5.6c0 4.3 3 7.6 7 9.2 4-1.6 7-4.9 7-9.2V6z"/><path d="m9 12 2.2 2.2L15.5 10"/>',
  database: '<ellipse cx="12" cy="6" rx="7" ry="2.8"/><path d="M5 6v6c0 1.5 3.1 2.8 7 2.8s7-1.3 7-2.8V6"/><path d="M5 12v6c0 1.5 3.1 2.8 7 2.8s7-1.3 7-2.8v-6"/>',
  sparkle: '<path d="M12 3.5c.7 4.3 1.9 5.6 6 6.3-4.1.7-5.3 2-6 6.2-.7-4.2-1.9-5.5-6-6.2 4.1-.7 5.3-2 6-6.3z"/><path d="M18.5 15.5c.3 1.8.8 2.3 2.5 2.6-1.7.3-2.2.8-2.5 2.5-.3-1.7-.8-2.2-2.5-2.5 1.7-.3 2.2-.8 2.5-2.6z"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  alert: '<path d="M12 4 2.8 19.5h18.4z"/><path d="M12 10v4M12 17h.01"/>',
  upload: '<path d="M12 15.5V4.5M7.5 9 12 4.5 16.5 9"/><path d="M4.5 15v3a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-3"/>',
  download: '<path d="M12 4.5v11M7.5 11l4.5 4.5 4.5-4.5"/><path d="M4.5 15v3a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>',
  trash: '<path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l.8 12.2a1.5 1.5 0 0 0 1.5 1.3h6.4a1.5 1.5 0 0 0 1.5-1.3L17.5 7"/>',
  edit: '<path d="M4.5 19.5h4l10-10a2.8 2.8 0 0 0-4-4l-10 10z"/>',
  crop: '<path d="M6.5 2.5v14a1 1 0 0 0 1 1h14"/><path d="M2.5 6.5h14a1 1 0 0 1 1 1v14"/>',
  globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.5 2.6 3.6 5.4 3.6 8.5s-1.1 5.9-3.6 8.5c-2.5-2.6-3.6-5.4-3.6-8.5S9.5 6.1 12 3.5z"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m10.8 12.2 8.7-8.7M16 7l2.5 2.5"/>',
  paperclip: '<path d="m20 11.5-8 8a5 5 0 0 1-7-7l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7l-8.4 8.4a1.7 1.7 0 0 1-2.4-2.4l7.6-7.6"/>',
  pin: '<path d="M14.5 3.5 20.5 9.5l-3 1-4 4 .5 4.5-2 2-3.5-3.5L4 22l-.5-.5 4.5-4.5L4.5 13.5l2-2 4.5.5 4-4z"/>',
  puzzle: '<path d="M9 4.5a2 2 0 0 1 4 0V6h3.5a1.5 1.5 0 0 1 1.5 1.5V11h-1.5a2 2 0 0 0 0 4H18v3.5a1.5 1.5 0 0 1-1.5 1.5H13v-1.5a2 2 0 0 0-4 0V20H5.5A1.5 1.5 0 0 1 4 18.5V15h1.5a2 2 0 0 0 0-4H4V7.5A1.5 1.5 0 0 1 5.5 6H9z"/>',
  cursor: '<path d="m5 4 13.5 6.2-5.7 1.9-2 5.9z"/><path d="m13 13 5 5"/>',
  arrowRight: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  external: '<path d="M14 4.5h5.5V10M19.5 4.5 11 13"/><path d="M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 8h.01"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>'
};

export const icon = (name, size = 18, extra = '') => svg(PATHS[name] || '', size, extra);

/** The Form Filler mark (same design as store/src/icon.svg), for headers. */
export const LOGO = (size = 28) => `<img src="${chrome.runtime.getURL('icons/icon128.png')}" width="${size}" height="${size}" alt="">`;

// ---------------- empty-state illustrations (96×96, use currentColor for the accent) ----------------
export const ART = {
  locker: `<svg class="art" viewBox="0 0 96 96" fill="none" aria-hidden="true">
    <rect x="14" y="22" width="68" height="56" rx="10" fill="currentColor" opacity=".08"/>
    <rect x="22" y="14" width="40" height="50" rx="6" fill="var(--panel)" stroke="currentColor" stroke-opacity=".35" stroke-width="2"/>
    <rect x="29" y="23" width="18" height="21" rx="3" fill="currentColor" opacity=".22"/>
    <path d="M29 51h26M29 57h17" stroke="currentColor" stroke-opacity=".35" stroke-width="2.5" stroke-linecap="round"/>
    <rect x="40" y="30" width="38" height="46" rx="6" fill="var(--panel)" stroke="currentColor" stroke-width="2"/>
    <path d="M47 63c4-6 7 3 11-3s6 2 9-2" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>
    <path d="M47 41h24M47 48h16" stroke="currentColor" stroke-opacity=".45" stroke-width="2.5" stroke-linecap="round"/>
    <circle cx="74" cy="74" r="11" fill="currentColor"/><path d="M74 69v10M69 74h10" stroke="#fff" stroke-width="2.5" stroke-linecap="round"/>
  </svg>`,
  pdf: `<svg class="art" viewBox="0 0 96 96" fill="none" aria-hidden="true">
    <circle cx="48" cy="50" r="38" fill="currentColor" opacity=".08"/>
    <path d="M30 16h26l14 14v46a4 4 0 0 1-4 4H30a4 4 0 0 1-4-4V20a4 4 0 0 1 4-4z" fill="var(--panel)" stroke="currentColor" stroke-width="2"/>
    <path d="M56 16v14h14" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>
    <path d="M34 40h10" stroke="currentColor" stroke-opacity=".45" stroke-width="2.5" stroke-linecap="round"/>
    <path d="M46 40h16" stroke="currentColor" stroke-width="2" stroke-dasharray="2 3"/>
    <path d="M34 50h8" stroke="currentColor" stroke-opacity=".45" stroke-width="2.5" stroke-linecap="round"/>
    <rect x="44" y="46" width="18" height="8" rx="2" fill="currentColor" opacity=".18"/>
    <path d="M34 60h12" stroke="currentColor" stroke-opacity=".45" stroke-width="2.5" stroke-linecap="round"/>
    <path d="M48 60h14" stroke="currentColor" stroke-width="2" stroke-dasharray="2 3"/>
    <path d="M70 58c.9 5 1.8 5.9 6.8 6.8-5 .9-5.9 1.8-6.8 6.8-.9-5-1.8-5.9-6.8-6.8 5-.9 5.9-1.8 6.8-6.8z" fill="currentColor"/>
  </svg>`,
  sites: `<svg class="art" viewBox="0 0 96 96" fill="none" aria-hidden="true">
    <rect x="12" y="20" width="72" height="56" rx="8" fill="var(--panel)" stroke="currentColor" stroke-opacity=".4" stroke-width="2"/>
    <path d="M12 32h72" stroke="currentColor" stroke-opacity=".4" stroke-width="2"/>
    <circle cx="20" cy="26" r="2" fill="currentColor" opacity=".5"/><circle cx="27" cy="26" r="2" fill="currentColor" opacity=".5"/>
    <path d="M48 42 37 46v7c0 6 4.6 10.6 11 13 6.4-2.4 11-7 11-13v-7z" fill="currentColor" opacity=".14" stroke="currentColor" stroke-width="2"/>
    <path d="m43 54 3.5 3.5L53 51" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`,
  fields: `<svg class="art" viewBox="0 0 96 96" fill="none" aria-hidden="true">
    <rect x="16" y="22" width="64" height="16" rx="5" fill="var(--panel)" stroke="currentColor" stroke-opacity=".4" stroke-width="2"/>
    <rect x="16" y="44" width="64" height="16" rx="5" fill="var(--panel)" stroke="currentColor" stroke-width="2" stroke-dasharray="4 4"/>
    <path d="M48 48v8M44 52h8" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>
    <path d="M23 30h20" stroke="currentColor" stroke-opacity=".4" stroke-width="2.5" stroke-linecap="round"/>
  </svg>`,
  docs: `<svg class="art" viewBox="0 0 96 96" fill="none" aria-hidden="true">
    <rect x="22" y="18" width="40" height="52" rx="6" fill="var(--panel)" stroke="currentColor" stroke-opacity=".4" stroke-width="2"/>
    <rect x="34" y="28" width="40" height="52" rx="6" fill="var(--panel)" stroke="currentColor" stroke-width="2"/>
    <circle cx="54" cy="46" r="7" fill="currentColor" opacity=".2"/>
    <path d="M42 68c3-6 21-6 24 0" stroke="currentColor" stroke-opacity=".5" stroke-width="2.5" stroke-linecap="round"/>
  </svg>`
};

/** Animated success check (or a "needs attention" variant). */
export const CHECK_ANIM = (warn = false) => `<svg class="check-anim${warn ? ' warn' : ''}" viewBox="0 0 44 44" aria-hidden="true">
  <defs><linearGradient id="ff-sunset" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3b4bd8"/><stop offset=".36" stop-color="#7b4fd6"/>
  <stop offset=".7" stop-color="#d45a9a"/><stop offset="1" stop-color="#f0876a"/></linearGradient></defs>
  <circle cx="22" cy="22" r="20"/><path d="M13.5 22.5l5.5 5.5 11.5-12"/></svg>`;
