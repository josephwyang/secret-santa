# CLAUDE.md — secret-santa

Bilingual (English/Korean) Secret Santa web app. Plain HTML/CSS/JS, no build step, no npm.
Hosted on **GitHub Pages** (remote `git@github.com:josephwyang/secret-santa.git`, branch `main`, root folder).
Backend: **Firestore** plus **Firebase Auth (Google sign-in) for hosts only**, both on the free Spark plan. Participants never sign in; they use a per-group 4-digit PIN. No Firebase Hosting.

## Files
| File | Purpose |
| --- | --- |
| `index.html` | Page shell; loads `app.js` as an ES module |
| `app.js` | All logic: language toggle, Google sign-in, host home/groups list, create, host view, participant picker/PIN/wishlist. Imports Firebase SDK 10.12.2 (app, auth, firestore) from `https://www.gstatic.com/firebasejs/...` |
| `firebase-config.js` | Web app config. `configured` in `app.js` treats an `apiKey` starting with `YOUR_` as "not configured" |
| `firestore.rules` | Security rules; source of truth (deploy from here) |
| `style.css` | Grey-blue, mobile-first theme |
| `README.md` | User-facing setup/deploy docs |

## Data model (see header of `firestore.rules`)
- `groups/{code}` — `{ title?, names[], giftees[], ownerUid, createdAt }`, code matches `^[A-HJ-NP-Z]{6}$`. Anyone can `get`; `list` only where `ownerUid == auth.uid`; `create` requires sign-in with `ownerUid == auth.uid`. (The old `hostKeyHash` and `#host=` links were removed on 2026-11-26.)
- `groups/{code}/members/{i}` — `{ wishlist, updatedAt }`, created together with the PIN
- `groups/{code}/pins/{i}` — `{ pinHash }`, never readable
- `groups/{code}/proofs/{i}` — `{ pinHash, at }`, never readable; written alongside each wishlist update

## Routes & UX
- `/` — signed out: "Sign in with Google" (hosts) and a note that participants should open their host's link. Signed in: Create group plus **Your groups** list (query `where ownerUid == uid`, sorted by `createdAt` on the client so no composite index is needed). There is **no join-by-code form**; this is by design.
- `?g=CODE` — participant: pick name → PIN → dashboard (giftee + wishlist). The owner also sees a "Host view" button.
- `?g=CODE&view=host` — host view (share/copy link, PIN progress, "Open as participant"). Not the owner → sign-in prompt, or falls back to the participant view.
- Language: `<html lang>` is `en` or `ko`. Every string renders both `<span class="en">` and `<span class="ko">`, and CSS hides the other one, so the toggle (`#lang` in index.html) needs no re-render. `bi(en, ko)` builds the spans, `L(en, ko)` returns a plain string, and `ph()`/`al()` build translatable placeholder and aria-label attributes. The choice is stored in localStorage `secret-santa:lang`; the default comes from `navigator.language`.

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
- [x] Google sign-in enabled (`firebase.json` → `auth.providers.googleSignIn`, support email = the user's Gmail, approved by the user) and deployed 2026-11-26
- [x] Authorized domain `josephwyang.github.io` added by the user (2026-11-26)
- [ ] Tested end to end locally (the host's Google sign-in needs a real browser)
- [x] Committed and pushed to `main` (d41edbc, 2026-11-26)
- [x] GitHub Pages is live at https://josephwyang.github.io/secret-santa/

## Git / SSH notes
- `~/.ssh/id_ed25519` has a passphrase and is saved in the macOS Keychain (`ssh-add --apple-use-keychain`). If a push fails with `Permission denied (publickey)`, the agent has lost the key: the user must rerun that command in a real Terminal, because the `!` prompt can't take a passphrase.
- `gh` CLI is not installed.

## Conventions
- Keep it build-free: no bundlers or npm deps; Firebase loads from the CDN.
- All UI strings come in English and Korean pairs. Use `bi`/`instr` for markup, `L` for plain strings (prompt, share text), and `ph`/`al` for attributes. Never hardcode text in one language only.
- The user is the only one using this: commit and push straight to `main` after changes, with no local testing step needed (the user said so on 2026-11-26). Still deploy rules/auth with the Firebase MCP whenever `firestore.rules` or `firebase.json` change.
