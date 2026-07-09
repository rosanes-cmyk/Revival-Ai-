# High Equity Lead Revival — Live Text Campaign Dashboard

A live dashboard automation for Twin Home Buyer's High Equity Lead Revival Text
Campaign. Upload a spreadsheet of old high-equity leads, and when you click
**Start Live Automation** it searches each lead in **REI BlackBook**, enforces
the campaign SOP, and **sends the approved revival text immediately — but only
when the lead passes every compliance check.**

> **There is no dry-run mode.** When you click Start Live Automation it runs
> live. A single kill switch (`ALLOW_LIVE_SEND`) is the only thing that blocks
> real sends, and it defaults to on in `.env.example`.

## The approved message (locked)

> "Hi, this is Juan with Twin Home Buyer. You contacted us before about selling
> your home. Are you still interested? Reply YES or NO. Thanks!"

This string lives in `server/automation/message.js`, is frozen, and is checksum
-verified at startup and again immediately before every send. The code will not
send anything that does not match it exactly.

---

## How it works

REI BlackBook has **no public API**, so the automation drives the real website
with a headless (or visible) Chromium browser via **Playwright**, exactly as the
SOP describes:

1. **Log in** to REI BlackBook.
2. **Property Pipeline** — clear/verify the Feed Source, Status, and Deal Type
   filters, then search full address → partial address → owner name.
3. **Smart Contacts** — if still no match, search the owner name.
4. **Read** the matched record's opt-out tags, property status, and contact
   history.
5. **Decide** using the SOP rule engine (`server/automation/sop.js`).
6. **Send** the approved text through REI BlackBook's SMS composer — only if
   eligible.
7. **Record** disposition, notes, and a full per-row log; update the dashboard
   and the exportable spreadsheet.

### Fail-safe design

If the automation **cannot confidently read** any part of a record (e.g. a page
selector doesn't match, or a contact-history date can't be parsed), the row is
marked **Needs Review** or **Error** and **no text is sent**. Uncertainty never
results in a message going out. This directly implements SOP safety rule 6
("never text leads where the system is uncertain").

---

## One-time setup

Because REI BlackBook's page structure is specific to your account, you must
point the automation at the right on-screen elements before the first live run.

### 1. Install

```bash
npm install
npx playwright install chromium   # if Chromium isn't already available
```

### 2. Configure `.env`

```bash
cp .env.example .env
```

Then edit `.env`:

- `REIBB_EMAIL` / `REIBB_PASSWORD` — your REI BlackBook login.
- `HEADLESS=false` — **keep this false for your first runs** so you can watch
  the browser and confirm it clicks the right things.
- `ALLOW_LIVE_SEND` — the master send switch. Set to `true` only after you've
  verified selectors (see next step). While `false`, eligible leads are marked
  `Eligible - Send Blocked` and nothing is sent.
- `CONTACT_WINDOW_DAYS` — the "recent contact" window (default 90).

### 3. Verify the REI BlackBook selectors

Open `config/reibb.selectors.json`. It maps each SOP step to a CSS/text selector
on your live REI BlackBook account. The shipped values are **best-guess
placeholders** — you must confirm each one:

1. Log into REI BlackBook in Chrome.
2. Right-click an element (e.g. the Property Pipeline search box) → **Inspect**.
3. Right-click the highlighted HTML → **Copy → Copy selector**.
4. Paste it into the matching field in `config/reibb.selectors.json`.

Then run one test lead with `HEADLESS=false` and `ALLOW_LIVE_SEND=false` and
watch the browser. When the searches, status reads, and SMS composer all behave
correctly, flip `ALLOW_LIVE_SEND=true`.

### 4. Run

```bash
npm start
# open http://localhost:3000
```

---

## Using the dashboard

1. **Upload Spreadsheet** — CSV or XLSX with the required columns:
   `Owner Name, Property Address, City, State, ZIP Code, Disposition, Notes`.
   A sample is in `data/sample-leads.csv`.
2. **Summary Cards** — Total, Pending, Text Sent, Lead NOT Found, Property Sold,
   Listed, Opted Out, Needs Review, Errors.
3. **Lead Table** — every SOP field per row, updated live.
4. **Controls** — Start Live Automation, Pause, Resume, Stop, Export XLSX,
   Export CSV, View Logs. (There is no Start Dry Run, by design.)

### Pause / Resume / Stop & duplicate protection

- **Pause** halts *between* rows; a row already in flight finishes so a send is
  never left half-done.
- **Stop** ends the run and saves progress.
- **Resume** (or Start again) continues from where it left off. Rows whose
  disposition is already `Text Sent`, `Lead NOT Found`, `Property Sold`,
  `Listed`, or `Opted Out` are **skipped**, so no one is texted twice — even
  across a full server restart (job state is persisted to `data/state/`).

### Export

**Export XLSX / CSV** downloads the updated spreadsheet with the original lead
data plus Disposition, Notes, REI Match Status, Last Contact Date, Opt-Out
Status, Property Status, Eligibility Status, Text Sent Timestamp, and Error Log.

---

## SOP rules enforced (never text when…)

- Opted Out / SMS Opt Out / STOP Request / Text Opt Out → **Opted Out**
- Property sold → **Property Sold**
- Property listed (active MLS) → **Listed**
- Contacted within the last `CONTACT_WINDOW_DAYS` days → **Needs Review**
- No matching lead found → **Lead NOT Found**
- System uncertain about any reading → **Needs Review** / **Error**

`Do Not Mail` / `Do Not Contact` tags **without** an opt-out do **not** block a
text (per SOP step G); the tag is recorded in Notes and the lead proceeds only
if it also passes the recent-contact check.

Only when a lead clears **all** of the above is the approved text sent, and the
row becomes `Text Sent` / `Eligible - Text Sent` with a timestamp.

---

## Project layout

```
config/reibb.selectors.json   REI BlackBook page selectors (you fill these in)
server/index.js               Express server + API + SSE live updates
server/automation/engine.js   Row-by-row orchestrator (start/pause/resume/stop)
server/automation/sop.js      SOP decision rules (pure, auditable)
server/automation/reibb.js    Playwright adapter that drives REI BlackBook
server/automation/message.js  The frozen approved message
server/data/spreadsheet.js    CSV/XLSX parse + export
server/data/store.js          Job state persistence (resume support)
server/logger.js              Per-row structured logging
public/                       Dashboard UI (HTML/CSS/JS)
data/                         Runtime uploads, state, logs, exports (gitignored)
```
