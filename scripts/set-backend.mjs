// Point the extension at your deployed AI server:  node scripts/set-backend.mjs https://<name>.onrender.com
// Updates lib/config.js and the host permission in manifest.json.
import fs from 'node:fs';
const url = String(process.argv[2] || '').replace(/\/+$/, '');
if (!/^https:\/\/[a-z0-9.-]+$/i.test(url)) { console.error('Usage: node scripts/set-backend.mjs https://<name>.onrender.com'); process.exit(1); }
const root = new URL('..', import.meta.url);
const cfg = new URL('lib/config.js', root);
fs.writeFileSync(cfg, fs.readFileSync(cfg, 'utf8').replace(/export const BACKEND_URL = '[^']*';/, `export const BACKEND_URL = '${url}';`));
const mf = new URL('manifest.json', root);
const m = JSON.parse(fs.readFileSync(mf, 'utf8'));
m.host_permissions = [...m.host_permissions.filter((h) => h.includes('generativelanguage.googleapis.com')), `${url}/*`];
fs.writeFileSync(mf, JSON.stringify(m, null, 2) + '\n');
console.log('AI server set to', url, '\nhost_permissions:', m.host_permissions.join(', '));
