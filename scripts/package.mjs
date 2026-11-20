// Build the Chrome Web Store upload:  node scripts/package.mjs   → dist/form-filler-<version>.zip
// Contains only the extension (no server, tests, sample forms or store images).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const INCLUDE = ['manifest.json', 'background.js', 'privacy.html', 'content', 'lib', 'options', 'popup', 'picker', 'pdf', 'icons', 'vendor'];
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));

// safety checks
const config = fs.readFileSync(path.join(ROOT, 'lib/config.js'), 'utf8');
const backend = (config.match(/BACKEND_URL = '([^']*)'/) || [])[1];
if (!backend) console.warn('⚠  lib/config.js has no AI server address: the free AI will be off in this build.\n   Run: node scripts/set-backend.mjs https://<your-service>.onrender.com');
else if (!manifest.host_permissions.includes(`${new URL(backend).protocol}//${new URL(backend).hostname}/*`)) { console.error(`✖ manifest.json has no host permission for ${backend}. Run scripts/set-backend.mjs.`); process.exit(1); }
const walk = (p) => fs.statSync(p).isDirectory() ? fs.readdirSync(p).flatMap((f) => walk(path.join(p, f))) : [p];
const files = INCLUDE.flatMap((f) => walk(path.join(ROOT, f)));
for (const f of files) {
  if (/\.(js|mjs|json|html|css)$/.test(f) && /AIza[0-9A-Za-z_-]{20,}/.test(fs.readFileSync(f, 'utf8'))) { console.error('✖ API key found in', f); process.exit(1); }
}

fs.mkdirSync(path.join(ROOT, 'dist'), { recursive: true });
const out = path.join(ROOT, 'dist', `form-filler-${manifest.version}.zip`);
fs.rmSync(out, { force: true });
execFileSync('zip', ['-r', '-X', '-q', out, ...INCLUDE, '-x', '*.DS_Store'], { cwd: ROOT });
const kb = (fs.statSync(out).size / 1024).toFixed(0);
console.log(`✓ ${path.relative(ROOT, out)} (${kb} KB, ${files.length} files, version ${manifest.version}${backend ? `, AI server ${backend}` : ', AI server not set'})`);
