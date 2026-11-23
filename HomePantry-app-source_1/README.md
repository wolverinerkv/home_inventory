# Home Pantry: Android & iOS app

A household grocery inventory app. Add what you buy each month, tap to mark items used, see what's running low, and track monthly spend. Everyone in the family uses their own phone, and all phones share one inventory.

- **App:** Capacitor 8 (one codebase for Android and iOS)
- **Data:** Google Firebase (free Spark plan). Email sign-in, plus a Firestore database that keeps working offline and syncs when you're back online.

---

## Step 1: Create your free Firebase project (one time, about 10 minutes)

1. Go to <https://console.firebase.google.com>, then **Add project**. Name it something like `home-pantry`. You can turn Google Analytics off.
2. **Turn on sign-in:** go to **Build → Authentication → Get started → Sign-in method**, open **Email/Password**, switch on **Enable** and click **Save**.
3. **Create the database:** go to **Build → Firestore Database → Create database**. Pick location **asia-south1 (Mumbai)** and **Start in production mode**.
4. **Add the security rules:** in Firestore, open the **Rules** tab. Delete everything there, paste the full contents of [`firestore.rules`](firestore.rules), and click **Publish**.
   > This step matters. The rules let only members of your household read or change its data.
5. **Get the app config:** go to **Project settings** (gear icon) → **Your apps** → click the **`</>` (Web)** icon. Name it `Home Pantry` and leave Hosting off. You'll see a block like this:
   ```js
   const firebaseConfig = { apiKey: "...", authDomain: "...", projectId: "...", appId: "..." };
   ```
   Keep it handy. You'll paste it into the app the first time you open it.

   *(Optional) You can instead paste the values into `src/firebase-config.js` before building. Then family members never see the config step and only need the short invite code.*

---

## Step 2: Build the Android APK on GitHub (no Android Studio needed)

1. Create a free account at <https://github.com>, then click **New repository**. Name it `home-pantry` and make it **Private**.
2. Upload this whole folder. Either:
   - on the empty repo page, click **uploading an existing file** and drag in every file and folder from this zip, then **Commit**, or
   - from a terminal: `git init -b main && git add . && git commit -m "Home Pantry" && git remote add origin <your repo URL> && git push -u origin main`
3. **(Recommended) Add the signing secrets.** These let future updates install over the old app. Go to **Settings → Secrets and variables → Actions → New repository secret** and add the 4 values from `signing-secrets.txt`: `KEYSTORE_BASE64`, `KEYSTORE_PASSWORD`, `KEY_ALIAS`, `KEY_PASSWORD`.
   - Without them you still get a working **debug APK**, but each new build has to be uninstalled and reinstalled. Your data is safe either way, because it lives in Firebase.
4. Open the **Actions** tab → **Build Android APK** → **Run workflow**. Wait about 5–8 minutes for the green tick.
5. Open the finished run and download **HomePantry-apk** under **Artifacts**. Unzip it to get `HomePantry.apk`.

### Install on Android phones
Send the APK to each phone (WhatsApp to yourself, Google Drive, or a USB cable). Tap it, allow **Install unknown apps** for that app when Android asks, then tap **Install**.

---

## Step 3: First launch

**You (the owner):**
1. Open the app, tap **"I'm setting this up for the first time"**, paste the Firebase config from Step 1.5, and tap **Save config**.
2. **Create an account** with your name, email and password.
3. **Create household**, for example "Viswa's home".
4. Tap the **gear icon → Copy invite** and send the code to your family.

**Family members:**
1. Install the APK and open it.
2. Paste the invite code → **Continue with invite** → **Create account**. They join your household automatically.

The owner can remove a member or use **Reset invite code** at any time. Resetting makes old codes stop working.

---

## iOS (iPhone)

Apple only allows iPhone apps to be built on a **Mac with Xcode**, and installing on family phones needs an **Apple Developer account** ($99/year, which gives you TestFlight). The iOS project is already in the `ios/` folder.

**On a Mac:**
```bash
npm ci
npm run build
npx cap sync ios
npx cap open ios        # opens Xcode
```
In Xcode, select the **App** target → **Signing & Capabilities** → choose your Team. Then connect an iPhone and press ▶, or use **Product → Archive** to upload to TestFlight.

**No Mac?** Cloud build services such as **Codemagic** or **Ionic Appflow** can build the iOS app from this same GitHub repo. You still need the Apple Developer account to install it.

**Until then:** iPhone users can keep using the web version (claude.ai link) from their home screen. Note that the web version and this app keep separate data.

---

## Making changes later
- The app code is in `src/app.js` (logic) and `src/index.html` (styles).
- Before each new release, raise `versionCode` in `android/app/build.gradle`. Push to `main`, and GitHub builds a new APK automatically.

## Security notes
- Firebase config values are public identifiers, not passwords. Your data is protected by sign-in plus `firestore.rules`.
- **Never** upload `signing-secrets.txt` or any `.jks` file to GitHub. `.gitignore` already blocks them. Keep a backup somewhere private, such as a password manager.
- Only paste invite codes that come from people you trust. The app shows which Firebase project a code connects to before it continues.
- **Optional hardening:**
  - In Google Cloud Console → APIs & Services → Credentials, restrict the API key to the *Identity Toolkit* and *Cloud Firestore* APIs.
  - Turn on **Firebase App Check**.
