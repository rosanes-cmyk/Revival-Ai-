// Express server for the High Equity Lead Revival Dashboard.
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
import { JobStore } from "./data/store.js";
import { JobLogger } from "./logger.js";
import { AutomationEngine } from "./automation/engine.js";
import { assertMessageIntegrity, APPROVED_MESSAGES } from "./automation/message.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
  const s = store ? store.summary() : null;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(buildReportHtml(s, store ? store.job : null));
});

function buildReportHtml(s, job) {
  const n = (v) => Number(v || 0).toLocaleString();
  const now = new Date().toLocaleString();
  const file = (job && job.sourceFileName) || "—";
  s = s || {};
  const soldListed = (s.propertySold || 0) + (s.listed || 0);
  const notIntOut = (s.notInterested || 0) + (s.optedOut || 0);
  const bad = (s.wrongNumber || 0) + (s.failedNumber || 0) + (s.leadNotFound || 0) + (s.badLead || 0);
  const worked = (s.total || 0) - (s.pending || 0);
  const tiles = [
    { label: "Total Leads", value: s.total, accent: "#4f8cff" },
    { label: "Leads Worked", value: worked, accent: "#8b5cf6" },
    { label: "Text Sent", value: s.textSent, accent: "#16a34a", big: true },
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
    ["Bad Lead", s.badLead, "#6b7280"],
    ["Lead NOT Found", s.leadNotFound, "#6b7280"],
    ["Needs Review", s.needsReview, "#eab308"],
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
  return `<!doctype html><html><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Revival AI — Daily Report</title>
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
  table { width:100%; border-collapse:collapse; font-size:14px; }
  td { padding:10px 8px; border-bottom:1px solid #eef2f7; }
  td.num { text-align:right; font-weight:700; font-variant-numeric:tabular-nums; }
  .dot { display:inline-block; width:10px; height:10px; border-radius:50%; margin-right:10px; vertical-align:middle; }
  .foot { padding:16px 32px 26px; color:#94a3b8; font-size:12px; }
  .bar { padding:16px 32px; display:flex; gap:10px; }
  .btn { border:0; border-radius:10px; padding:10px 16px; font-weight:700; cursor:pointer; }
  .btn-print { background:#16a34a; color:#fff; }
  @media print { body { background:#fff; } .page { box-shadow:none; margin:0; } .bar { display:none; } }
  @media (max-width:640px){ .tiles { grid-template-columns:1fr 1fr; } }
</style></head><body>
  <div class="page">
    <div class="head">
      <h1>High Equity Lead Revival — Daily Report</h1>
      <p>Twin Home Buyer &amp; Equity Track Inc. · Text Revival Campaign</p>
    </div>
    <div class="meta">
      <div>Generated: <b>${now}</b></div>
      <div>Lead file: <b>${String(file).replace(/[<>&]/g, "")}</b></div>
    </div>
    <div class="tiles">${tileHtml}</div>
    <div class="section">
      <h2>Full breakdown</h2>
      <table>${rowsHtml || '<tr><td colspan="2">No data yet — upload leads and run.</td></tr>'}</table>
    </div>
    <div class="bar"><button class="btn btn-print" onclick="window.print()">🖨️ Print / Save as PDF</button></div>
    <div class="foot">Revival AI · results are recorded in the dashboard and export. No REI tags are added.</div>
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
    schedule,
  });
});

// --- Daily scheduler --------------------------------------------------------
// Persisted {enabled, time:"HH:MM", lastRun:"YYYY-MM-DD"}. A timer auto-starts
// the next batch once per day at the set time (the app must be running).
const SCHEDULE_FILE = path.join(__dirname, "..", "data", "state", "schedule.json");

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
const LIVE_SEND_FILE = path.join(__dirname, "..", "data", "state", "livesend.json");

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

// Set the per-run text cap from the dashboard dropdown.
app.post("/api/batch-limit", (req, res) => {
  const v = Number(req.body && req.body.value);
  if (Number.isNaN(v) || v < 0) return res.status(400).json({ error: "Invalid batch limit." });
  engine.maxSendsPerRun = Math.floor(v);
  res.json({ ok: true, maxSendsPerRun: engine.maxSendsPerRun });
});

// --- Upload -----------------------------------------------------------------
app.post("/api/upload", upload.single("file"), (req, res) => {
  try {
    if (engine.isBusy()) {
      return res.status(409).json({ error: "Automation is running. Stop it before uploading a new file." });
    }
    if (!req.file) return res.status(400).json({ error: "No file uploaded." });
    const parsed = parseSpreadsheet(req.file.buffer);
    const jobId = `job-${new Date().toISOString().replace(/[:.]/g, "-")}`;
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
  console.log(`\nHigh Equity Lead Revival Dashboard running.`);
  console.log(`  On THIS computer:      http://localhost:${PORT}`);
  const lan = lanAddresses();
  if (lan.length) {
    console.log(`  Share with colleagues on the same office WiFi:`);
    lan.forEach((ip) => console.log(`                         http://${ip}:${PORT}`));
    console.log(`  (Keep this window open. First time, click "Allow" if Windows asks about the network.)`);
  }
  console.log(`Live send: ${engine.allowLiveSend ? "ENABLED" : "DISABLED (ALLOW_LIVE_SEND is not true)"}`);
});
