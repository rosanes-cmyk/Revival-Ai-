// Express server for the Twin Text Platform dashboard.
//
// Serves the dashboard UI and exposes the control API:
//   POST /api/upload          - upload CSV/XLSX, create a job
//   POST /api/start           - Start Live Automation
//   POST /api/pause           - Pause
//   POST /api/resume          - Resume
//   POST /api/stop            - Stop
//   GET  /api/state           - current job snapshot (cards + table)
//   GET  /api/logs            - structured logs (View Logs)
//   GET  /api/export?format=  - download updated spreadsheet (xlsx|csv)
//   GET  /api/events          - Server-Sent Events stream for live updates

import "./loadenv.js";
import express from "express";
import multer from "multer";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { parseSpreadsheet, exportToXlsx, exportToCsv } from "./data/spreadsheet.js";
import { JobStore, summarizeRows } from "./data/store.js";
import { DISPOSITION } from "./automation/constants.js";
import { JobLogger } from "./logger.js";
import { AutomationEngine } from "./automation/engine.js";
import { assertMessageIntegrity, APPROVED_MESSAGES } from "./automation/message.js";
import { chromium } from "playwright";
import { execSync } from "child_process";

// Which code is this instance running? Prefer live git (accurate for the
// localhost/code version); fall back to build-info.json (bundled into the
// packaged app, which has no .git); finally just the package version.
const __dirname = path.dirname(fileURLToPath(import.meta.url));

function getBuildInfo() {
  const repoRoot = path.join(__dirname, "..");
  try {
    const commit = execSync("git rev-parse --short HEAD", { cwd: repoRoot, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    const commitDate = execSync("git show -s --format=%cI HEAD", { cwd: repoRoot, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    if (commit) return { source: "git", commit, commitDate, builtAt: "" };
  } catch { /* not a git checkout (packaged app) */ }
  try {
    const info = JSON.parse(fs.readFileSync(path.join(repoRoot, "build-info.json"), "utf8"));
    return { source: "build", ...info };
  } catch { /* no build-info.json */ }
  return { source: "version", commit: "unknown", commitDate: "", builtAt: "" };
}
const BUILD_INFO = getBuildInfo();

// Safety net: keep the server ALIVE if an async error slips through. An
// unhandled rejection/exception would otherwise kill the Node process and show
// "engine stopped (code 1)". Log it and keep running so a single bad lead can't
// take down the whole app.
process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason && reason.stack ? reason.stack : reason);
});
process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err && err.stack ? err.stack : err);
});

assertMessageIntegrity();

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));

// --- Live application state -------------------------------------------------
const engine = new AutomationEngine();
let store = null;
let logger = null;
const sseClients = new Set();

// Reattach the most recent job on boot so Resume survives a restart (SOP 8).
(function bootstrap() {
  const existing = JobStore.loadCurrent();
  if (existing) {
    store = existing;
    logger = new JobLogger(store.job.jobId);
    engine.attach(store, logger);
    console.log(`[boot] Reattached job ${store.job.jobId} (status: ${store.job.status}).`);
  }
})();

// --- SSE broadcast ----------------------------------------------------------
function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) res.write(payload);
}
engine.on("state", (d) => broadcast("state", d));
engine.on("row", (d) => broadcast("row", d));
engine.on("summary", (d) => broadcast("summary", d));
engine.on("progress", (d) => broadcast("progress", d));
engine.on("final", (d) => broadcast("final", d));
engine.on("error", (err) => broadcast("state", { message: `Error: ${err.message}` }));

app.get("/api/events", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write("retry: 3000\n\n");
  sseClients.add(res);
  req.on("close", () => sseClients.delete(res));
});

// --- Pretty daily report (styled HTML, print/save-as-PDF friendly) ---------
app.get("/api/report", (req, res) => {
  const scope = String(req.query.scope || "both").toLowerCase(); // today | month | both
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(buildReportHtml(store ? store.job : null, scope));
});

// Launch a headless Chromium for PDF rendering. Tries the default browser
// first (chrome-headless-shell, bundled by `playwright install`); if that
// binary is missing, falls back to the full Chromium the automation uses.
async function launchPdfBrowser() {
  try {
    return await chromium.launch({ headless: true });
  } catch (e1) {
    let exe;
    try { exe = chromium.executablePath(); } catch { exe = undefined; }
    if (exe) return await chromium.launch({ headless: true, executablePath: exe });
    throw e1;
  }
}

