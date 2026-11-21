// Builds the 5 Chrome Web Store screenshots (1280×800) from the real extension with the demo profile (fake data).
// Usage: node store/make-screenshots.mjs --chrome "/path/to/Chrome for Testing"   (needs puppeteer; see PUBLISHING.md)
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import os from 'node:os';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const OUT = path.join(ROOT, 'store/screenshots');
fs.mkdirSync(OUT, { recursive: true });
const argChrome = process.argv.indexOf('--chrome');
const puppeteer = (await import(process.env.PUPPETEER_PATH || 'puppeteer')).default;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFn = (ctx, fn, t = 30000) => ctx.waitForFunction(fn, { polling: 200, timeout: t });

// serve test/ for the sample web form
const files = http.createServer((req, res) => {
  const f = path.join(ROOT, 'test', decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, ''));
  if (!f.startsWith(path.join(ROOT, 'test')) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': f.endsWith('.html') ? 'text/html' : 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
}).listen(0);
const FORM = `http://localhost:${files.address().port}/sample-form.html`;

// a copy of the extension that may run on localhost
const EXT = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-shots-'));
fs.cpSync(ROOT, EXT, { recursive: true, filter: (p) => !/\/(\.git|server|store|tests|node_modules)(\/|$)/.test(p.slice(ROOT.length)) });
const man = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json')));
man.host_permissions.push('http://localhost/*');
fs.writeFileSync(path.join(EXT, 'manifest.json'), JSON.stringify(man));
// Show the published setup (free AI configured) without contacting anything: an unused local port that fails at once.
fs.writeFileSync(path.join(EXT, 'lib/config.js'), "export const BACKEND_URL = 'http://localhost:9';\n");

