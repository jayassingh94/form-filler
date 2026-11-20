# Chrome Web Store: “Privacy practices” tab answers

Copy these into the Developer Dashboard. They match what the code does (see privacy.html and server/).

## Single purpose
Form Filler fills in web and PDF application forms with details the user has saved in the extension, which are stored encrypted on the user's own computer.

## Permission justifications

| Permission | Justification to paste |
|---|---|
| `storage` | Stores the user's encrypted profiles, settings and document metadata on their own computer, and keeps the unlocked key in memory-only session storage. |
| `unlimitedStorage` | The Document Locker stores the user's own documents (photo, signature, certificates) encrypted on their computer; these can exceed the default quota. |
| `scripting` | When the user clicks “Fill this form”, injects the fill script into that tab to read the form's fields and fill them. Nothing is injected otherwise. |
| `alarms` | Runs the auto-lock timer that locks the encrypted data after 5 minutes without use. |
| `activeTab` | When the user clicks the toolbar icon, lets the popup read the current tab's address so it can ask for permission for that one site. |
| Optional host permissions `http://*/*`, `https://*/*`, `file:///*` | Requested for one site at a time, only when the user clicks “Fill this form” on that site, so the extension can fill forms there. Users can remove access in Settings. |
| Host permission `https://generativelanguage.googleapis.com/*` | Used only if the user chooses “Use my own Gemini key”: sends form field labels (never the user's details) to Google Gemini to match fields. |
| Host permission `https://YOUR-SERVICE.onrender.com/*` | Form Filler's own AI service (default AI option): receives form field labels or a blank PDF form image (never the user's details) and returns field matches. Stores nothing. |

## Remote code
**No, I am not using remote code.** All JavaScript is in the package (including the bundled pdf.js, pdf-lib, fontkit). The AI service returns data (JSON), not code.

## Data usage: “What user data do you plan to collect from users now or in the future?”
“Collect” means data transmitted off the user's device. Tick only:

- [x] **Website content**: the text of form fields (labels, placeholders, dropdown options) and, only with the user's explicit consent, images of a blank PDF form page; and short snippets of a page's upload instructions when the user asks. Sent to Form Filler's AI service (or Google Gemini with the user's own key) only to match form fields; not stored.

Leave unticked: Personally identifiable information, Health information, Financial and payment information, Authentication information, Personal communications, Location, Web history, User activity. (The user's profile, documents and PIN never leave the device; password/card/bank/OTP fields are never read for AI.)

## Certifications (tick all three)
- [x] I do not sell or transfer user data to third parties, outside of the approved use cases
- [x] I do not use or transfer user data for purposes that are unrelated to my item's single purpose
- [x] I do not use or transfer user data to determine creditworthiness or for lending purposes

## Privacy policy URL
`https://YOUR-SERVICE.onrender.com/privacy` (served by the AI server from `privacy.html`)