// Download the report as a real PDF (rendered by the bundled Chromium) so the
// Save buttons download a file directly instead of opening the print dialog.
app.get("/api/report.pdf", async (req, res) => {
  const scope = String(req.query.scope || "both").toLowerCase();
  const html = buildReportHtml(store ? store.job : null, scope);
  let browser = null;
  try {
    browser = await launchPdfBrowser();
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "load" });
    const pdf = await page.pdf({
      format: "Letter",
      printBackground: true,
      margin: { top: "0.4in", bottom: "0.4in", left: "0.4in", right: "0.4in" },
    });
    const day = new Date().toISOString().slice(0, 10);
    const name =
      scope === "today" ? `Revival-Report-Today-${day}.pdf`
      : scope === "month" ? `Revival-Report-Month-${day}.pdf`
      : `Revival-Report-${day}.pdf`;
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${name}"`);
    res.send(pdf);
  } catch (err) {
    console.error("[report.pdf] failed:", err.message);
    res.status(500).json({ error: "Could not generate PDF: " + err.message });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
});

// Render one report block (tiles + full breakdown) for a summary object.
function reportBlock(title, subtitle, s) {
  const n = (v) => Number(v || 0).toLocaleString();
  s = s || {};
  const soldListed = (s.propertySold || 0) + (s.listed || 0);
  const notIntOut = (s.notInterested || 0) + (s.optedOut || 0);
  const bad = (s.wrongNumber || 0) + (s.failedNumber || 0) + (s.leadNotFound || 0) + (s.badLead || 0);
  const worked = (s.total || 0) - (s.pending || 0);
  const tiles = [
    { label: "Total Leads", value: s.total, accent: "#4f8cff" },
    { label: "Leads Worked", value: worked, accent: "#8b5cf6" },
    { label: "Text Sent", value: s.textSent, accent: "#16a34a" },
    { label: "Property Sold / Listed", value: soldListed, accent: "#f59e0b" },
    { label: "Not Interested / Opt Out", value: notIntOut, accent: "#ef4444" },
    { label: "To Delete / Bad Leads", value: bad, accent: "#6b7280" },
  ];
  const breakdown = [
    ["Text Sent", s.textSent, "#16a34a"],
    ["Property Sold", s.propertySold, "#f59e0b"],
    ["Listed", s.listed, "#f59e0b"],
    ["Opted Out", s.optedOut, "#ef4444"],
    ["Not Interested", s.notInterested, "#ef4444"],
    ["Wrong Number", s.wrongNumber, "#6b7280"],
    ["Failed Number", s.failedNumber, "#6b7280"],
    ["Already Contacted", s.alreadyContacted, "#94a3b8"],
    ["Texted This Month", s.textedThisMonth, "#0ea5e9"],
    ["Bad Lead", s.badLead, "#6b7280"],
    ["Out of State", s.outOfState, "#6b7280"],
    ["Lead NOT Found", s.leadNotFound, "#6b7280"],
    ["Pending", s.pending, "#94a3b8"],
    ["Errors", s.errors, "#ef4444"],
  ].filter((r) => (r[1] || 0) > 0);
  const tileHtml = tiles
    .map(
      (t) => `<div class="tile" style="--a:${t.accent}">
        <div class="tval">${n(t.value)}</div>
        <div class="tlbl">${t.label}</div>
      </div>`
    )
    .join("");
  const rowsHtml = breakdown
    .map(
      ([label, val, color]) => `<tr>
        <td><span class="dot" style="background:${color}"></span>${label}</td>
        <td class="num">${n(val)}</td>
      </tr>`
    )
    .join("");
  // Plain-English quick brief.
  const when = title === "Today" ? "today" : "this month";
  const brief = worked
    ? `Here are the leads worked ${when} (${subtitle}): <b>${n(worked)}</b> leads worked — <b>${n(s.textSent)}</b> texts sent, ${n(soldListed)} sold/listed, ${n(notIntOut)} not interested / opted out, and ${n(bad)} to delete / bad leads.`
    : `No leads have been worked ${when} yet (${subtitle}).`;
  return `<div class="block">
    <div class="block-head"><h2>${title}</h2><span>${subtitle}</span></div>
    <p class="brief">📌 ${brief}</p>
    <div class="tiles">${tileHtml}</div>
    <table>${rowsHtml || '<tr><td colspan="2">No activity yet.</td></tr>'}</table>
  </div>`;
}

