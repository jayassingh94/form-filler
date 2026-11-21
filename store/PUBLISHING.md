# Publishing Form Filler: step by step

You'll do three things: (A) put the free AI server online, (B) build the extension for it, (C) submit to the
Chrome Web Store. Budget about an hour, plus Google's review (usually a few days).

Everything you upload is in this repo:

| What | Where |
|---|---|
| Extension ZIP | `dist/form-filler-<version>.zip` (built in step B3) |
| Store icon 128×128 | `store/icon-128.png` |
| Screenshots 1280×800 (5) | `store/screenshots/1-…png` … `5-…png` |
| Small promo tile 440×280 | `store/promo-small-440x280.png` |
| Marquee promo 1400×560 (optional) | `store/promo-marquee-1400x560.png` |
| Listing text | `store/listing.md` |
| Privacy-practices answers | `store/privacy-practices.md` |
| Privacy policy | `privacy.html`, served online at `https://<your-service>.onrender.com/privacy` |

---

## A. Put the AI server online (Render, free)

### A1. Get a Gemini API key for the server
1. Open https://aistudio.google.com/apikey → **Create API key** (in a new or existing Google Cloud project).
2. **Turn on billing for that project** (Google Cloud console → Billing). The privacy policy promises that the shared key is on
   Google's *paid* tier, where Google does **not** use requests to improve its products. Gemini Flash-Lite is cheap; with the
   default caps (10 uses per person, 1000 in total per day) the cost stays small.
   *If you'd rather stay on the free tier,* change the “Free AI option” sentence in `privacy.html` section 6 to say that
   Google may use the submitted content (labels / blank form images) to improve its products, and lower `GLOBAL_DAILY_CAP`
   to stay within the free tier's daily request limit.
3. Recommended: in Google Cloud → Billing → **Budgets & alerts**, add a monthly budget (for example ₹500) with e-mail alerts.
4. Keep the key secret. Never put it in the repo or the extension.

### A2. Create the service
1. Sign up at https://render.com (GitHub login is easiest) and allow Render to see the private `form-filler` repo.
2. **New → Blueprint** → pick `jayassingh94/form-filler`. Render reads `render.yaml` and proposes a free web service named
   `form-filler-api`. Click **Apply**.
3. When asked for `GEMINI_API_KEY`, paste the key from A1 (it's stored only in Render's encrypted environment settings).
4. Wait for the first deploy (a minute or two). Your address is shown at the top, e.g. `https://form-filler-api.onrender.com`.
   If that name was taken, Render adds a suffix, e.g. `https://form-filler-api-x7k2.onrender.com`. **Use the exact address shown.**

### A3. Check it
Open these in your browser:
- `https://<your-service>.onrender.com/healthz` → `{"ok":true,"configured":true}` (`configured:false` means the key is missing)
- `https://<your-service>.onrender.com/privacy` → the privacy policy (this is the URL you give the Web Store)

Good to know about Render's free plan:
- It **sleeps after ~15 minutes without traffic**; the first request after that takes ~50 seconds to wake it. The extension
  waits up to 95 s, and falls back to offline matching if needed.
- The daily counters live in memory, so a restart resets them early. The global cap still limits cost per day.
- Upgrading to Render's cheapest paid plan removes the sleep.

---

## B. Build the extension for your server

Run these in Terminal, in the project folder:

```
# B1. point the extension at your server (updates lib/config.js and manifest.json)
node scripts/set-backend.mjs https://<your-service>.onrender.com

# B2. run the tests
node --test tests/

# B3. build the upload
node scripts/package.mjs          # → dist/form-filler-1.1.1.zip
```

B4. Try the built extension once: `chrome://extensions` → Developer mode → **Load unpacked** → choose a folder where you
unzipped `dist/form-filler-1.1.1.zip`. In **Settings → AI matching** keep “Form Filler AI (free)”, click **Test connection**
(it may take up to a minute the first time), then fill `test/sample-form.html` (see the main README).

