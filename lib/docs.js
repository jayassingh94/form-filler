// Document locker helpers (extension pages only).
import { loadVault, saveVault, putDocBytes, getDocBytes, deleteDocBytes } from './vault.js';

export const MAX_DOC_BYTES = 20 * 1024 * 1024;

export function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

export async function imageDims(blob) {
  if (!/^image\//.test(blob.type)) return null;
  try {
    const bmp = await createImageBitmap(blob);
    const d = { width: bmp.width, height: bmp.height };
    bmp.close();
    return d;
  } catch {
    return null;
  }
}

/** Adds a document; returns its metadata. */
export async function addDocument(blob, { name, tags = [] }) {
  if (blob.size > MAX_DOC_BYTES) throw new Error(`${name}: larger than ${formatSize(MAX_DOC_BYTES)}.`);
  const id = crypto.randomUUID();
  const dims = await imageDims(blob);
  await putDocBytes(id, await blob.arrayBuffer());
  const meta = {
    id, name, tags, type: blob.type || 'application/octet-stream', size: blob.size,
    width: dims?.width || null, height: dims?.height || null, added: new Date().toISOString()
  };
  const v = await loadVault();
  v.docs.push(meta);
  await saveVault(v);
  return meta;
}

export async function removeDocument(id) {
  const v = await loadVault();
  v.docs = v.docs.filter((d) => d.id !== id);
  await saveVault(v);
  await deleteDocBytes(id);
}

export async function docBlob(meta) {
  return new Blob([await getDocBytes(meta.id)], { type: meta.type });
}

export function guessTags(filename) {
  const n = filename.toLowerCase();
  const tags = [];
  if (/photo|passport|pic|selfie|image/.test(n)) tags.push('photo');
  if (/sign/.test(n)) tags.push('signature');
  if (/mark|result|grade/.test(n)) tags.push('marksheet');
  if (/cert/.test(n)) tags.push('certificate');
  if (/aadha?ar/.test(n)) tags.push('aadhaar');
  if (/caste|categ|obc|ews/.test(n)) tags.push('category');
  if (/10|matric|ssc/.test(n)) tags.push('class10');
  if (/12|inter|hsc/.test(n)) tags.push('class12');
  return tags;
}

export function fileExt(meta) {
  const m = meta.name.match(/\.([a-z0-9]{1,5})$/i);
  if (m) return m[1].toUpperCase();
  return (meta.type.split('/')[1] || 'FILE').toUpperCase().slice(0, 4);
}

/**
 * Resize/compress an image to fit requirements.
 * opts: {width, height, maxKB, minKB, fit: 'cover'|'contain'|'stretch'}
 * Width/height optional: if absent the image keeps its aspect ratio and only shrinks if needed.
 * Returns a JPEG Blob.
 */
export async function resizeImage(blob, opts = {}) {
  const bmp = await createImageBitmap(blob);
  let w = opts.width || 0, h = opts.height || 0;
  if (w && !h) h = Math.round((bmp.height * w) / bmp.width);
  if (h && !w) w = Math.round((bmp.width * h) / bmp.height);
  const fixed = !!(w && h);
  if (!fixed) { w = bmp.width; h = bmp.height; }

  const render = (cw, ch) => {
    const c = new OffscreenCanvas(cw, ch);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; // JPEG has no transparency; signatures on PNG get a white background
    ctx.fillRect(0, 0, cw, ch);
    ctx.imageSmoothingQuality = 'high';
    const fit = opts.fit || 'cover';
    if (!fixed || fit === 'stretch') {
      ctx.drawImage(bmp, 0, 0, cw, ch);
    } else {
      const scale = fit === 'cover' ? Math.max(cw / bmp.width, ch / bmp.height) : Math.min(cw / bmp.width, ch / bmp.height);
      const dw = bmp.width * scale, dh = bmp.height * scale;
      ctx.drawImage(bmp, (cw - dw) / 2, (ch - dh) / 2, dw, dh);
    }
    return c;
  };

  const maxB = opts.maxKB ? opts.maxKB * 1024 : Infinity;
  const minB = opts.minKB ? opts.minKB * 1024 : 0;
  let canvas = render(w, h);
  let out = null;
  for (let attempt = 0; attempt < 12; attempt++) {
    // Binary search JPEG quality for the largest file under maxKB.
    let lo = 0.3, hi = 0.95, best = null;
    const top = await canvas.convertToBlob({ type: 'image/jpeg', quality: hi });
    if (top.size <= maxB) best = top;
    else {
      for (let i = 0; i < 7; i++) {
        const q = (lo + hi) / 2;
        const b = await canvas.convertToBlob({ type: 'image/jpeg', quality: q });
        if (b.size <= maxB) { best = b; lo = q; } else hi = q;
      }
    }
    if (best) { out = best; break; }
    if (fixed) { out = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.3 }); break; }
    // Not fixed size: shrink dimensions and retry.
    w = Math.max(16, Math.round(w * 0.85)); h = Math.max(16, Math.round(h * 0.85));
    canvas = render(w, h);
  }
  bmp.close();
  return { blob: out, width: w, height: h, underMin: out.size < minB, overMax: out.size > maxB };
}