const browser = await puppeteer.launch({ headless: true, pipe: true, enableExtensions: [EXT], executablePath: argChrome > 0 ? process.argv[argChrome + 1] : undefined });
const shots = {};
try {
  const sw = await browser.waitForTarget((t) => t.type() === 'service_worker');
  const id = new URL(sw.url()).host;
  const light = async (p) => p.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);

  // set up: PIN, demo profile, locker documents
  const opt = await browser.newPage();
  await light(opt);
  await opt.setViewport({ width: 1180, height: 640, deviceScaleFactor: 2 });
  await opt.goto(`chrome-extension://${id}/options/options.html`);
  await opt.evaluate(async () => {
    const V = await import('/lib/vault.js'); const { demoProfile } = await import('/lib/demo.js'); const D = await import('/lib/docs.js');
    await V.setupPin('demo-pin-123');
    const v = await V.loadVault();
    const me = demoProfile(); me.label = 'Me (demo)';
    const sp = demoProfile(); sp.label = 'Vikram (demo)';
    v.profiles = [me, sp]; v.settings.aiMode = 'service'; await V.saveVault(v);
    const c = new OffscreenCanvas(900, 1100); const x = c.getContext('2d');
    const g = x.createLinearGradient(0, 0, 0, 1100); g.addColorStop(0, '#dbeafe'); g.addColorStop(1, '#bfdbfe'); x.fillStyle = g; x.fillRect(0, 0, 900, 1100);
    x.fillStyle = '#334155'; x.beginPath(); x.arc(450, 420, 190, 0, 7); x.fill(); x.beginPath(); x.ellipse(450, 1000, 330, 300, 0, 0, 7); x.fill();
    await D.addDocument(await c.convertToBlob({ type: 'image/jpeg', quality: 0.92 }), { name: 'passport-photo.jpg', tags: ['photo'] });
    const s = new OffscreenCanvas(1400, 700); const y = s.getContext('2d'); y.fillStyle = '#c9c6bf'; y.fillRect(0, 0, 1400, 700);
    y.strokeStyle = '#1f2f8f'; y.lineWidth = 9; y.lineCap = 'round'; y.beginPath(); y.moveTo(380, 400);
    for (let t = 380; t <= 1040; t += 8) y.lineTo(t, 360 + Math.sin(t / 32) * 55 - (t > 820 ? 30 : 0)); y.stroke();
    await D.addDocument(await s.convertToBlob({ type: 'image/jpeg', quality: 0.92 }), { name: 'signature.jpg', tags: ['signature'] });
  });

  // 1. web form filled + popup result
  const form = await browser.newPage();
  await light(form);
  await form.setViewport({ width: 860, height: 640, deviceScaleFactor: 2 });
  await form.goto(FORM);
  const popup = await browser.newPage();
  await light(popup);
  await popup.setViewport({ width: 360, height: 600, deviceScaleFactor: 2 });
  await popup.goto(`chrome-extension://${id}/popup/popup.html`);
  const tabId = await popup.evaluate(async (u) => (await chrome.tabs.query({ url: u }))[0].id, FORM);
  const r = await popup.evaluate((tabId) => chrome.runtime.sendMessage({ type: 'ff-fill', tabId }), tabId);
  await popup.evaluate((r) => {
    // the popup's real result card, as the user sees it after clicking "Fill this form"
    r.aiError = null; r.remaining = 9; r.limit = 10;
    window.__ffRenderResult(r);
    document.querySelector('#ai-note').classList.add('hidden');
    document.querySelector('#fill').disabled = false; // as on a real web page (this popup runs as a tab here)
  }, r);
  await sleep(700); // let the check animation finish
  await form.bringToFront();
  await form.evaluate(() => { window.scrollTo(0, 0); document.getElementById('ff-panel-host')?.remove(); });
  await sleep(400);
  shots.form = await form.screenshot({ encoding: 'base64' });
  await popup.bringToFront(); await sleep(200);
  shots.popup = await popup.screenshot({ encoding: 'base64', fullPage: true });

  // 2. profile page
  await opt.bringToFront();
  await opt.reload();
  await waitFn(opt, () => !!document.querySelector('#app:not(.hidden)'));
  await opt.evaluate(() => { document.querySelectorAll('#profile-form details').forEach((d, i) => { d.open = i < 2; }); });
  await sleep(300);
  shots.profile = await opt.screenshot({ encoding: 'base64' });

  // 5. settings: AI choices
  await opt.$eval('#tabs button[data-tab=settings]', (b) => b.click());
  await sleep(300);
  shots.settings = await opt.screenshot({ encoding: 'base64' });

  // 3. Fill a PDF (bilingual sample, offline detection)
  const pdf = await browser.newPage();
  await light(pdf);
  await pdf.setViewport({ width: 1180, height: 640, deviceScaleFactor: 2 });
  await pdf.goto(`chrome-extension://${id}/pdf/pdf.html`);
  await pdf.bringToFront();
  await waitFn(pdf, () => !!document.querySelector('#app:not(.hidden)'));
  await (await pdf.$('#file')).uploadFile(path.join(ROOT, 'test/sample-bilingual-form.pdf'));
  await waitFn(pdf, () => !!document.querySelector('#detect-flat:not(.hidden)'));
  await pdf.$eval('#run-offline', (b) => b.click());
  await waitFn(pdf, () => /filled/.test(document.querySelector('#progress').textContent));
  await sleep(500);
  await pdf.evaluate(() => { document.querySelector('#pages').scrollTo(0, 40); });
  shots.pdf = await pdf.screenshot({ encoding: 'base64' });

  // 4. photo editor in the locker picker (IBPS preset on the photo)
  await form.bringToFront();
  await form.setViewport({ width: 1180, height: 640, deviceScaleFactor: 2 });
  await form.evaluate(() => document.querySelector('[name=photo]').scrollIntoView({ block: 'center' }));
  await (await form.$$('span[data-ff-ui]'))[0].click();
  let fr;
  for (let k = 0; k < 50 && !fr; k++) { fr = form.frames().find((f) => f.url().includes('/picker/picker.html')); if (!fr) await sleep(200); }
  await waitFn(fr, () => !!document.querySelector('.item'));
  await fr.evaluate(() => [...document.querySelectorAll('.item')].find((i) => /passport-photo/.test(i.innerText)).querySelector('[data-act=resize]').click());
  await waitFn(fr, () => /px ·/.test(document.querySelector('#ie-stats')?.textContent || ''));
  await sleep(800);
  shots.photo = await form.screenshot({ encoding: 'base64' });
} finally {
  await browser.close();
  files.close();
  fs.rmSync(EXT, { recursive: true, force: true });
}

