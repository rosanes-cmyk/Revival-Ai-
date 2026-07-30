# Revival AI — Complete Architecture & Build Reference

> **Purpose of this file:** This is a self-contained reference describing the
> Revival AI project (the "Twin Text Platform") — what it does, how it is built,
> and the reusable patterns behind it. It is written to be handed to another AI
> coding assistant (e.g. Claude Code) as context for building or combining with
> another app. Read it top to bottom before writing code.

---

## 1. One-paragraph summary

Revival AI is a **local desktop app** that automates a sales task: it takes a
spreadsheet of old real-estate leads, looks each one up in **REI BlackBook** (a
CRM with no public API) by driving the real website with a headless browser,
checks a strict set of safety/compliance rules, and — only if the lead passes
every check — **sends an approved "revival" text message** through the CRM's
chat panel. Results are written back to the spreadsheet and shown live on a
dashboard. The guiding principle everywhere: **when in doubt, do not send.**

---

## 2. Core design principle (the most important idea)

**Fail closed. Uncertainty never results in an irreversible action.**

Every step that cannot be read/confirmed with confidence routes the lead to a
"Needs Review" / "Lead Not Found" bucket and sends nothing. A message only goes
out when *all* independent safety layers pass. This single principle drives the
entire architecture.

---

## 3. Architecture — four layers

```
┌─────────────────────────────────────────────────────────┐
│  ELECTRON DESKTOP WRAPPER  (electron/main.cjs)           │  double-click Windows app
│   starts the Express server, opens a window at localhost │
└─────────────────────────────────────────────────────────┘
                          │
┌─────────────────────────────────────────────────────────┐
│  WEB DASHBOARD  (public/index.html, app.js, styles.css)  │  upload, Start/Pause/Stop, live table
│   talks to the server via HTTP + Server-Sent Events      │
└─────────────────────────────────────────────────────────┘
                          │
┌─────────────────────────────────────────────────────────┐
│  EXPRESS SERVER  (server/index.js)                       │  REST API + SSE stream
│   /upload /start /pause /resume /stop /state /logs /export│
└─────────────────────────────────────────────────────────┘
                          │
┌─────────────────────────────────────────────────────────┐
│  AUTOMATION CORE  (server/automation/ + server/data/)    │  the brains
│   engine → browser adapters → SOP rules → messages       │
└─────────────────────────────────────────────────────────┘
```

