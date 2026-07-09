# Lead Revival Automation — Setup Tutorial (Windows)

Zero-to-sending, no coding. Do these once; daily use is a couple of clicks after.

**Have ready:** your REI BlackBook login, PropertyRadar login (optional), your leads spreadsheet.

---

## 1. Install Node.js (one time, ~3 min)
1. Go to **https://nodejs.org**
2. Click the green **LTS** button, open the download.
3. **Next → Next → Install → Finish** (accept defaults; click **Yes** if asked to allow changes).

Check: press ⊞ Win, type `cmd`, in the black window type `node --version` → a number like `v20…` means it worked.

## 2. Download the project (one time)
1. Go to **https://github.com/rosanes-cmyk/Revival-Ai-** (sign in if asked).
2. Branch button (`main`) → choose **`claude/equity-lead-revival-dashboard-xl9l8j`**.
3. Green **`<> Code`** → **Download ZIP**.
4. In Downloads, right-click the ZIP → **Extract All…** → extract to your **Desktop**.
5. Open the folder — you should see `start-windows.bat`, `server`, `public`, etc.

> Re-download this branch whenever there's an update — it's the whole latest version in one file.

## 3. Add your logins — the `.env` file
1. Open the project folder. Click the **address bar**, type `cmd`, press Enter (black window opens in the folder).
2. `copy .env.example .env`  →  Enter
3. `notepad .env`  →  Enter
4. Fill in (no quotes, no spaces around `=`):
   ```
   REIBB_EMAIL=your REI BlackBook email
   REIBB_PASSWORD=your REI BlackBook password

   CHECK_PROPERTYRADAR=true
   PROPERTYRADAR_EMAIL=your PropertyRadar email
   PROPERTYRADAR_PASSWORD=your PropertyRadar password

   DEFAULT_COMPANY=Twin Home Buyer     (or: Equity Track Inc.)
   MAX_SENDS_PER_RUN=100
   ALLOW_LIVE_SEND=false               (keep false until the one-lead test)
   HEADLESS=false                      (false lets you watch the browser)
   ```
5. Save (Ctrl+S), close Notepad.

> Type your password into the file, never into chat. `.env` is never uploaded or shared.

## 4. Create the 10 Revival tags in REI (one time)
Make them the same way you made "THB Inquiry Call". Type each **exactly**:
```
Revival - Text Sent          Revival - Already Contacted
Revival - Do Not Text        Revival - Needs Review
Revival - Not Interested     Revival - Lead Not Found
Revival - Wrong Number       Revival - Sold
Revival - Failed Number      Revival - Listed
```

## 5. Start the dashboard
In the black window (project folder), run one at a time:
```
npm install                        (first time only)
npx playwright install chromium    (first time only)
npm start
```
When it prints `… running: http://localhost:3000`, open **localhost:3000** in your browser.
Keep the black window open while using it.

## 6. Upload your leads
- Click **Choose File**, pick your spreadsheet. It auto-detects your columns; already-worked rows are skipped.
- Click any card to filter the table.

## 7. Test on ONE lead — watch it ⭐ (most important)
1. Use a **test lead you control** (your own number) — a 1-row sheet is ideal.
2. In `.env`: `ALLOW_LIVE_SEND=true`, `MAX_SENDS_PER_RUN=1`, `HEADLESS=false`. Save; restart (Ctrl+C in the black window, then `npm start`).
3. Click **Start Live Automation** and **watch** the browser: search → open contact → check → tag → send.
4. Confirm the text arrives and the tag appears on the contact.

> Expect 1–2 small fixes here. If a button misbehaves, send a screenshot of what you saw.

## 8. Go live in batches + schedule
1. Upload your real sheet.
2. Set **Texts per run** (start 25–50/day for a newer number, up to 100).
3. Optionally enable **Run automatically every day at** a time (app must be open).
4. **Start** → it sends the batch, stops, and continues next run — never double-texting.
5. **Export** anytime to download your updated sheet.

## Everyday use
Double-click `start-windows.bat` (or `npm start`) → open **localhost:3000** → upload latest sheet → **Start**.

## Safety (always on)
Never texts: sold/listed, opt-out/STOP/do-not-text tags, "not interested / wrong number / stop" in chat, no phone, or anything uncertain — those become Needs Review / To Delete.

## Troubleshooting
- **Black window closes instantly:** run `npm start` from Command Prompt so errors stay visible.
- **"REI BlackBook isn't set up":** `.env` is missing the login — redo Step 3.
- **Everything "Needs Review":** a button needs re-wiring — send a screenshot of the browser.
- **Stuck:** screenshot the black window or dashboard and send it.
