# Revival AI — Desktop App (Install Guide)

There are two roles here:

- **You (the builder):** make the installer file **once**.
- **Your colleagues:** install the app on their own PC using that file. It
  works anywhere — they do **not** need to be on your WiFi or your computer.

---

## Part A — You build the installer (once)

1. Open your `Revival-Ai-` folder.
2. Make sure you have the latest code: open a command window there and run
   `git pull`.
3. **Double-click `Build-Installer-Windows.bat`.**
4. Wait — it installs components, bundles the automation browser, and builds
   the app. This takes several minutes and shows a lot of text; that's normal.
5. When it finishes it says **DONE** and shows a file name inside a new
   **`dist`** folder, like:

   `Revival AI Setup 1.0.0.exe`

That `.exe` in the `dist` folder **is the installer.** Send it to your
colleagues however you like (email, Google Drive, USB drive, etc.).

---

## Part B — Each colleague installs the app

1. Double-click the **`Revival AI Setup ....exe`** file you sent them.
2. If Windows shows a blue "Windows protected your PC" box, click
   **More info → Run anyway** (this happens because the app isn't
   code-signed; it is safe).
3. Choose an install location (or accept the default) and finish.
4. A **Revival AI** icon appears on their desktop. Double-click it — the
   dashboard opens in its own window.

### First time they run it
- When they click **Start**, the REI BlackBook **login page appears** in the
  automation window.
- They log in **once** with the **company REI account** (including the code
  REI texts/emails the first time).
- It's remembered on their machine — no need to log in again next time.

---

## Notes

- **Property check:** use **Redfin** (free, no login for anyone). To turn it
  on, the app's settings file (`.env`) should contain `PROPERTY_SOURCE=redfin`.
- **Live texting** is OFF until `ALLOW_LIVE_SEND=true` is set — that's the
  safety switch so it never sends by accident.
- **Everyone shares the same REI account,** so the contacts, tags, and
  "already texted" history stay in sync across the whole team automatically.