// compose 1280×800 images with a caption
const composer = await puppeteer.launch({ headless: true, executablePath: argChrome > 0 ? process.argv[argChrome + 1] : undefined });
const page = await composer.newPage();
await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
const img = (b64) => `data:image/png;base64,${b64}`;
const frame = (title, sub, inner) => `<html><head><style>
  body { margin:0; width:1280px; height:800px; overflow:hidden; font-family: Inter, -apple-system,"Segoe UI",Roboto,system-ui,sans-serif;
    background: radial-gradient(900px 420px at 80% -10%, #c7d2fe 0%, transparent 70%), linear-gradient(160deg, #f5f6ff 0%, #eef0ff 55%, #e4e7fe 100%); color:#111827; }
  header { padding: 36px 56px 0; }
  h1 { margin:0; font-size:38px; letter-spacing:-.03em; font-weight:700; }
  p { margin:10px 0 0; font-size:19px; line-height:1.45; color:#4b5563; max-width:1100px; }
  .stage { position:absolute; left:56px; right:56px; top:170px; bottom:0; }
  .shot { position:absolute; border-radius:14px 14px 0 0; box-shadow:0 24px 60px rgba(49,46,129,.20), 0 0 0 1px rgba(49,46,129,.06); overflow:hidden; background:#fff; }
  .shot img { display:block; width:100%; }
</style></head><body><header><h1>${title}</h1><p>${sub}</p></header><div class="stage">${inner}</div></body></html>`;
const pages = [
  ['1-fill-web-forms', 'Fill long application forms in one click',
    'Names, dates, dropdowns, radio buttons and addresses come from your profile. The popup tells you what still needs you. Forms are never submitted for you.',
    `<div class="shot" style="left:0;top:0;width:800px">${`<img src="${img(shots.form)}">`}</div>
     <div class="shot" style="right:10px;top:20px;width:340px;border-radius:14px"><img src="${img(shots.popup)}"></div>`],
  ['2-profile', 'Save your details once, privately',
    'Personal, family, address, education, category and work details, for you and your family. Encrypted on your computer with your PIN.',
    `<div class="shot" style="left:50px;right:50px;top:0"><img src="${img(shots.profile)}"></div>`],
  ['3-fill-pdf', 'Fill PDF forms too, even flat and scanned ones',
    'Values go on the printed lines, Hindi works, officer sections stay blank. Check each field, drag to adjust, then download.',
    `<div class="shot" style="left:50px;right:50px;top:0"><img src="${img(shots.pdf)}"></div>`],
  ['4-photo-signature', 'Photo and signature at the exact size',
    "Crop, resize to the form's pixels and KB range, and clean signatures to white, all on your computer. Then attach with one click.",
    `<div class="shot" style="left:50px;right:50px;top:0"><img src="${img(shots.photo)}"></div>`],
  ['5-privacy', 'Private by design',
    'Your details never leave your computer. AI sees only the form’s labels: use the free Form Filler AI, your own Gemini key, or turn AI off.',
    `<div class="shot" style="left:50px;right:50px;top:0"><img src="${img(shots.settings)}"></div>`]
];
for (const [name, title, sub, inner] of pages) {
  await page.setContent(frame(title, sub, inner));
  await sleep(150);
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
}
await composer.close();
console.log('screenshots written to store/screenshots/');
