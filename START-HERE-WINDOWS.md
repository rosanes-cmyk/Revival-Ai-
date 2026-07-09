# Start Here — Windows (plain-English guide)

This gets the High Equity Lead Revival Dashboard running on your Windows PC.
You do **not** need to know any coding. Follow these in order.

---

## Step 1 — Install Node.js (one time only)

Node.js is the free engine the dashboard runs on.

1. Go to **https://nodejs.org**
2. Click the big button that says **"LTS"** (the recommended version).
3. Open the file it downloads and click **Next → Next → Install → Finish**.
   (The default choices are fine — just keep clicking Next.)

You only ever do this once.

---

## Step 2 — Get the project onto your PC (one time only)

1. Go to your project page on GitHub:
   **https://github.com/rosanes-cmyk/Revival-Ai-**
2. Near the top, click the branch dropdown (it usually says `main`) and choose
   **`claude/equity-lead-revival-dashboard-xl9l8j`**.
3. Click the green **`< > Code`** button, then **Download ZIP**.
4. Find the downloaded ZIP (usually in your **Downloads** folder), right-click
   it, and choose **Extract All…**. Extract it to your **Desktop** so it's easy
   to find.
5. You'll now have a folder like `Revival-Ai--claude-equity-lead-revival-...`
   on your Desktop. Open it.

---

## Step 3 — Start the dashboard

Inside that folder, find the file named **`start-windows.bat`** and
**double-click it**.

- A black window opens. The **first time**, it spends a few minutes installing
  everything automatically — this is normal. Let it finish.
- When it's ready, your web browser opens to the dashboard automatically at
  **http://localhost:3000**.
- **Keep the black window open** the whole time you're using the dashboard.
  Closing it stops the dashboard.

> If Windows shows a blue "Windows protected your PC" box, click
> **More info → Run anyway**. (This happens because the file is new, not
> because anything is wrong.)

That's it — you can now upload a spreadsheet and click around. Try uploading the
included **`data/sample-leads.csv`** to see it work.

---

## Step 4 — Before you send REAL texts

Steps 1–3 let you SEE and TEST the dashboard. To have it actually log into REI
BlackBook and send texts, two things need to be filled in **once**:

### 4a. Your REI BlackBook login

1. In the project folder, find the file named **`.env`** (the starter file
   created it for you the first time you ran it).
2. Open it with **Notepad** (right-click → Open with → Notepad).
3. Fill in these lines with your real REI BlackBook email and password:
   ```
   REIBB_EMAIL=you@example.com
   REIBB_PASSWORD=your-password-here
   ```
4. Leave `HEADLESS=false` for now — that lets you WATCH the browser work.
5. Save the file (Ctrl+S).

### 4b. Point it at your REI BlackBook screens

Because every REI BlackBook account looks a little different, the automation
needs to know which buttons to click. This is the one part that needs a careful
setup, and **I can do it for you** — just send me screenshots (or a short screen
recording) of your REI BlackBook:

- **Property Pipeline** search page
- A **Contact / lead record** page (showing tags, property status, activity)
- The **Send SMS** window

Send those and I'll fill in the settings file so it clicks the right things.
Until that's done, the dashboard is safe: if it can't confidently read a lead,
it marks the row **Needs Review** and **never sends a text**.

---

## Everyday use (after setup)

Just double-click **`start-windows.bat`** whenever you want to use the dashboard.
It skips the install steps after the first time and opens straight up.

## If you get stuck

Tell me exactly what the black window says, or send a screenshot, and I'll walk
you through it.
