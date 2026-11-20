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
