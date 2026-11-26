# secret-santa

A Secret Santa web app for GitHub Pages, with English and Korean instructions.

- The host signs in with Google and creates a group by entering everyone's names. The app assigns everyone at random (nobody gets themselves) and gives the group a 6-letter code.
- The host shares the group link (`https://<you>.github.io/secret-santa/?g=ABCDEF`). There's no "join with a code" form: if someone loses the link, the host opens the group from **Your groups** and sends it again.
- Each person opens the link, picks their name, and sets a 4-digit PIN. After that they can see who they're buying for and edit their own wishlist, one gift at a time.
- Everyone can also see everyone else's wishlists for smaller gifts. Tapping **I'll get it** on a gift shows it as taken to everyone else, so nobody buys the same thing twice. People never see what has been claimed from their own list.
- **Host view:** groups are saved to the host's Google account. The host can see who has set a PIN so far, which shows who has joined, without seeing who drew whom. Hosts who are also playing use **Open as participant**.
- **Language:** the globe button in the top corner switches between English and Korean. The choice is remembered on that device.

The pages are plain HTML, CSS and JavaScript with no build step. Groups and wishlists are stored in Firebase Firestore, and hosts sign in with Firebase Authentication (Google). Both work on the free plan.

## 1. Set up Firebase (one time, about 5 minutes)

1. Go to <https://console.firebase.google.com> and click **Create a project**. Google Analytics isn't needed.
2. On the project page, click the **Web** icon (`</>`) to add a web app. Give it any nickname and skip Hosting.
3. Firebase shows a `firebaseConfig` object. Copy its values into **`firebase-config.js`**.
4. In the left menu, open **Build → Firestore Database → Create database**. Pick a location near you and start in **production mode**.
5. Open **Build → Authentication → Get started → Sign-in method**, enable **Google**, and save. Then under **Settings → Authorized domains**, add `<your-username>.github.io`.
6. In Firestore, open the **Rules** tab. Replace everything there with the contents of **`firestore.rules`** and click **Publish**.

If you have the Firebase CLI, you can skip step 6. Instead run `firebase deploy --only firestore:rules`, which uses `firebase.json` and `.firebaserc` from this repo. Change the project id in `.firebaserc` if you made your own project.

The values in `firebase-config.js` are meant to be public. What people can read and write is controlled by the rules.

## 2. Try it locally (optional)

The app uses JavaScript modules, so open it through a local server rather than double-clicking `index.html`:

```bash
cd ~/Desktop/secret-santa
python3 -m http.server 8000
```

Then open <http://localhost:8000>.

## 3. Deploy to GitHub Pages

1. Push this folder to a GitHub repository, for example `secret-santa`.
2. On GitHub, open the repo's **Settings → Pages**.
3. Under **Build and deployment**, choose **Deploy from a branch**, then branch `main` and folder `/ (root)`. Click **Save**.
4. After a minute or so, the site is live at `https://<your-username>.github.io/secret-santa/`.

## How privacy works

- PINs are never stored. The app stores a hash of each PIN in a part of the database that nobody can read. Every wishlist change has to come with proof of the right PIN, so nobody else can edit your list.
- Only the host's Google account can list their groups. Anyone with a group's link or code can open it.
- Assignments aren't shown to the host or anyone else in the app. The browser does download the whole group's data, though, so a technically curious person could dig the assignments out with developer tools. That's fine for a friendly gift exchange, but this isn't bank-grade secrecy.
- Remembering who you are on a device uses the browser's local storage. "Not you?" signs that person out on that device.

## Limitations

- Names can't be changed after a group is created. If a name is wrong, make a new group.
- A forgotten PIN can't be reset. You can delete that person's documents under `pins`, `members` and `proofs` in the Firebase console, and they can then set a new PIN.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Page shell |
| `style.css` | Grey-blue theme, mobile-first |
| `app.js` | All app logic: create, join, PIN, wishlists |
| `firebase-config.js` | Your Firebase project settings |
| `firestore.rules` | Database security rules (paste into the Firebase console) |
