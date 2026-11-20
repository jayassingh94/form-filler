// Where the free Form Filler AI service runs (server/ deployed on Render).
// Empty = not set up: the extension never contacts any Form Filler server and uses your own key or
// offline matching. After deploying, run:  node scripts/set-backend.mjs https://<your-service>.onrender.com
// (it updates this file and manifest.json together).
export const BACKEND_URL = '';
