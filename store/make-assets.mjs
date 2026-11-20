// Builds the extension icons and the Chrome Web Store images from store/src.
// Usage: node store/make-assets.mjs [--chrome "/path/to/Chrome"]   (needs puppeteer, see store/PUBLISHING.md)
//   icons/icon16.png, icon32.png, icon48.png, icon128.png   – toolbar / extension icons
//   store/icon-128.png      – Web Store icon (96×96 artwork + 16 px transparent padding)
//   store/promo-small-440x280.png, store/promo-marquee-1400x560.png
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const argChrome = process.argv.indexOf('--chrome');
const puppeteer = (await import(process.env.PUPPETEER_PATH || 'puppeteer')).default;
const browser = await puppeteer.launch({ headless: true, executablePath: argChrome > 0 ? process.argv[argChrome + 1] : undefined });
const page = await browser.newPage();

async function renderSvg(svgFile, size, out, pad = 0) {
  const svg = fs.readFileSync(path.join(ROOT, 'store/src', svgFile), 'utf8');
  await page.setViewport({ width: size, height: size, deviceScaleFactor: 1 });
  await page.setContent(`<html><body style="margin:0;background:transparent">
    <div style="width:${size}px;height:${size}px;padding:${pad}px;box-sizing:border-box">${svg.replace('<svg ', '<svg width="100%" height="100%" ')}</div></body></html>`);
  await page.screenshot({ path: path.join(ROOT, out), omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
}

await renderSvg('icon-small.svg', 16, 'icons/icon16.png');
await renderSvg('icon.svg', 32, 'icons/icon32.png');
await renderSvg('icon.svg', 48, 'icons/icon48.png');
await renderSvg('icon.svg', 128, 'icons/icon128.png');
await renderSvg('icon.svg', 128, 'store/icon-128.png', 16);

const icon = fs.readFileSync(path.join(ROOT, 'store/src/icon.svg'), 'utf8').replace('<svg ', '<svg width="100%" height="100%" ');
async function promo(w, h, out, big) {
  await page.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
  await page.setContent(`<html><head><style>
    body { margin:0; width:${w}px; height:${h}px; overflow:hidden; font-family: -apple-system, "Segoe UI", Roboto, system-ui, sans-serif;
      background: linear-gradient(135deg, #0f6b4a 0%, #16805a 45%, #1fa071 100%); color:#fff; display:flex; align-items:center; }
    .wrap { display:flex; align-items:center; gap:${big ? 56 : 22}px; padding: 0 ${big ? 90 : 30}px; }
    .icon { width:${big ? 220 : 110}px; height:${big ? 220 : 110}px; flex:none; filter: drop-shadow(0 8px 18px rgba(0,0,0,.25)); }
    h1 { margin:0; font-size:${big ? 76 : 34}px; letter-spacing:-.02em; line-height:1.05; }
    p { margin:${big ? 18 : 8}px 0 0; font-size:${big ? 30 : 15}px; line-height:1.35; color:#dff5eb; max-width:${big ? 820 : 260}px; }
    .chips { display:flex; gap:10px; margin-top:${big ? 26 : 12}px; flex-wrap:wrap; }
    .chip { font-size:${big ? 22 : 11.5}px; padding:${big ? '8px 16px' : '4px 9px'}; border-radius:99px; background:rgba(255,255,255,.16); border:1px solid rgba(255,255,255,.28); }
  </style></head><body><div class="wrap"><div class="icon">${icon}</div><div>
    <h1>Form Filler</h1>
    <p>${big ? 'Fill job & exam application forms and PDFs in one click. Your details stay encrypted on your computer.' : 'Fill application forms & PDFs in one click, privately.'}</p>
    <div class="chips"><span class="chip">Web forms</span><span class="chip">PDF forms</span><span class="chip">Photo &amp; signature</span>${big ? '<span class="chip">हिन्दी</span>' : ''}</div>
  </div></div></body></html>`);
  await page.screenshot({ path: path.join(ROOT, out) });
}
await promo(440, 280, 'store/promo-small-440x280.png', false);
await promo(1400, 560, 'store/promo-marquee-1400x560.png', true);
await browser.close();
console.log('icons and promo images written');
