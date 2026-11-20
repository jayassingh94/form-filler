import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as IP from '../lib/imgproc.js';
import { PRESETS, presetRule } from '../lib/presets.js';
import { extractUploadRules } from '../lib/ai.js';

test('target size from rules', () => {
  assert.deepEqual(IP.computeTarget({ width: 200, height: 230 }, 3000, 4000), { w: 200, h: 230, exact: true });
  // pixel range, square crop -> within range
  const r = IP.computeTarget({ minWidth: 350, maxWidth: 1000, minHeight: 350, maxHeight: 1000 }, 2000, 2000);
  assert.ok(r.w >= 350 && r.w <= 1000 && r.w === r.h, JSON.stringify(r));
  // small source is scaled up to the minimum
  const up = IP.computeTarget({ minWidth: 350, maxWidth: 1000, minHeight: 350, maxHeight: 1000 }, 200, 200);
  assert.deepEqual([up.w, up.h], [350, 350]);
  // width only keeps the crop's shape
  assert.deepEqual(IP.computeTarget({ width: 300 }, 600, 400), { w: 300, h: 200, exact: false });
  // no rules: capped long side
  assert.ok(IP.computeTarget({}, 4000, 3000).w <= 600);
  assert.equal(IP.aspectFor({ width: 140, height: 60 }).fixed, 140 / 60);
  assert.ok(IP.aspectFor({ minWidth: 350, maxWidth: 1000, minHeight: 350, maxHeight: 1000 }).min < 1);
});

test('crop helpers', () => {
  assert.deepEqual(IP.centeredCrop(1000, 500, 1), { x: 250, y: 0, w: 500, h: 500 });
  const g = IP.growToAspect({ x: 100, y: 100, w: 200, h: 20 }, 140 / 60);
  assert.ok(Math.abs(g.w / g.h - 140 / 60) < 1e-9 && g.w === 200);
});

test('KB window works for both 1000- and 1024-byte kilobytes', () => {
  assert.deepEqual(IP.byteWindow(20, 50), { lo: 20480, hi: 50000 });
  assert.deepEqual(IP.byteWindow(undefined, 100), { lo: 0, hi: 100000 });
  const tiny = IP.byteWindow(19.9, 20); // empty strict window -> falls back
  assert.ok(tiny.lo <= tiny.hi);
});

test('signature clean-up: paper becomes white, ink stays dark', () => {
  // 2 pixels: grey paper (190) and blue ink
  const px = new Uint8ClampedArray([190, 188, 185, 255, 30, 40, 140, 255]);
  const hist = IP.luminanceHistogram(new Uint8ClampedArray([...px, ...px, ...px]));
  const t = IP.otsu(hist);
  assert.ok(t > 50 && t < 190, `threshold ${t}`);
  IP.cleanSignature(px, t + 12, { darken: true });
  assert.deepEqual([...px.slice(0, 3)], [255, 255, 255]);
  assert.ok(px[6] > px[4] && px[6] < 140, 'ink keeps its blue tint but darker');
  const ink = IP.inkBounds(new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255, 255, 255, 255, 255, 255, 255, 255, 255]), 2, 2, 128);
  assert.deepEqual(ink, { x: 1, y: 0, w: 1, h: 1 });
});

test('JPEG padding adds COM segments and keeps the image data', () => {
  const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 1, 2, 3, 0xff, 0xd9]);
  const out = IP.padJpeg(jpg, 70000);
  assert.equal(out.length, 70000);
  assert.deepEqual([...out.slice(0, 4)], [0xff, 0xd8, 0xff, 0xfe]);
  // the original segments follow the padding unchanged
  assert.deepEqual([...out.slice(-7)], [0xff, 0xdb, 1, 2, 3, 0xff, 0xd9]);
  // every COM length field is consistent
  let o = 2;
  while (out[o] === 0xff && out[o + 1] === 0xfe) o += 2 + ((out[o + 2] << 8) | out[o + 3]);
  assert.equal(o, out.length - 7);
  assert.throws(() => IP.padJpeg(new Uint8Array([1, 2]), 10));
});

test('presets are well-formed', () => {
  for (const p of PRESETS) {
    for (const [kind, r] of Object.entries(p.rules)) {
      assert.ok(r.width > 0 && r.height > 0 && r.minKB < r.maxKB, `${p.id}/${kind}`);
    }
  }
  assert.deepEqual(presetRule('ibps', 'signature'), { width: 140, height: 60, minKB: 10, maxKB: 20, format: 'jpg', kind: 'signature', source: 'IBPS (PO / Clerk / SO / RRB)' });
  assert.equal(presetRule('ssc', 'thumb'), null, 'no made-up thumb rules');
});

test('AI rule request: page text snippets only, result cleaned', async () => {
  let body;
  globalThis.fetch = async (_u, init) => {
    body = init.body;
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({
      found: true, kind: 'signature', minKB: 10, maxKB: 20, widthCm: 3.5, heightCm: 1.5, format: 'jpg', notes: 'Black ink on white paper'
    }) }] } }] }), { status: 200 });
  };
  const rule = await extractUploadRules('K', 'm', { label: 'Signature', accept: 'image/jpeg', snippets: ['Signature: 10-20 KB, 3.5 cm x 1.5 cm'] });
  assert.ok(body.includes('10-20 KB') && body.includes('FIELD: Signature'));
  assert.ok(!body.includes('inlineData'), 'no image is sent');
  assert.equal(rule.width, 350); assert.equal(rule.height, 150); assert.ok(rule.fromCm);
  assert.equal(rule.kind, 'signature'); assert.equal(rule.maxKB, 20);
});