**The key architectural rule (steal this):** decision logic is completely
separated from browser automation.
- `sop.js` = **pure functions**. Input: facts about a lead. Output: a decision
  (send / don't + reason + which message). No browser, no network. Auditable and
  unit-testable.
- `reibb.js` = the **browser adapter**. It only *gathers facts* and *performs
  actions*. It never decides anything.

---

## 4. Technology stack

| Concern | Technology | Notes |
|---|---|---|
| Runtime | Node.js (>=18), ES modules (`"type":"module"`) | |
| HTTP server | Express 4 | serves dashboard + API |
| Browser automation | Playwright (Chromium) | CRM has no API → drive the real site |
| Spreadsheet I/O | `xlsx` | read CSV/XLSX, write results back |
| File upload | `multer` | spreadsheet upload endpoint |
| Live updates | Server-Sent Events (SSE) | push each row result to the UI in real time |
| Desktop packaging | Electron 31 + electron-builder 24 | NSIS Windows installer |
| CI build | GitHub Actions (windows-latest) | auto-build the `.exe` |
| Persistence | plain JSON files on disk | job state + monthly ledger |

No database. State is JSON files in a writable data directory.

---

## 5. End-to-end processing flow (one lead)

The engine (`engine.js` → `_processRow`) runs this ordered pipeline for **each
row** of the uploaded spreadsheet:

```
1. STATE FILTER    → Property outside allowed states (default CA)? → "Out of State", skip.
2. PROPERTY CHECK  → Look up address on Redfin/PropertyRadar FIRST.
                     Sold or Listed? → skip (no text). (This step can only ADD a block.)
3. LOCATE IN CRM   → Search REI BlackBook in order:
                     address → street → owner name → phone → email.
                     Open the matched contact. No match? → "Lead Not Found", skip.
4. GATHER FACTS    → Read tags, phone, notes, chat/SMS history, last-message
                     status, and which company the contact belongs to.
5. DECIDE (sop.js) → Pure rules engine returns {shouldSend, disposition, message, reason}.
6. LEDGER CHECK    → Already texted this calendar month? → skip (no repeat).
7. SEND (or not)   → ONLY if shouldSend AND kill switch ON:
                     pick approved template → fill {{first_name}} → send via chat panel
                     → verify the message actually appears in the thread.
8. RECORD          → Write disposition/notes/timestamp to spreadsheet + monthly ledger.
                     Persist job state to disk (resume-safe, no double-texts).
```

Control model: **Start / Pause / Resume / Stop.** Pause halts *between* rows — a
row already in flight always finishes, so a send is never left half-done. State
is written after every row, so a crash or Stop resumes cleanly.

---

## 6. The safety system (the crown jewel — reuse this pattern)

Multiple **independent** layers must all pass before any message is sent:

1. **Master kill switch** — an env var (`ALLOW_LIVE_SEND`) that must be exactly
   `"true"`. Ships as `false`. There is no dry-run mode; this one flag is the
   gate, checked at the moment of the send.
2. **Message integrity checksum** — approved messages are frozen (`Object.freeze`)
   and validated at startup *and* immediately before every send. Tampered copy →
   the app refuses to run.
3. **Locked approved copy only** — a small pool of pre-approved templates per
   company. The code will never send anything not in the list. Templates rotate
   so carriers don't flag identical mass texts.
4. **Suppression scan** — reads tags + notes + chat history together and blocks
   on: opt-out / "STOP" replies, "not interested", "wrong number", "do not
   automate", sold, listed, failed/undelivered.
5. **Monthly ledger** — persistent memory keyed by **both** CRM contact ID and
   phone number; never texts the same lead twice in one calendar month. Survives
   restarts, re-uploads, and full CRM pulls. Resets automatically each month.
6. **Batch cap** — max sends per run (default 100) to protect the sending number
   from carrier spam flags; auto-continues in gentle batches.
7. **Geographic filter** — only text allowed states (default California).
8. **"Sold since last contact" check** — if the property sold *after* our last
   conversation, skip even if other checks pass.
9. **Resume-safe state** — written after every row so nothing is ever re-sent.

Design rule for all of it: **each layer can only ADD a block, never enable a
send.** Blocks compose safely.

---

## 7. File-by-file map

### Automation core — `server/automation/`
- **`engine.js`** — orchestrator. Main loop, Start/Pause/Resume/Stop, batching,
  resume, browser-crash recovery, monthly-memory pre-fill. *(Read first.)*
- **`sop.js`** — pure decision rules engine. Facts in → decision out. No browser.
- **`message.js`** — locked approved templates, rotation, `{{first_name}}`
  rendering, `assertMessageIntegrity()` checksum, company normalization.
- **`constants.js`** — dispositions, eligibility states, tag names, blocking
  phrases, opt-out/`STOP` regexes, export column names.
- **`reibb.js`** — the large Playwright adapter driving REI BlackBook: login,
  multi-strategy search, read a contact, send a text, apply tags, enumerate all
  contacts, verify a message is present, account fingerprint.
- **`redfin.js` / `propertyradar.js` / `redfinLink.js`** — property Sold/Listed
  lookups and Redfin deep-link resolution.

### Data layer — `server/data/`
- **`store.js`** — job state persistence + resume. Writes after each row.
- **`spreadsheet.js`** — forgiving CSV/XLSX import (maps many column-name
  variants to internal fields), keeps all original columns, exports results back
  into the user's own columns plus appended automation columns.
- **`sentLedger.js`** — persistent monthly "already worked / already texted"
  memory, keyed by contact ID + normalized phone, scoped per calendar month.

### Server & app shell
- **`server/index.js`** — Express API + SSE stream + build-info reporting.
- **`server/loadenv.js`** — minimal `.env` loader.
- **`server/logger.js`** — structured per-row job logging.
- **`public/index.html` / `app.js` / `styles.css`** — the dashboard UI.
- **`electron/main.cjs`** — desktop wrapper: spawns the server using Electron's
  bundled Node (`ELECTRON_RUN_AS_NODE=1`), waits for it to be ready, shows it in
  a window, points writable data at the OS user-data dir.
- **`scripts/write-build-info.js`** — stamps `build-info.json` with the git
  commit so the packaged app can display exactly which code it runs.

### Config & docs
- **`.env.example`** — every setting, heavily commented (best config reference).
- **`config/*.selectors.json`** — CSS/text selectors mapping each SOP step to
  on-screen CRM elements; must be verified per account.
- **`README.md`, `SOP-REVIVAL-AI.md`, `TUTORIAL.md`, `START-HERE-WINDOWS.md`,
  `INSTALL-APP.md`** — human documentation.

---

## 8. Key configuration (from `.env.example`)

| Variable | Meaning |
|---|---|
| `ALLOW_LIVE_SEND` | Master send switch. Must be `true` to send. Defaults `false`. |
| `PORT` | Web server port (default 3000). |
| `REIBB_LOGIN_URL` / `REIBB_EMAIL` / `REIBB_PASSWORD` | CRM login (optional — first-run manual login is remembered). |
| `REIBB_PIPELINE_URL` / `REIBB_CONTACTS_URL` | CRM page addresses. |
| `HEADLESS` | `false` to watch the browser (recommended early); `true` for background. |
| `SLOWMO_MS` | Slow each Playwright action (helps verify selectors). |
| `ACTION_TIMEOUT_MS` | Max wait per element before bailing to Needs Review. |
| `PROPERTY_SOURCE` | `redfin` (free, no login) / `propertyradar` (login) / `none`. |
| `REDFIN_LINKS` | Add exact Redfin deep-links to the dashboard. |
| `MAX_SENDS_PER_RUN` | Batch cap (default 100; 0 = unlimited). |
| `AUTO_CONTINUE` / `BATCH_PAUSE_MS` | Auto-run next batch after a short pause. |
| `DEFAULT_COMPANY` | Which approved message when a lead has no company column. |
| `TEXT_STATES` | Allowed states (default `CA,California`). |
| `SKIP_TEXTED_THIS_MONTH` | Enforce the monthly no-repeat rule. |
| `WRITE_REI_TAGS` | Whether to write outcome tags back onto CRM contacts. |

---

## 9. Server API surface

```
POST /api/upload          upload CSV/XLSX → create a job
POST /api/start           Start live automation
POST /api/pause           Pause (between rows)
POST /api/resume          Resume
POST /api/stop            Stop (progress saved)
GET  /api/state           current job snapshot (cards + table)
GET  /api/logs            structured logs
GET  /api/export?format=  download updated spreadsheet (xlsx|csv)
GET  /api/events          Server-Sent Events stream for live updates
```

---

## 10. Build & distribution process

1. `package.json` carries an `electron-builder` config: appId, product name,
   NSIS installer branded "Revival AI", desktop + start-menu shortcuts, icons.
2. Playwright's Chromium is **bundled inside the installer**
   (`PLAYWRIGHT_BROWSERS_PATH=0` during `npx playwright install chromium`), so it
   runs on a fresh PC with no extra downloads.
3. `npm run dist` → `electron-builder --win` → produces a Windows `.exe` in
   `dist/`. A `predist` step writes `build-info.json` first.
4. **GitHub Actions** (`.github/workflows/build-windows-app.yml`) builds it on a
   Windows runner (manual "Run workflow" or on a `v*` tag) and uploads the `.exe`
   as an artifact — no local Windows machine required.
5. Writable data (browser profile/login, job state, logs, ledger) goes to the OS
   user-data folder via `REVIVAL_DATA_DIR`, because the install dir is read-only.

Run modes:
- `npm start` — server only, use the dashboard at `localhost:3000` (dev).
- `npm run app` — Electron desktop app in dev.
- `npm run dist` — build the Windows installer.

---

## 11. Reusable patterns to carry into another app

These are provider-agnostic ideas — the real value to reuse:

1. **Separate gather-facts / decide / act.** Keep decisions in pure functions;
   keep the messy I/O (browser, API) dumb. Test the rules in isolation.
2. **A single master kill switch** that defaults to *off* and is checked at the
   moment of the irreversible action.
3. **Idempotent + resumable.** Persist state after every unit of work; key a
   ledger on stable IDs so nothing runs twice — across restarts and re-imports.
4. **Fail closed.** Any uncertainty routes to a review bucket, never to the
   irreversible action. Every safety layer can only ADD a block.
5. **Drive a website with Playwright when there's no API:** ordered search
   fallbacks, verify the action actually happened, recover from browser crashes.
6. **Web app inside Electron:** one codebase runs as `localhost` for developers
   and as a double-click desktop app for non-technical users.
7. **CI builds the installer** so distribution doesn't depend on any one machine.
8. **Forgiving data import:** map many column-name variants to internal fields;
   preserve original columns; write results back into the user's own file.
9. **Live UI via SSE:** stream progress/results to the dashboard as work happens,
   plus an ETA from a rolling average of per-item time.

---

## 12. Glossary

- **Disposition** — the final outcome label for a lead (e.g. Text Sent, Opted
  Out, Property Sold, Lead Not Found, Needs Review, Out of State, Error).
- **Eligibility** — whether a lead is allowed to be texted at this moment.
- **Ledger** — the persistent monthly memory of who's been worked/texted.
- **Adapter** — a browser-automation module for one external site (REI/Redfin/…).
- **Facts** — the read-only data gathered about a lead before any decision.
- **SOP** — Standard Operating Procedure; the campaign's rulebook, encoded in
  `sop.js` + `constants.js`.

---

*End of reference. When building a related or combined app, start from Sections
2, 3, and 6 (design principle, architecture, safety), then adapt the adapters
(Section 7) to whatever external system the new app must drive.*
