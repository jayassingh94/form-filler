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
  const card = big ? `<div class="mock">
      <div class="mh"><div class="mi">${icon}</div><b>Form <span>Filler</span></b></div>
      <div class="mb"><div class="sel">Fill as <b>Asha (me)</b></div><div class="btn">✦ Fill this form</div>
        <div class="res"><div class="ck"><svg viewBox="0 0 44 44"><defs><linearGradient id="ck" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3b4bd8"/><stop offset=".4" stop-color="#7b4fd6"/><stop offset=".75" stop-color="#d45a9a"/><stop offset="1" stop-color="#f0876a"/></linearGradient></defs><circle cx="22" cy="22" r="20"/><path d="M13.5 22.5l5.5 5.5 11.5-12"/></svg></div>
          <div><div class="hl">Filled 54 <i>·</i> <em>2 need you</em></div><div class="chips"><span>Mobile</span><span>Course</span></div></div></div></div></div>` : '';
  await page.setContent(`<html><head><style>
    body { margin:0; width:${w}px; height:${h}px; overflow:hidden; font-family: Inter, -apple-system, "Segoe UI", Roboto, system-ui, sans-serif;
      background: radial-gradient(${big ? 900 : 380}px ${big ? 520 : 260}px at 88% 110%, rgba(240,135,106,.55), transparent 70%),
        radial-gradient(${big ? 800 : 340}px ${big ? 480 : 240}px at 70% -20%, rgba(123,79,214,.55), transparent 70%),
        radial-gradient(${big ? 600 : 260}px ${big ? 400 : 200}px at 10% 50%, rgba(59,75,216,.35), transparent 70%), #0f1226;
      color:#fff; display:flex; align-items:center; position:relative; }
    body::after { content:''; position:absolute; inset:0; background-image: radial-gradient(rgba(255,255,255,.07) 1px, transparent 1px); background-size: 22px 22px; }
    .wrap { position:relative; z-index:1; display:flex; align-items:center; gap:${big ? 48 : 18}px; padding: 0 ${big ? 88 : 28}px; width:100%; }
    .icon { width:${big ? 120 : 76}px; height:${big ? 120 : 76}px; flex:none; filter: drop-shadow(0 0 ${big ? 40 : 22}px rgba(212,90,154,.55)) drop-shadow(0 10px 24px rgba(0,0,0,.35)); }
    .txt { flex: 1; min-width: 0; }
    h1 { margin:0; font-size:${big ? 64 : 30}px; background: linear-gradient(90deg,#fff 0%,#fff 55%,#ffd9cc 100%); -webkit-background-clip:text; color:transparent; letter-spacing:-.03em; line-height:1.05; font-weight:700; }
    p { margin:${big ? 16 : 8}px 0 0; font-size:${big ? 26 : 14}px; line-height:1.4; color:#dcd6f2; max-width:${big ? 560 : 270}px; }
    .chips { display:flex; gap:${big ? 10 : 6}px; margin-top:${big ? 24 : 12}px; flex-wrap:wrap; }
    .chip { font-size:${big ? 18 : 11}px; font-weight:500; padding:${big ? '7px 14px' : '4px 9px'}; border-radius:99px; background:rgba(255,255,255,.12); border:1px solid rgba(255,255,255,.22); }
    .mock { flex:none; width: 380px; border-radius: 18px; background:#181c36; color:#f4f3fa; box-shadow: 0 30px 60px rgba(0,0,0,.45), 0 0 60px -10px rgba(212,90,154,.45); overflow:hidden; transform: rotate(-2deg); border:1px solid #2a2f52; position:relative; }
    .mock::before { content:''; position:absolute; left:0; right:0; top:0; height:3px; background: linear-gradient(120deg,#3b4bd8,#7b4fd6 36%,#d45a9a 70%,#f0876a); }
    .mh { display:flex; align-items:center; gap:10px; padding: 16px 18px 14px; border-bottom:1px solid #262b4b; font-size:17px; }
    .mh span { background: linear-gradient(120deg,#7b4fd6,#d45a9a,#f0876a); -webkit-background-clip:text; color:transparent; } .mi { width:28px; height:28px; }
    .mb { padding: 16px 18px 20px; display:grid; gap:12px; background:#0f1226; }
    .sel { font-size:14px; color:#a3a1c2; background:#121530; border:1px solid #343a62; border-radius:10px; padding: 10px 12px; } .sel b { color:#f4f3fa; font-weight:600; }
    .btn { background: linear-gradient(90deg, rgba(15,18,38,0), rgba(15,18,38,.22) 28%, rgba(15,18,38,.22) 72%, rgba(15,18,38,0)), linear-gradient(120deg,#3b4bd8,#7b4fd6 36%,#d45a9a 70%,#f0876a); color:#fff; font-weight:600; font-size:16px; text-align:center; padding: 13px; border-radius:12px; box-shadow: 0 10px 24px -8px rgba(212,90,154,.6); }
    .res { display:flex; gap:12px; align-items:center; background:#181c36; border:1px solid #262b4b; border-radius:12px; padding: 14px; }
    .ck svg { width:40px; height:40px; } .ck circle { fill:rgba(123,79,214,.2); stroke:url(#ck); stroke-width:2.5; } .ck path { fill:none; stroke:url(#ck); stroke-width:3; stroke-linecap:round; stroke-linejoin:round; }
    .hl { font-size:18px; font-weight:700; letter-spacing:-.015em; } .hl i { color:#9ca3af; font-style:normal; font-weight:400; } .hl em { color:#f7c46c; font-style:normal; }
    .res .chips { margin-top:6px; gap:6px; } .res .chips span { font-size:12px; padding:3px 9px; border-radius:99px; background:rgba(245,165,36,.12); color:#f7c46c; border:1px solid rgba(247,196,108,.35); }
  </style></head><body><div class="wrap"><div class="icon">${icon}</div><div class="txt">
    <h1>Form Filler</h1>
    <p>${big ? 'Fill job & exam forms and PDFs in one click. Your details stay encrypted on your computer.' : 'Fill application forms & PDFs in one click, privately.'}</p>
    <div class="chips"><span class="chip">Web forms</span><span class="chip">PDF forms</span><span class="chip">Photo &amp; signature</span>${big ? '<span class="chip">हिन्दी</span>' : ''}</div>
  </div>${card}</div></body></html>`);
  await page.screenshot({ path: path.join(ROOT, out) });
}
await promo(440, 280, 'store/promo-small-440x280.png', false);
await promo(1400, 560, 'store/promo-marquee-1400x560.png', true);
await browser.close();
console.log('icons and promo images written');