function buildReportHtml(job, scope = "both") {
  const nowD = new Date();
  const now = nowD.toLocaleString();
  const todayLabel = nowD.toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" });
  const monthLabel = nowD.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  const file = (job && job.sourceFileName) || "—";
  const rows = job && Array.isArray(job.rows) ? job.rows : [];
  // "Today" = leads actually worked today (by their real timestamp), so the
  // Today section resets each day. Leads carried over from earlier this month
  // keep their original work date and are NOT counted as today.
  const isToday = (iso) => {
    if (!iso) return false;
    try { return new Date(iso).toDateString() === nowD.toDateString(); } catch { return false; }
  };
  const workedToday = (r) => isToday(r.processedAt) || isToday(r.textSentTimestamp);
  const todayRows = rows.filter(workedToday);
  const todaySummary = summarizeRows(todayRows);
  const monthSummary = summarizeRows(rows);
  const todayBlock = reportBlock("Today", todayLabel, todaySummary);
  const monthBlock = reportBlock("This Month so far", monthLabel, monthSummary);
  const blocksHtml =
    scope === "today" ? todayBlock : scope === "month" ? monthBlock : todayBlock + monthBlock;
  const docTitle =
    scope === "today"
      ? `Twin Text Platform — Today ${todayLabel}`
      : scope === "month"
      ? `Twin Text Platform — ${monthLabel}`
      : "Twin Text Platform — Daily Report";
  return `<!doctype html><html><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${docTitle}</title>
<style>
  * { box-sizing: border-box; }
  body { margin:0; background:#f1f5f9; color:#0f172a; font-family:'Segoe UI',system-ui,Arial,sans-serif; }
  .page { max-width:900px; margin:24px auto; background:#fff; border-radius:16px; box-shadow:0 10px 40px rgba(2,6,23,.10); overflow:hidden; }
  .head { padding:28px 32px; background:linear-gradient(135deg,#0b0b0d,#14532d); color:#fff; }
  .head h1 { margin:0; font-size:24px; letter-spacing:.2px; }
  .head p { margin:6px 0 0; opacity:.8; font-size:13px; }
  .meta { display:flex; gap:24px; flex-wrap:wrap; padding:14px 32px; background:#f8fafc; border-bottom:1px solid #e2e8f0; font-size:13px; color:#475569; }
  .meta b { color:#0f172a; }
  .tiles { display:grid; grid-template-columns:repeat(3,1fr); gap:16px; padding:24px 32px; }
  .tile { border:1px solid #e2e8f0; border-left:5px solid var(--a); border-radius:12px; padding:16px 18px; background:#fff; }
  .tval { font-size:34px; font-weight:800; color:var(--a); line-height:1; }
  .tlbl { margin-top:8px; font-size:12px; text-transform:uppercase; letter-spacing:.4px; color:#64748b; font-weight:600; }
  .section { padding:8px 32px 28px; }
  .section h2 { font-size:15px; color:#334155; margin:8px 0 12px; }
  .block { padding:8px 32px 12px; }
  .block + .block { border-top:8px solid #f1f5f9; margin-top:6px; padding-top:20px; }
  .block-head { display:flex; align-items:baseline; justify-content:space-between; margin:6px 0 4px; }
  .block-head h2 { margin:0; font-size:19px; color:#0f172a; }
  .block-head span { font-size:13px; color:#64748b; font-weight:600; }
  .brief { margin:4px 0 14px; padding:12px 16px; background:#f0fdf4; border:1px solid #bbf7d0; border-radius:10px; font-size:14px; line-height:1.5; color:#14532d; }
  .brief b { color:#0f172a; }
  table { width:100%; border-collapse:collapse; font-size:14px; }
  td { padding:10px 8px; border-bottom:1px solid #eef2f7; }
  td.num { text-align:right; font-weight:700; font-variant-numeric:tabular-nums; }
  .dot { display:inline-block; width:10px; height:10px; border-radius:50%; margin-right:10px; vertical-align:middle; }
  .foot { padding:16px 32px 26px; color:#94a3b8; font-size:12px; }
  .bar { padding:16px 32px; display:flex; gap:10px; }
  .btn { border:0; border-radius:10px; padding:10px 16px; font-weight:700; cursor:pointer; }
  .btn-print { background:#16a34a; color:#fff; }
  @media print {
    body { background:#fff; }
    .page { box-shadow:none; margin:0; max-width:none; border-radius:0; }
    .bar { display:none; }
    /* Tighten everything so each section fits on ONE page. */
    .head { padding:14px 24px; }
    .head h1 { font-size:19px; }
    .head p { font-size:11px; margin-top:3px; }
    .meta { padding:8px 24px; font-size:11px; gap:16px; }
    .block { padding:6px 24px 8px; }
    .block-head h2 { font-size:16px; }
    .block-head span { font-size:11px; }
    .brief { margin:4px 0 8px; padding:8px 12px; font-size:12px; line-height:1.35; }
    .tiles { gap:8px; padding:8px 0; }
    .tile { padding:8px 10px; border-radius:8px; }
    .tval { font-size:22px; }
    .tlbl { margin-top:3px; font-size:10px; }
    table { font-size:12px; }
    td { padding:4px 8px; }
    .foot { padding:8px 24px 12px; font-size:10px; }
    /* When saving both sections, start each on its own page. */
    .block + .block { break-before:page; border-top:0; margin-top:0; padding-top:14px; }
  }
  @media (max-width:640px){ .tiles { grid-template-columns:1fr 1fr; } }
</style></head><body>
  <div class="page">
    <div class="head">
      <h1>Twin Text Platform — Daily Report</h1>
      <p>Twin Home Buyer &amp; Equity Track Inc. · Lead Text-Revival Campaign</p>
    </div>
    <div class="meta">
      <div>Generated: <b>${now}</b></div>
      <div>Lead file: <b>${String(file).replace(/[<>&]/g, "")}</b></div>
    </div>
    ${blocksHtml}
    <div class="bar"><a class="btn btn-print" href="/api/report.pdf?scope=${scope}" download>💾 Save PDF</a></div>
    <div class="foot">Twin Text Platform · results are recorded in the dashboard and export. No REI tags are added.</div>
  </div>
</body></html>`;
}

