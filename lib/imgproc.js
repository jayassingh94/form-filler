// Local image processing for photos and signatures: target size, crop fitting, signature clean-up,
// JPEG size targeting. Pure functions except `encodeToRange` / `renderCrop`, which need
// (Offscreen)Canvas. Nothing here sends data anywhere.

const DEFAULT_LONG_SIDE = 600;

/**
 * Pixel size to produce.
 * rule: {width, height} exact, or ranges {minWidth,maxWidth,minHeight,maxHeight}, optional aspect.
 * cropW/cropH: the crop's size in source pixels (its aspect is used when the rule doesn't fix one).
 */
export function computeTarget(rule, cropW, cropH) {
  if (rule.width && rule.height) return { w: Math.round(rule.width), h: Math.round(rule.height), exact: true };
  const a = rule.aspect || cropW / cropH;
  if (rule.width) return { w: rule.width, h: Math.max(1, Math.round(rule.width / a)), exact: false };
  if (rule.height) return { w: Math.max(1, Math.round(rule.height * a)), h: rule.height, exact: false };
  const minW = rule.minWidth || 1, maxW = rule.maxWidth || Infinity;
  const minH = rule.minHeight || 1, maxH = rule.maxHeight || Infinity;
  let w = Math.min(cropW, maxW, a >= 1 ? DEFAULT_LONG_SIDE : DEFAULT_LONG_SIDE * a);
  let h = w / a;
  if (h > maxH) { h = maxH; w = h * a; }
  if (w < minW) { w = minW; h = w / a; }
  if (h < minH) { h = minH; w = h * a; }
  w = Math.min(Math.max(w, minW), maxW);
  h = Math.min(Math.max(h, minH), maxH);
  return { w: Math.round(w), h: Math.round(h), exact: false };
}

/** Allowed crop aspect (w/h) for a rule: fixed for exact sizes, a range for pixel ranges, free otherwise. */
export function aspectFor(rule) {
  if (rule.aspect) return { fixed: rule.aspect };
  if (rule.width && rule.height) return { fixed: rule.width / rule.height };
  if (rule.minWidth || rule.maxWidth || rule.minHeight || rule.maxHeight) {
    return { min: (rule.minWidth || 1) / (rule.maxHeight || 1e6), max: (rule.maxWidth || 1e6) / (rule.minHeight || 1) };
  }
  return {};
}

/** Largest rectangle with aspect `a` centred in w×h. */
export function centeredCrop(w, h, a) {
  if (!a) return { x: 0, y: 0, w, h };
  let cw = w, ch = w / a;
  if (ch > h) { ch = h; cw = h * a; }
  return { x: (w - cw) / 2, y: (h - ch) / 2, w: cw, h: ch };
}

/** Grow box b to aspect a (keeping its centre) — may extend outside the image (filled white later). */
export function growToAspect(b, a) {
  if (!a) return b;
  let { w, h } = b;
  if (w / h > a) h = w / a; else w = h * a;
  return { x: b.x + (b.w - w) / 2, y: b.y + (b.h - h) / 2, w, h };
}

/** Byte window that satisfies the KB range whether the site counts 1 KB as 1000 or 1024 bytes. */
export function byteWindow(minKB, maxKB) {
  const lo = minKB ? Math.ceil(minKB * 1024) : 0;
  const hi = maxKB ? Math.floor(maxKB * 1000) : Infinity;
  if (lo > hi) return { lo: Math.ceil(minKB * 1000), hi: Math.floor(maxKB * 1024) }; // tiny range: fall back
  return { lo, hi };
}

// ---------------- signature clean-up ----------------

/** Otsu threshold over a 256-bin luminance histogram. */
export function otsu(hist) {
  let total = 0, sum = 0;
  for (let i = 0; i < 256; i++) { total += hist[i]; sum += i * hist[i]; }
  let sumB = 0, wB = 0, best = -1, first = 127, last = 127;
  for (let i = 0; i < 256; i++) {
    wB += hist[i];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += i * hist[i];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best * (1 + 1e-9)) { best = between; first = last = i; }
    else if (between >= best * (1 - 1e-9)) last = i; // equally good: remember the plateau
  }
  // With clean two-tone images every threshold between ink and paper scores the same: take the middle.
  return Math.round((first + last) / 2);
}

const lum = (d, i) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];

export function luminanceHistogram(data) {
  const h = new Array(256).fill(0);
  for (let i = 0; i < data.length; i += 4) h[Math.round(lum(data, i))]++;
  return h;
}

/**
 * Paper -> pure white, ink kept (optionally darkened), soft edge to avoid jaggies.
 * data: RGBA Uint8ClampedArray (modified in place). threshold: 0..255 (pixels lighter than it are paper).
 */
