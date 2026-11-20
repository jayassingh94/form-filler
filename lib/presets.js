// Typical photo / signature rules for common Indian exams.
// IMPORTANT: rules change between exam cycles and the official notification always wins. These values were
// compiled in Nov 2026 from secondary sources (coaching / news sites citing the notices), not from the
// official PDFs, and every value stays editable in the editor.
// Where sources disagreed, the narrowest range that satisfies all of them was chosen.
// cm sizes are converted at 100 px per cm.

export const PRESETS_CHECKED = 'Nov 2026';

export const PRESETS = [
  {
    id: 'ibps', name: 'IBPS (PO / Clerk / SO / RRB)',
    note: 'Widely consistent across sources. SBI forms usually use the same sizes.',
    rules: {
      photo: { width: 200, height: 230, minKB: 20, maxKB: 50, format: 'jpg' },
      signature: { width: 140, height: 60, minKB: 10, maxKB: 20, format: 'jpg' },
      thumb: { width: 240, height: 240, minKB: 20, maxKB: 50, format: 'jpg' }
    }
  },
  {
    id: 'ssc', name: 'SSC (CGL / CHSL / MTS / GD)',
    note: 'Recent SSC forms capture the photo live in the application instead of taking an upload. Photo values are for forms that still ask for a file. Sources differ on the signature width (4 or 6 cm); 4 × 2 cm is used.',
    rules: {
      photo: { width: 350, height: 450, minKB: 20, maxKB: 50, format: 'jpg' },
      signature: { width: 400, height: 200, minKB: 10, maxKB: 20, format: 'jpg' }
    }
  },
  {
    id: 'upsc', name: 'UPSC (OTR / CSE)',
    note: 'Sources range from 20–100 KB up to 20–300 KB and from 350 to 1000 px; the narrowest common values are used. Photo must be square.',
    rules: {
      photo: { width: 350, height: 350, minKB: 20, maxKB: 100, format: 'jpg' },
      signature: { width: 350, height: 150, minKB: 20, maxKB: 100, format: 'jpg' }
    }
  },
  {
    id: 'rrb', name: 'RRB (NTPC / Group D / ALP)',
    note: 'Recent RRB cycles reportedly capture the photo live. The signature is reported as 30–49 KB with at least 140 × 60 px.',
    rules: {
      photo: { width: 350, height: 450, minKB: 20, maxKB: 50, format: 'jpg' },
      signature: { width: 350, height: 150, minKB: 30, maxKB: 49, format: 'jpg' }
    }
  },
  {
    id: 'neet', name: 'NEET UG (NTA)',
    note: 'Passport photo 10–200 KB (3.5 × 4.5 cm) is well reported. The signature range was not confirmed; check the information bulletin.',
    rules: {
      photo: { width: 350, height: 450, minKB: 10, maxKB: 200, format: 'jpg' },
      signature: { width: 350, height: 150, minKB: 4, maxKB: 30, format: 'jpg' }
    }
  }
];

/** Rule for a preset id and kind ('photo'|'signature'|'thumb'); thumb falls back to signature-less photo rules. */
export function presetRule(id, kind) {
  const p = PRESETS.find((x) => x.id === id);
  if (!p) return null;
  const r = p.rules[kind] || (kind === 'thumb' ? null : p.rules.photo);
  return r ? { ...r, kind, source: p.name } : null;
}
