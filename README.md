# High Equity Lead Revival — Live Text Campaign Dashboard

A live dashboard automation for Twin Home Buyer's High Equity Lead Revival Text
Campaign. Upload a spreadsheet of old high-equity leads, and when you click
**Start Live Automation** it searches each lead in **REI BlackBook**, enforces
the campaign SOP, and **sends the approved revival text immediately — but only
when the lead passes every compliance check.**

> **There is no dry-run mode.** When you click Start Live Automation it runs
> live. A single kill switch (`ALLOW_LIVE_SEND`) is the only thing that blocks
> real sends, and it defaults to on in `.env.example`.

## The approved messages (locked)

The message is chosen by each lead's **Company Source** column:

> **Twin Home Buyer:** "Hi, this is Juan with Twin Home Buyer. You contacted us
> before about selling your home. Are you still interested? Reply YES or NO. Thanks!"

> **Equity Track Inc.:** "Hi, this is Juan with Equity Track Inc. You contacted
> us before about selling your home. Are you still interested? Reply YES or NO. Thanks!"

Both strings live in `server/automation/message.js`, are frozen, and are
checksum-verified at startup and again immediately before every send. The code
will not send anything that does not match one of them exactly. A lead whose
Company Source is neither company is held as **Needs Review** (no send).

---

## How it works

REI BlackBook has **no public API**, so the automation drives the real website
with a headless (or visible) Chromium browser via **Playwright**, exactly as the
SOP describes:

1. **Log in** to REI BlackBook.
2. **Search** in order until a match is found: Property Pipeline by full address
   → street address → house # + street → owner name; then Contacts by owner name
   → phone → email.
3. **Open the contact** (from the matched Pipeline property, or directly from a
   Contacts match).
4. **Read** the contact's tags, phone, property status, and Notes/Activities/Chat
   history.
5. **Decide** with the SOP rule engine (`server/automation/sop.js`): match,
   sold, listed, bad tags, blocking phrases, failed/undelivered, already-sent,
   phone present, company valid.
6. **Apply the Revival tag** for the outcome (`Revival - Text Sent`,
   `Revival - Do Not Text`, `Revival - Sold`, …) back onto the REI contact.
7. **Send** the company-specific approved text through the Chat/Text panel —
   only if the lead is clean — and verify the sent message appears in the thread.
8. **Record** disposition, notes, tag, and a full per-row log; update the
   dashboard and the exportable spreadsheet; save progress after every row.

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
  disposition is already finished — `Text Sent`, `Lead NOT Found`,
  `Property Sold`, `Listed`, `Opted Out`, `Not Interested`, `Wrong Number`,
  `Failed Number`, or `Already Contacted` — are **skipped**, so no one is texted
  twice, even across a full server restart (state persisted to `data/state/`).
  `Needs Review` and `Error` rows are re-attempted.

### Export

**Export XLSX / CSV** downloads the updated spreadsheet with the original lead
data plus Company Source, Phone, Email, Disposition, Notes, REI Match Status,
Search Method Used, Property Status, Opt-Out / Safety, Eligibility Status,
REI Tag Applied, Text Sent Timestamp, and Error Log.

---

## SOP outcomes (each also writes its Revival tag to the REI contact)

| Condition | Disposition | REI tag |
|---|---|---|
| No match after all searches | Lead NOT Found | `Revival - Lead Not Found` |
| Property sold | Property Sold | `Revival - Sold` |
| Property listed (active MLS) | Listed | `Revival - Listed` |
| Bad tag or opt-out/stop/do-not-text phrase | Opted Out | `Revival - Do Not Text` |
| "not interested" tag/phrase | Not Interested | `Revival - Not Interested` |
| "wrong number" tag/phrase | Wrong Number | `Revival - Wrong Number` |
| Latest message failed/undelivered | Failed Number | `Revival - Failed Number` |
| Approved message already sent | Already Contacted | `Revival - Already Contacted` |
| No phone / unknown company / anything uncertain | Needs Review | `Revival - Needs Review` |
| **Clean** — passes every check | Text Sent | `Revival - Text Sent` |

**Never texts** on any of the non-clean rows above, on a sold/listed property,
or whenever a tag or history can't be read. Compliance is tag- and phrase-based:
a lead is textable **only** when it carries no bad tag, its history has no
blocking phrase, its latest message didn't fail, the approved message wasn't
already sent, it has a phone, and its Company Source is one of the two approved
senders. `Do Not Mail` alone does **not** block a text.

Bad tags and blocking phrases are configurable in
`server/automation/constants.js` (`SAFETY_TAG_RULES`, `BLOCKING_PHRASES`).

---

## Project layout

```
config/reibb.selectors.json   REI BlackBook page selectors (you fill these in)
server/index.js               Express server + API + SSE live updates
server/automation/engine.js   Row-by-row orchestrator (start/pause/resume/stop)
server/automation/sop.js      SOP decision rules (pure, auditable)
server/automation/reibb.js    Playwright adapter that drives REI BlackBook
server/automation/message.js  The two frozen approved messages (per company)
server/automation/constants.js Dispositions, Revival tags, bad tags, phrases
server/data/spreadsheet.js    CSV/XLSX parse + export
server/data/store.js          Job state persistence (resume support)
server/logger.js              Per-row structured logging
public/                       Dashboard UI (HTML/CSS/JS)
data/                         Runtime uploads, state, logs, exports (gitignored)
```
