# Form Filler

A Chrome extension (Manifest V3) that fills web forms from encrypted profiles stored only on your computer.

- **My Profile**: personal, family, permanent and current address, contact, education (Class 10, Class 12, diploma, graduation, post-graduation, PhD, other), category, work experience and custom fields. You can keep several profiles (you, your spouse, and so on).
- **Fill this form**: reads field labels, placeholders, names and dropdown/radio options. Gemini matches them to your profile *keys*, and your values are then filled in **locally**. Handles text boxes, dropdowns, radio buttons, checkboxes, date formats (DD/MM/YYYY, MM-DD-YYYY, DD-Mon-YYYY, native date pickers, separate day/month/year boxes) and dropdowns that load after another one changes. Fields it is sure about turn **green**; fields that are unsure or empty turn **yellow**.
- **Document Locker**: stores your photo, signature, marksheets and certificates encrypted, with names and tags. A **📎 Pick from locker** button appears next to every upload field. The picker shows file size and dimensions, reads the form's KB and pixel limits, and can resize or compress images to fit.
- **Privacy**: AES-256-GCM encryption with a key derived from your PIN, auto-lock after 5 minutes, only labels are sent to the AI, password/card/CVV/bank/OTP/captcha fields are never filled, forms are never submitted, site access is asked for per site, plus backup/restore, "Delete all data" and no tracking. See [privacy.html](privacy.html).

## Install (Load unpacked)

1. Download the code: `git clone https://github.com/jayassingh94/form-filler.git` (or use your existing folder).
2. Open Chrome and go to `chrome://extensions`.
3. Turn on **Developer mode** (top-right switch).
4. Click **Load unpacked** and choose the `form-filler` folder (the one that contains `manifest.json`).
5. Pin it: click the puzzle-piece icon in the toolbar, then the pin next to **Form Filler**.
6. The setup page opens automatically. **Create a PIN** of at least 6 characters (letters make it stronger). If you forget it, the data cannot be recovered.
7. Optional, for smarter matching: go to **Settings**, paste a Gemini API key from https://aistudio.google.com/apikey, click **Test connection**, then **Save**. The model defaults to `gemini-3.5-flash-lite`. Without a key, a built-in offline keyword matcher is used and nothing is sent anywhere.

After pulling new code, click the ↻ reload icon on the Form Filler card in `chrome://extensions`.

## Try it on the sample form

1. Serve the test page (from the `form-filler` folder):
   ```
   cd test && python3 -m http.server 8765
   ```
   Then open http://localhost:8765/sample-form.html.
   (Opening the file directly as `file://` also works, but only after you turn on **Allow access to file URLs** on the extension's Details page.)
2. In Form Filler's **My Profile** tab, click **Add a demo profile with fake data** at the bottom (or enter your own details).
3. In **Document Locker**, add any photo (JPG/PNG) and a PDF.
4. On the sample form, click the Form Filler icon, choose the **Demo (fake data)** profile, and click **Fill this form**.
   - The first time on a site, Chrome asks to allow access to it. Click **Allow**. If the popup closes while that dialog shows, click **Fill this form** again.
5. What you should see:
   - About 55 fields turn green, including the education table, the District dropdown (which loads after State), the gender/PwBD radio buttons, and the DOB in three formats.
   - The declaration checkbox turns **yellow**. Tick it yourself.
   - **Section 9 (password, card, CVV, bank, IFSC, OTP, captcha) stays empty.**
   - The yellow "form was submitted" banner **never** appears.
6. Next to **Recent Photograph**, click **📎 Pick from locker**. The picker shows "20–50 KB · 200×230 px" and warns that your photo doesn't fit. Click **Resize…**, then **Preview**, then **Attach resized**, and the field shows `…_200x230.jpg`.
7. Click **🔒 Lock** in the popup and try filling again: it asks for your PIN. Leaving it idle for 5 minutes also locks it.

## Automated tests

```
node --test tests/
```
These cover sensitive-field detection, date formatting, dropdown matching, upload-limit parsing, offline matching, the encrypted vault (encryption at rest, wrong-PIN slowdown, auto-lock), and a check that the Gemini request never contains profile values or the API key in the URL.

## How the data flows

```
popup ──"Fill"──► background worker ──inject──► page (content script)
                       │                            │ scan: labels/options only
                       │◄───────────────────────────┘
                       ├──labels + generic key names──► Gemini (optional)
                       │◄──────── field → key mapping ───┘
                       ├─ decrypt profile, resolve values (locally)
                       └──values──► page: fill + highlight (never submit)
```

| File | Role |
|---|---|
| `manifest.json` | MV3 manifest. No host permissions at install except the Gemini API; sites are requested when you click Fill |
| `background.js` | Runs Fill, relays locker files, runs the auto-lock alarm |
| `content/content.js` | Scans, fills and highlights fields; adds locker buttons (injected only when you click Fill) |
| `content/fillcore.js` | Pure logic: sensitive-field rules, date formats, option matching, offline matcher |
| `lib/crypto.js`, `lib/vault.js` | PBKDF2 + AES-GCM, encrypted storage, lock/unlock, backup, wipe |
| `lib/schema.js` | Profile fields, generic key list for the AI, derived values (full name, age, full address…) |
| `lib/ai.js` | Gemini request (labels only) |
| `options/` | My Profile, Document Locker, Settings, Backup & data |
| `popup/` | Profile picker and the Fill button |
| `picker/` | "Pick from locker" window (extension iframe the page can't read) with resize |
| `privacy.html` | Privacy policy |
| `test/sample-form.html` | Sample form for manual testing |

## Never commit personal data

All personal data lives inside Chrome's storage, not in this folder. `.gitignore` also blocks backup files (`form-filler-backup*.json`), `.env` files and key files in case you save them here.
