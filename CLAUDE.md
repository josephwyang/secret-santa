# CLAUDE.md — secret-santa

Bilingual (English/Korean) Secret Santa web app. Plain HTML/CSS/JS, no build step, no npm.
Hosted on **GitHub Pages** (remote `git@github.com:josephwyang/secret-santa.git`, branch `main`, root folder).
Backend is **Firebase Firestore only** (free Spark plan). No Firebase Auth, no Firebase Hosting.

## Files
| File | Purpose |
| --- | --- |
| `index.html` | Page shell; loads `app.js` as an ES module |
| `app.js` | All logic (create group, join, PIN, wishlists, host view). Imports Firebase SDK 10.12.2 from `https://www.gstatic.com/firebasejs/...` |
| `firebase-config.js` | Web app config. `app.js:24` treats `apiKey` starting with `YOUR_` as "not configured" |
| `firestore.rules` | Security rules; source of truth (deploy from here) |
| `style.css` | Grey-blue, mobile-first theme |
| `README.md` | User-facing setup/deploy docs |

## Data model (see header of `firestore.rules`)
- `groups/{code}` — `{ names[], giftees[], hostKeyHash, createdAt }`, code matches `^[A-HJ-NP-Z]{6}$`
- `groups/{code}/members/{i}` — `{ wishlist, updatedAt }`, created together with the PIN
- `groups/{code}/pins/{i}` — `{ pinHash }`, never readable
- `groups/{code}/proofs/{i}` — `{ pinHash, at }`, never readable; written alongside each wishlist update

## Commands
- Run locally: `python3 -m http.server 8000`, then open http://localhost:8000 (modules don't load over `file://`)
- Deploy rules: Firebase MCP `firebase_deploy` with `only: "firestore"`, or `firebase deploy --only firestore:rules`. The `firebase` CLI is **not** on PATH; use the MCP tools or `npx firebase-tools`.

## Firebase setup status (update as it progresses)
- Account: the user's Google account (signed in through the Firebase MCP on 2026-11-26)
- Project: **`secret-santa-7k3q`** (display name "Secret Santa", number 810883238720). Console: https://console.firebase.google.com/project/secret-santa-7k3q
- Web app: "Secret Santa Web", appId `1:810883238720:web:f841722591377195ba08a5`
- [x] `firebase-config.js` filled in with the real config
- [x] `firebase.json`, `.firebaserc` (default = secret-santa-7k3q) and `firestore.indexes.json` (empty) created
- [x] Firestore `(default)` set up in **nam5** (US multi-region; permanent)
- [x] Rules deployed 2026-11-26 and the live rules match the local file. The first deploy got a 403 while the new project's permissions propagated; the retry worked. Rules took about 40 s to go live. Checks: a public group read returns 404 for a missing doc, and a `pins` read returns 403.
- [ ] Tested end to end locally
- [ ] Committed, pushed to GitHub, and Pages enabled

## Conventions
- Keep it build-free: no bundlers or npm deps; Firebase loads from the CDN.
- All UI strings come in English and Korean pairs (helpers `bi(en, ko)` and `instr(en, ko)` in `app.js`).
- Don't commit or push unless the user asks.