export function cleanSignature(data, threshold, { darken = true } = {}) {
  const soft = 28;
  for (let i = 0; i < data.length; i += 4) {
    const L = lum(data, i);
    const t = Math.min(1, Math.max(0, (L - (threshold - soft)) / soft)); // 0 = ink, 1 = paper
    let r = data[i], g = data[i + 1], b = data[i + 2];
    if (darken) { r *= 0.55; g *= 0.55; b *= 0.55; }
    data[i] = r + (255 - r) * t;
    data[i + 1] = g + (255 - g) * t;
    data[i + 2] = b + (255 - b) * t;
    data[i + 3] = 255;
  }
  return data;
}

/** Bounding box of pixels darker than threshold (null if none). */
export function inkBounds(data, width, height, threshold) {
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (lum(data, (y * width + x) * 4) < threshold - 10) {
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

// ---------------- JPEG size targeting ----------------

/**
 * Pads a JPEG to `targetBytes` by inserting COM (comment) segments right after the SOI marker.
 * The picture is unchanged; some portals reject files below a minimum size.
 */
export function padJpeg(bytes, targetBytes) {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error('Not a JPEG');
  let need = targetBytes - bytes.length;
  if (need <= 0) return bytes;
  const segs = [];
  while (need > 0) {
    const payload = Math.max(0, Math.min(65533, need - 4));
    const seg = new Uint8Array(4 + payload);
    seg[0] = 0xff; seg[1] = 0xfe; seg[2] = ((payload + 2) >> 8) & 0xff; seg[3] = (payload + 2) & 0xff;
    seg.fill(0x20, 4); // spaces
    segs.push(seg);
    need -= seg.length;
  }
  const out = new Uint8Array(bytes.length + segs.reduce((n, s) => n + s.length, 0));
  out.set(bytes.subarray(0, 2), 0);
  let o = 2;
  for (const s of segs) { out.set(s, o); o += s.length; }
  out.set(bytes.subarray(2), o);
  return out;
}

/**
 * Encode a canvas to fit a KB range.
 * JPEG: binary-search the quality for the largest file inside the window; pad up to the minimum if asked.
 * PNG: encoded once (size reported).
 */
export async function encodeToRange(canvas, { format = 'jpg', minKB, maxKB, pad = true }) {
  const toBlob = (type, q) => canvas.convertToBlob
    ? canvas.convertToBlob({ type, quality: q })
    : new Promise((res) => canvas.toBlob(res, type, q));
  const { lo, hi } = byteWindow(minKB, maxKB);
  if (format === 'png') {
    const blob = await toBlob('image/png');
    return { blob, quality: null, padded: false, underMin: blob.size < lo, overMax: blob.size > hi };
  }
  let best = null, bestQ = null;
  const top = await toBlob('image/jpeg', 1);
  if (top.size <= hi) { best = top; bestQ = 1; }
  else {
    let a = 0.05, b = 1;
    for (let i = 0; i < 9; i++) {
      const q = (a + b) / 2;
      const blob = await toBlob('image/jpeg', q);
      if (blob.size <= hi) { best = blob; bestQ = q; a = q; } else b = q;
    }
    if (!best) {
      const smallest = await toBlob('image/jpeg', 0.05);
      return { blob: smallest, quality: 0.05, padded: false, underMin: false, overMax: smallest.size > hi };
    }
  }
  let padded = false;
  if (best.size < lo && pad) {
    const target = Math.min(hi, lo + 512); // a little above the minimum
    const bytes = padJpeg(new Uint8Array(await best.arrayBuffer()), target);
    best = new Blob([bytes], { type: 'image/jpeg' });
    padded = true;
  }
  return { blob: best, quality: bestQ, padded, underMin: best.size < lo, overMax: best.size > hi };
}

/**
 * Draw `crop` (source px, may extend outside the image) of `src` into a w×h canvas, white background,
 * stepping down in halves for large reductions (sharper than one big resample).
 */
export function renderCrop(src, crop, w, h, makeCanvas) {
  let cur = src, cx = crop.x, cy = crop.y, cw = crop.w, ch = crop.h;
  // pre-crop onto a white canvas so out-of-image areas are white
  const pre = makeCanvas(Math.max(1, Math.round(cw)), Math.max(1, Math.round(ch)));
  const pc = pre.getContext('2d');
  pc.fillStyle = '#fff'; pc.fillRect(0, 0, pre.width, pre.height);
  pc.drawImage(cur, -cx, -cy);
  cur = pre; cw = pre.width; ch = pre.height;
  while (cw / 2 >= w && ch / 2 >= h) {
    const half = makeCanvas(Math.round(cw / 2), Math.round(ch / 2));
    const hc = half.getContext('2d');
    hc.imageSmoothingQuality = 'high';
    hc.drawImage(cur, 0, 0, half.width, half.height);
    cur = half; cw = half.width; ch = half.height;
  }
  const out = makeCanvas(w, h);
  const oc = out.getContext('2d');
  oc.fillStyle = '#fff'; oc.fillRect(0, 0, w, h);
  oc.imageSmoothingQuality = 'high';
  oc.drawImage(cur, 0, 0, w, h);
  return out;
}