// --- Config surface ---------------------------------------------------------
app.get("/api/config", (req, res) => {
  res.json({
    approvedMessages: APPROVED_MESSAGES,
    defaultCompany: engine.defaultCompany,
    approvedMessage: APPROVED_MESSAGES[engine.defaultCompany],
    allowLiveSend: engine.allowLiveSend,
    maxSendsPerRun: engine.maxSendsPerRun,
    autoContinue: engine.autoContinue,
    schedule,
    // Address(es) teammates on THIS computer's WiFi can open to share the dashboard.
    shareUrls: lanAddresses().map((ip) => `http://${ip}:${PORT}`),
    build: BUILD_INFO,
  });
});

// --- Daily scheduler --------------------------------------------------------
// Persisted {enabled, time:"HH:MM", lastRun:"YYYY-MM-DD"}. A timer auto-starts
// the next batch once per day at the set time (the app must be running).
const WRITABLE_STATE_DIR = process.env.REVIVAL_DATA_DIR
  ? path.join(process.env.REVIVAL_DATA_DIR, "state")
  : path.join(__dirname, "..", "data", "state");
fs.mkdirSync(WRITABLE_STATE_DIR, { recursive: true });
const SCHEDULE_FILE = path.join(WRITABLE_STATE_DIR, "schedule.json");

function loadSchedule() {
  try {
    return JSON.parse(fs.readFileSync(SCHEDULE_FILE, "utf8"));
  } catch {
    return { enabled: false, time: "09:00", lastRun: "" };
  }
}
function saveSchedule(s) {
  try {
    fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(s, null, 2));
  } catch (err) {
    console.error("[schedule] save failed:", err.message);
  }
}
let schedule = loadSchedule();