B5. Commit the address change: `git commit -am "Set AI server address" && git push`.

---

## C. Submit to the Chrome Web Store

### C1. Developer account (once)
1. Go to https://chrome.google.com/webstore/devconsole and sign in with the Google account that should own the extension.
2. Pay the one-time **US$5** registration fee, accept the agreement, and verify your contact e-mail.
3. Under **Account**, fill in the publisher name and contact e-mail (shown to users as the support contact).

### C2. Upload
1. **Items → New item** → upload `dist/form-filler-1.1.1.zip`.

### C3. Store listing tab
1. **Description**: paste the *Full description* from `store/listing.md`, and replace `YOUR-SERVICE` with your address.
2. **Category**: Productivity → Tools. **Language**: English.
3. **Store icon**: `store/icon-128.png`.
4. **Screenshots**: upload the five files from `store/screenshots/` in order (1 → 5).
5. **Small promo tile**: `store/promo-small-440x280.png`. **Marquee** (optional): `store/promo-marquee-1400x560.png`.
6. **Official URL / Homepage**: you can leave these empty, or use `https://<your-service>.onrender.com/privacy`.
7. **Support**: choose your contact e-mail (or a support site).

### C4. Privacy practices tab
Copy everything from `store/privacy-practices.md`:
single purpose, one justification per permission (replace `YOUR-SERVICE`), **No** remote code, tick only **Website content**,
tick the three certifications, and the privacy policy URL `https://<your-service>.onrender.com/privacy`.

### C5. Distribution tab
- **Visibility**: start with **Unlisted** (only people with the link can install). Install it yourself from the store link and
  test once. Then change to **Public**.
- **Regions**: all regions (or India only).
- Price: free.

### C6. Submit
Click **Submit for review**. You'll get an e-mail when it's approved or if the reviewers have questions. Reviews of
extensions with host permissions and AI usually take a few days.

### C7. After approval: lock the server to your extension
1. Copy the extension's **ID** from the dashboard (32 letters, e.g. `abcdefghijklmnopabcdefghijklmnop`).
2. In Render → your service → **Environment**, set `ALLOWED_ORIGINS` to `chrome-extension://<that ID>` and save (it redeploys).
   From then on the server answers only requests from your published extension.
   (If you also test unpacked copies, add their IDs too, comma-separated.)

---

## Updating later
1. Change the code, bump `"version"` in `manifest.json` (e.g. `1.1.1`).
2. `node --test tests/` → `node scripts/package.mjs` → in the dashboard, **Package → Upload new package** → **Submit for review**.
3. Server changes deploy automatically when you push to `main` (Render auto-deploy).
4. Regenerate images only if the UI changed (needs Chrome for Testing + puppeteer):
   `node store/make-assets.mjs --chrome "<Chrome for Testing path>"` and `node store/make-screenshots.mjs --chrome "<…>"`.

## Server settings (Render → Environment)
| Variable | Default | Meaning |
|---|---|---|
| `GEMINI_API_KEY` | (required) | The shared key (never commit it) |
| `GEMINI_MODEL` / `GEMINI_FALLBACK_MODEL` | `gemini-3.5-flash-lite` / `gemini-3.6-flash` | Model, and the one tried when Google answers 503 |
| `DAILY_LIMIT_PER_INSTALL` | `10` | Free AI uses per install per day (the extension shows the real number) |
| `DAILY_LIMIT_PER_IP` | `30` | Per network per day (stops people creating new install IDs to get more) |
| `GLOBAL_DAILY_CAP` | `1000` | All users together per day, to cap cost |
| `ALLOWED_ORIGINS` | empty | After publishing: `chrome-extension://<your extension ID>` |

If you change `DAILY_LIMIT_PER_INSTALL`, also update “10” in `privacy.html`, `store/listing.md` and Settings' wording.
