# Revival AI — Operator SOP (High Equity Lead Revival Text Campaign)

**Purpose:** Check old high-equity leads in REI BlackBook, skip anyone who
shouldn't be texted (opted out, sold, listed, wrong number, etc.), and send the
approved revival text only to clean leads. Everything is recorded in the
dashboard and the exported sheet. **No REI tags are added.**

The two approved messages (the app picks the right one automatically):
- **Twin Home Buyer:** "Hi, this is Juan with Twin Home Buyer. You contacted us before about selling your home. Are you still interested? Reply YES or NO. Thanks!"
- **Equity Track Inc.:** "Hi, this is Juan with Equity Track Inc. You contacted us before about selling your home. Are you still interested? Reply YES or NO. Thanks!"

---

## A. Start the app (each day)

1. Open the **`Revival-Ai-`** folder.
2. In the address bar of the folder window, type `cmd` and press **Enter** (a black window opens in the folder).
3. Type this and press **Enter** to get the latest version:
   ```
   git pull
   ```
4. Type this and press **Enter** to start the engine:
   ```
   npm start
   ```
5. **Keep that black window OPEN** the whole time you work. Closing it stops the app.
6. Open **Google Chrome** and go to:
   ```
   http://localhost:3000
   ```

## B. Log into REI (first time each session)

- The first time you press **Start**, an automation browser window opens to REI BlackBook.
- Log in **once** with the company REI account (enter the code REI texts/emails if asked).
- It's remembered for the session. If a **Redfin** "are you human?" check appears, complete it once.

## C. Upload the leads

1. Click **Choose File** and pick the lead spreadsheet (CSV or XLSX).
2. It reads your columns automatically (Address, City, State, ZIP, Phone…).
3. The table fills with the leads, all marked **Pending**.

> **Do NOT re-upload a file to continue an interrupted run.** Re-uploading starts over from zero. To continue, see Section G.

## D. Choose your settings

- **Texts per run** (dropdown): how many texts to send before the run pauses for review (25 / 50 / 75 / 100). Start with **25** if unsure.
- **Live Sending button:**
  - **💤 Live Sending: OFF** = safe mode. It checks every lead and marks who's textable, but **sends nothing**. Use this to review first.
  - **🟢 Live Sending: ON** = it sends the real approved text to clean leads. Click it, confirm the warning, and it turns green.

## E. Run it

1. Click **▶ Start**.
2. Watch the table update live. Each lead ends up with a **Disposition**:
   - **Text Sent** ✅ — approved text was sent
   - **Ready To Text** — clean, but Live Sending was OFF (nothing sent)
   - **Opted Out** — do-not-text tag/opt-out; skipped
   - **Property Sold / Listed** — not textable; skipped
   - **Not Interested / Wrong Number** — skipped
   - **Bad Lead** — multiple bad tags; skipped
   - **Lead NOT Found** — not found in REI, or no phone on the contact
   - **Needs Review** — couldn't confirm/complete; check manually (see Notes column)
3. Use **Pause / Resume / Stop** as needed. Pausing/stopping is safe — progress is saved.

## F. Verify (spot-check)

- Click the **🔗 link** in the **REI Match Status** column to open that contact in REI and confirm it's the right person.
- Click the **Property Address / Property Status** to check the property on Redfin.
- For a **Text Sent** lead, you can open the contact's Chat in REI to see the message went out.

## G. Stopping and continuing later (safe)

- Progress saves after **every** lead, so you can stop anytime.
- To continue an interrupted batch: restart the app (Section A), then click **Resume** (or Start). It **skips leads already done** and continues.
- **Never** re-upload the same file to continue — that restarts from zero.

## H. Export the results

- Click **⬇ Export XLSX** or **⬇ Export CSV** to download the sheet with every lead's disposition, notes, and links. It saves to your Downloads folder.

---

## Safety rules (built in — cannot be overridden)

- A lead is texted **only** if it passes every check: found in REI, has a phone, not sold/listed, no opt-out/bad tag, no blocking words in history, not already contacted.
- Opted-out / do-not-text contacts are **never** texted.
- The message text is **locked** — it cannot be edited.
- The right company template (Twin Home Buyer vs Equity Track) is chosen automatically from REI's "From:" line (THB → Twin Home Buyer, EQT → Equity Track).

## Quick troubleshooting

- **Dashboard won't load in Chrome** → make sure the black `npm start` window is still open, then refresh `http://localhost:3000`.
- **Nothing sends / everything says "Ready To Text"** → Live Sending is OFF. Turn it ON (green) and Resume.
- **A Redfin "press & hold" box appears** → complete it once in that window; it continues.
- **A lead says "Needs Review"** → open it in REI via the 🔗 and handle manually.
- **Want to pause the whole thing** → click Stop; resume later (Section G).