function todayStr(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function nowHHMM(d = new Date()) {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

setInterval(async () => {
  if (!schedule.enabled || !store || engine.isBusy()) return;
  const today = todayStr();
  if (schedule.lastRun === today) return; // already fired today
  if (nowHHMM() !== schedule.time) return;
  schedule.lastRun = today;
  saveSchedule(schedule);
  broadcast("state", { message: `Scheduled run starting (daily at ${schedule.time}).` });
  try {
    await engine.start();
  } catch (err) {
    broadcast("state", { message: `Scheduled run could not start: ${err.message}` });
  }
}, 30000);

app.post("/api/schedule", (req, res) => {
  const enabled = !!(req.body && req.body.enabled);
  const time = String((req.body && req.body.time) || "09:00");
  if (!/^\d{2}:\d{2}$/.test(time)) return res.status(400).json({ error: "Time must be HH:MM." });
  // Reset lastRun so it can fire today if the time hasn't passed yet.
  schedule = { enabled, time, lastRun: enabled ? "" : schedule.lastRun };
  saveSchedule(schedule);
  res.json({ ok: true, schedule });
});

// --- Live-send switch (toggle from the dashboard) ---------------------------
// Persisted so it survives restarts. Lets each installed copy turn real texting
// on/off without editing .env. Defaults to the .env value the first time.
const LIVE_SEND_FILE = path.join(WRITABLE_STATE_DIR, "livesend.json");

function loadLiveSend(fallback) {
  try {
    const v = JSON.parse(fs.readFileSync(LIVE_SEND_FILE, "utf8"));
    return !!v.enabled;
  } catch {
    return fallback;
  }
}
function saveLiveSend(enabled) {
  try {
    fs.writeFileSync(LIVE_SEND_FILE, JSON.stringify({ enabled: !!enabled }, null, 2));
  } catch (err) {
    console.error("[live-send] save failed:", err.message);
  }
}
// Apply the persisted choice at startup (env value is the first-run default).
engine.allowLiveSend = loadLiveSend(engine.allowLiveSend);

app.post("/api/live-send", (req, res) => {
  const enabled = !!(req.body && req.body.enabled);
  engine.allowLiveSend = enabled;
  saveLiveSend(enabled);
  broadcast("state", { message: enabled ? "LIVE SENDING TURNED ON — real texts will be sent to clean leads." : "Live sending turned OFF — no texts will be sent." });
  res.json({ ok: true, allowLiveSend: engine.allowLiveSend });
});

// Re-verify already-"Text Sent" leads against the live REI chat. Runs in the
// background; progress streams over SSE. Returns immediately.
app.post("/api/reverify", (req, res) => {
  if (engine.isBusy()) return res.status(409).json({ error: "Automation is running. Stop it first, then Re-verify." });
  if (!store) return res.status(400).json({ error: "Upload leads first." });
  engine.reverify().catch((err) => broadcast("state", { message: `Re-verify error: ${err.message}` }));
  res.json({ ok: true });
});

// Toggle auto-continue (keep sending batch after batch until Stop).
app.post("/api/auto-continue", (req, res) => {
  engine.autoContinue = !!(req.body && req.body.enabled);
  res.json({ ok: true, autoContinue: engine.autoContinue });
});

// Set the per-run text cap from the dashboard dropdown.
app.post("/api/batch-limit", (req, res) => {
  const v = Number(req.body && req.body.value);
  if (Number.isNaN(v) || v < 0) return res.status(400).json({ error: "Invalid batch limit." });
  engine.maxSendsPerRun = Math.floor(v);
  res.json({ ok: true, maxSendsPerRun: engine.maxSendsPerRun });
});

// --- Upload -----------------------------------------------------------------
// Pull ALL contacts straight from REI (no spreadsheet). Enumerates contact
// URLs, builds a job, and attaches it. Runs in the background; progress via SSE.
app.post("/api/pull-rei", (req, res) => {
  if (engine.isBusy()) return res.status(409).json({ error: "Automation is running. Stop it first." });
  res.json({ ok: true });
  (async () => {
    try {
      const max = Number(process.env.REI_PULL_MAX || 10000);
      const urls = await engine.enumerateReiContacts(max);
      if (!urls.length) {
        broadcast("state", { message: "No REI contacts could be pulled. Check the login/contacts page and try again." });
        return;
      }
      const jobId = `reipull-${new Date().toISOString().replace(/[:.]/g, "-")}`;
      const rows = urls.map((u, i) => ({
        rowNumber: i + 1,
        original: { "REI Contact Link": u },
        ownerName: "",
        propertyAddress: "",
        city: "",
        state: "",
        zip: "",
        phone: "",
        email: "",
        reiContactUrl: u,
        fromRei: true,
      }));
      const parsed = {
        rows,
        originalHeaders: ["REI Contact Link", "Owner Name", "Property Address", "City", "State", "ZIP", "Phone"],
        dispositionHeader: "Disposition",
        notesHeader: "Notes",
      };
      // Pre-fill leads already worked this month so they show in the dashboard
      // with their results and are skipped (not re-checked). Only new ones run.
      const filled = engine.applyMonthlyMemory(parsed.rows);
      store = JobStore.create(jobId, parsed, `REI Contacts (${urls.length})`);
      logger = new JobLogger(jobId);
      engine.attach(store, logger);
      broadcast("summary", store.summary());
      const fresh = urls.length - filled;
      broadcast("state", {
        message: filled
          ? `Pulled ${urls.length} REI contacts — ${filled} already worked this month (shown, will be skipped), ${fresh} new to work. Set Live Sending, then click Start.`
          : `Pulled ${urls.length} REI contacts. Review, set Live Sending, then click Start.`,
      });
    } catch (err) {
      broadcast("state", { message: `Pull from REI failed: ${err.message}` });
    }
  })();
});

app.post("/api/upload", upload.single("file"), (req, res) => {
  try {
    if (engine.isBusy()) {
      return res.status(409).json({ error: "Automation is running. Stop it before uploading a new file." });
    }
    if (!req.file) return res.status(400).json({ error: "No file uploaded." });
    const parsed = parseSpreadsheet(req.file.buffer);
    const jobId = `job-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    // Pre-fill leads already worked this month (matched by phone) so they show
    // with their results and are skipped, not re-checked.
    engine.applyMonthlyMemory(parsed.rows);
    store = JobStore.create(jobId, parsed, req.file.originalname);
    logger = new JobLogger(jobId);
    engine.attach(store, logger);
    broadcast("summary", store.summary());
    res.json({ ok: true, jobId, snapshot: store.snapshot() });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- Controls ---------------------------------------------------------------
app.post("/api/start", async (req, res) => {
  try {
    res.json(await engine.start());
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
app.post("/api/pause", (req, res) => res.json(engine.pause()));
app.post("/api/resume", async (req, res) => {
  try {
    res.json(await engine.resume());
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
app.post("/api/stop", async (req, res) => res.json(await engine.stop()));

// --- State / logs -----------------------------------------------------------
app.get("/api/state", (req, res) => {
  if (!store) return res.json({ job: null });
  res.json({ job: store.snapshot(), engineStatus: engine.status, busy: engine.isBusy() });
});

app.get("/api/logs", (req, res) => {
  if (!logger) return res.json({ logs: [] });
  const limit = Number(req.query.limit || 200);
  res.json({ logs: logger.getRecent(limit) });
});

// --- Export -----------------------------------------------------------------
app.get("/api/export", (req, res) => {
  if (!store) return res.status(400).json({ error: "No job to export." });
  const format = (req.query.format || "xlsx").toLowerCase();
  const base = (store.job.sourceFileName || "leads").replace(/\.[^.]+$/, "");
  if (format === "csv") {
    const csv = exportToCsv(store.job);
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="${base}-updated.csv"`);
    return res.send(csv);
  }
  const buffer = exportToXlsx(store.job);
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${base}-updated.xlsx"`);
  res.send(buffer);
});

// List this computer's local-network IPv4 addresses, so colleagues on the same
// office WiFi can open the dashboard using one of these instead of "localhost".
function lanAddresses() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const net of ifaces[name] || []) {
      if (net.family === "IPv4" && !net.internal) out.push(net.address);
    }
  }
  return out;
}

const PORT = Number(process.env.PORT || 3000);
// Bind to 0.0.0.0 so other computers on the same network can reach it.
app.listen(PORT, "0.0.0.0", () => {
  console.log(`\nTwin Text Platform running.`);
  console.log(`  On THIS computer:      http://localhost:${PORT}`);
  const lan = lanAddresses();
  if (lan.length) {
    console.log(`  Share with colleagues on the same office WiFi:`);
    lan.forEach((ip) => console.log(`                         http://${ip}:${PORT}`));
    console.log(`  (Keep this window open. First time, click "Allow" if Windows asks about the network.)`);
  }
  console.log(`Live send: ${engine.allowLiveSend ? "ENABLED" : "DISABLED (ALLOW_LIVE_SEND is not true)"}`);
  const bd = BUILD_INFO.commitDate || BUILD_INFO.builtAt || "";
  console.log(`Version: ${BUILD_INFO.commit}${bd ? " · " + bd.slice(0, 10) : ""}`);
});
