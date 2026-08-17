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
import { parseSpreadsheet, exportToXlsx, exportToCsv, rowsToXlsxBuffer, rowsToCsv } from "./data/spreadsheet.js";
import { computePercentageReport, reportTableRowsSimple } from "./reports/percentage.js";
import { getConfiguredSharedDir, setConfiguredSharedDir } from "./data/sentLedger.js";
import { JobStore, summarizeRows, rowsForTab, tabCounts, TAB, TAB_FILE } from "./data/store.js";
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
engine.on("recheck", (d) => broadcast("recheck", d));
engine.on("selftest", (d) => broadcast("selftest", d));
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
    // Fallback 1: the exact executable Playwright expects.
    let exe;
    try { exe = chromium.executablePath(); } catch { exe = undefined; }
    if (exe && fs.existsSync(exe)) {
      return await chromium.launch({ headless: true, executablePath: exe });
    }
    // Fallback 2: scan the browsers dir for ANY installed chromium/chrome (in
    // case the pinned version drifted). Keeps PDF export working after updates.
    const found = findAnyChromium();
    if (found) return await chromium.launch({ headless: true, executablePath: found });
    throw e1;
  }
}

// Best-effort search for an installed Chromium/Chrome binary under the common
// Playwright browsers locations. Returns a path or "".
function findAnyChromium() {
  const roots = [];
  if (process.env.PLAYWRIGHT_BROWSERS_PATH && process.env.PLAYWRIGHT_BROWSERS_PATH !== "0") roots.push(process.env.PLAYWRIGHT_BROWSERS_PATH);
  roots.push(path.join(__dirname, "..", "node_modules", "playwright-core", ".local-browsers"));
  roots.push("/opt/pw-browsers");
  const names = ["chrome", "chrome.exe", "headless_shell", "chrome-headless-shell", "chrome-headless-shell.exe"];
  const walk = (dir, depth) => {
    if (depth < 0) return "";
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return ""; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isFile() && names.includes(e.name)) return p;
      if (e.isDirectory()) { const r = walk(p, depth - 1); if (r) return r; }
    }
    return "";
  };
  for (const root of roots) { const r = walk(root, 3); if (r) return r; }
  return "";
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
    ["Recent Contact (active deal)", s.recentContact, "#8b5cf6"],
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

// --- Percentage Report ------------------------------------------------------
// Filters via query: company, state, deliveryStatus, replyClassification,
// leadSource, sentDate (YYYY-MM-DD), recheckDate (YYYY-MM-DD).
function currentPercentageReport(query = {}) {
  const rows = store && Array.isArray(store.job.rows) ? store.job.rows : [];
  return computePercentageReport(rows, {
    company: query.company, state: query.state,
    deliveryStatus: query.deliveryStatus, replyClassification: query.replyClassification,
    leadSource: query.leadSource, sentDate: query.sentDate, recheckDate: query.recheckDate,
  });
}

app.get("/api/percentage", (req, res) => {
  res.json({
    report: currentPercentageReport(req.query),
    jobId: store ? store.job.jobId : null,
    jobName: store ? store.job.sourceFileName : null,
  });
});

function percentageMetaRows(rep, jobName) {
  const day = new Date();
  return [
    { Metric: "Report generated", Total: day.toLocaleString(), Percentage: "", "Percentage Based On": "" },
    { Metric: "Job", Total: jobName || "—", Percentage: "", "Percentage Based On": "" },
    { Metric: "Recheck completion", Total: `${rep.recheck.recheckedCount}/${rep.totals.totalTextsSent}`, Percentage: rep.recheck.recheckCompletePct.toFixed(2) + "%", "Percentage Based On": "Texts Sent" },
    { Metric: "", Total: "", Percentage: "", "Percentage Based On": "" },
  ];
}

app.get("/api/percentage.xlsx", (req, res) => {
  const rep = currentPercentageReport(req.query);
  const jobName = store ? store.job.sourceFileName : "";
  const records = [...percentageMetaRows(rep, jobName), ...reportTableRowsSimple(rep)];
  const buf = rowsToXlsxBuffer(records, "Percentage Report", ["Metric", "Total", "Percentage", "Percentage Based On"]);
  const day = new Date().toISOString().slice(0, 10);
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="revival-percentage-report-${day}.xlsx"`);
  res.send(buf);
});
app.get("/api/percentage.csv", (req, res) => {
  const rep = currentPercentageReport(req.query);
  const jobName = store ? store.job.sourceFileName : "";
  const records = [...percentageMetaRows(rep, jobName), ...reportTableRowsSimple(rep)];
  const csv = rowsToCsv(records, ["Metric", "Total", "Percentage", "Percentage Based On"]);
  const day = new Date().toISOString().slice(0, 10);
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="revival-percentage-report-${day}.csv"`);
  res.send(csv);
});
app.get("/api/percentage.pdf", async (req, res) => {
  const rep = currentPercentageReport(req.query);
  const jobName = store ? store.job.sourceFileName : "";
  const html = buildPercentageHtml(rep, jobName);
  let browser = null;
  try {
    browser = await launchPdfBrowser();
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "load" });
    const pdf = await page.pdf({ format: "Letter", printBackground: true, margin: { top: "0.4in", bottom: "0.4in", left: "0.4in", right: "0.4in" } });
    const day = new Date().toISOString().slice(0, 10);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="revival-percentage-report-${day}.pdf"`);
    res.send(pdf);
  } catch (err) {
    res.status(500).json({ error: "Could not generate PDF: " + err.message });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
});

function buildPercentageHtml(rep, jobName) {
  const rows = reportTableRowsSimple(rep)
    .map((r) => `<tr><td>${String(r.Metric).replace(/[<>&]/g, "")}</td><td class="num">${Number(r.Total || 0).toLocaleString()}</td><td class="num">${r.Percentage || ""}</td><td>${r["Percentage Based On"] || ""}</td></tr>`)
    .join("");
  const now = new Date().toLocaleString();
  return `<!doctype html><html><head><meta charset="utf-8"/><title>Revival Percentage Report</title>
<style>
 body{margin:0;background:#f1f5f9;color:#0f172a;font-family:'Segoe UI',system-ui,Arial,sans-serif;}
 .page{max-width:900px;margin:24px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 10px 40px rgba(2,6,23,.10);}
 .head{padding:26px 32px;background:linear-gradient(135deg,#0b0b0d,#14532d);color:#fff;}
 .head h1{margin:0;font-size:22px;} .head p{margin:6px 0 0;opacity:.85;font-size:13px;}
 .meta{padding:12px 32px;background:#f8fafc;border-bottom:1px solid #e2e8f0;font-size:13px;color:#475569;}
 table{width:100%;border-collapse:collapse;font-size:13px;} th,td{padding:9px 32px;text-align:left;border-bottom:1px solid #eef2f7;}
 th{background:#f8fafc;color:#334155;font-size:11px;text-transform:uppercase;letter-spacing:.4px;}
 td.num,th.num{text-align:right;font-variant-numeric:tabular-nums;} tbody tr:nth-child(even){background:#fbfdff;}
 .foot{padding:14px 32px 24px;color:#94a3b8;font-size:11px;}
</style></head><body><div class="page">
 <div class="head"><h1>Twin Text Revival — Percentage Report</h1><p>Every percentage shows its supporting count and denominator.</p></div>
 <div class="meta">Generated: <b>${now}</b> &nbsp;·&nbsp; Job: <b>${String(jobName || "—").replace(/[<>&]/g, "")}</b> &nbsp;·&nbsp; Recheck: <b>${rep.recheck.recheckedCount}/${rep.totals.totalTextsSent}</b> (${rep.recheck.recheckCompletePct.toFixed(2)}%)</div>
 <table><thead><tr><th>Metric</th><th class="num">Total</th><th class="num">Percentage</th><th>Percentage Based On</th></tr></thead><tbody>${rows}</tbody></table>
 <div class="foot">Twin Text Platform · Revival AI</div>
</div></body></html>`;
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

// Recheck Text Sent — manual, read-only. Verifies each sent message and checks
// for seller replies. Never sends. Runs in the background; progress via SSE.
app.post("/api/recheck", (req, res) => {
  if (engine.isBusy()) return res.status(409).json({ error: "Automation is running. Stop it first, then Recheck." });
  if (!store) return res.status(400).json({ error: "Upload or pull leads first." });
  const tab = req.body && req.body.tab ? String(req.body.tab) : "";
  engine.recheckTextSent({ tab }).catch((err) => broadcast("state", { message: `Recheck error: ${err.message}` }));
  res.json({ ok: true });
});
app.post("/api/recheck/stop", (req, res) => {
  engine.requestStopRecheck();
  res.json({ ok: true });
});

// Connection self-test — read-only. Opens REI and verifies login + that it can
// open a contact and read tags/chat + see the reply box & Send button. Never
// sends. Runs in the background; results stream over the "selftest" SSE event.
app.post("/api/self-test", (req, res) => {
  if (engine.isBusy()) return res.status(409).json({ error: "Automation is running. Stop it first." });
  engine.selfTest().catch((err) => broadcast("state", { message: `Connection test error: ${err.message}` }));
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
// Clear the dashboard — forget the current job so it starts empty. Keeps the
// monthly "texted this month" memory so duplicate protection stays intact.
app.post("/api/reset", (req, res) => {
  if (engine.isBusy()) return res.status(409).json({ error: "Automation is running. Stop it first." });
  store = null;
  logger = null;
  JobStore.clearCurrent();
  broadcast("summary", null);
  broadcast("state", { status: "idle", cursor: 0, total: 0, message: "Dashboard cleared. Upload a file or pull from REI to begin." });
  res.json({ ok: true });
});

app.post("/api/pull-rei", (req, res) => {
  if (engine.isBusy()) return res.status(409).json({ error: "Automation is running. Stop it first." });
  res.json({ ok: true });
  (async () => {
    try {
      // Clean the dashboard first so the pull starts from a fresh slate (old
      // rows/counts cleared). The monthly "already texted" memory is kept.
      store = null;
      logger = null;
      JobStore.clearCurrent();
      broadcast("summary", null);
      broadcast("state", { status: "idle", cursor: 0, total: 0, message: "Cleared. Collecting ALL contacts from REI (oldest first)…" });

      const max = Number(process.env.REI_PULL_MAX || 10000);
      const { urls, info, account } = await engine.enumerateReiContacts(max);
      if (!urls.length) {
        broadcast("state", { message: "No REI contacts could be pulled. Check the login/contacts page and try again." });
        return;
      }
      const jobId = `reipull-${new Date().toISOString().replace(/[:.]/g, "-")}`;
      const rows = urls.map((u, i) => {
        const meta = (info && info.get && info.get(u)) || {};
        // Split "123 St, City, ST 12345" into parts if the list gave us one.
        let street = "", city = "", state = "", zip = "";
        if (meta.address) {
          const parts = meta.address.split(",").map((s) => s.trim());
          const stZip = (parts[2] || "").match(/([A-Z]{2})\s*(\d{5})/);
          street = parts[0] || "";
          city = parts[1] || "";
          state = stZip ? stZip[1] : "";
          zip = stZip ? stZip[2] : "";
        }
        return {
          rowNumber: i + 1,
          original: {
            "REI Contact Link": u,
            "Owner Name": meta.name || "",
            "Property Address": meta.address || "",
            Phone: meta.phone || "",
          },
          ownerName: meta.name || "",
          propertyAddress: meta.address || "",
          street,
          city,
          state,
          zip,
          phone: meta.phone || "",
          email: "",
          reiContactUrl: u,
          fromRei: true,
        };
      });
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
      const acct = account ? ` · REI account: ${account}` : "";
      const willText = engine.allowLiveSend;
      broadcast("state", {
        message:
          `Pulled ${urls.length} REI contacts${filled ? ` — ${filled} already worked, ${fresh} new` : ""}${acct}. ` +
          (willText
            ? "Live Sending is ON — now checking every lead and TEXTING the eligible ones…"
            : "Now checking every lead's eligibility (no texts sent — Live Sending is OFF)…"),
      });
      // Option B: after a pull, automatically start a run. If Live Sending is ON
      // it texts eligible leads; if OFF it just checks (fills Available to Text).
      // Either way it runs the full safety pipeline per lead. Pause/Stop anytime.
      if (String(process.env.AUTO_CHECK_ON_PULL ?? "true").toLowerCase() !== "false") {
        const kick = willText ? engine.start() : engine.startAvailabilityScan();
        Promise.resolve(kick).catch((err) =>
          broadcast("state", { message: `Auto-run could not start: ${err.message}` })
        );
      }
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
// Build the "Available to Text" list: recheck every loaded lead's eligibility
// WITHOUT sending. Runs the normal pipeline in scan-only mode.
app.post("/api/scan-available", async (req, res) => {
  try {
    if (engine.isBusy()) return res.status(409).json({ error: "Automation is running. Stop it first." });
    if (!store) return res.status(400).json({ error: "Pull from REI (or upload) leads first." });
    res.json(await engine.startAvailabilityScan());
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
// DIAGNOSTIC: show the raw REI chat text + parsed messages for one Text Sent
// lead, so reply detection can be fixed against the real page. Open in a
// browser: /api/debug-chat  (first sent lead)  or  /api/debug-chat?owner=keri
app.get("/api/debug-chat", async (req, res) => {
  try {
    if (!store) return res.status(400).json({ error: "Pull from REI (or upload) leads first." });
    if (engine.isBusy()) return res.status(409).json({ error: "Automation is running. Stop it first." });
    const owner = String(req.query.owner || "").toLowerCase();
    const wantReplied = String(req.query.replied || "") === "1";
    const sent = store.job.rows.filter(
      (r) => (r.textSentTimestamp || r.sentMessageBody || r.disposition === DISPOSITION.TEXT_SENT) && r.reiContactUrl
    );
    let target;
    if (owner) target = sent.find((r) => String(r.ownerName || "").toLowerCase().includes(owner));
    else if (wantReplied) target = sent.find((r) => r.replyReceived) || sent[0]; // prefer a lead that replied
    else target = sent[0];
    if (!target) return res.status(404).json({ error: owner ? `No Text Sent lead matching "${owner}" with a REI link.` : "No Text Sent lead with a REI link found." });
    const dump = await engine.debugReadChat(target.reiContactUrl);
    res.json({
      owner: target.ownerName,
      url: target.reiContactUrl,
      replyDetected: dump.parsed.some((m) => m.dir === "in"),
      parsedMessages: dump.parsed,
      hasSentToLabel: /sent to:/i.test(dump.rawText),
      hasReceivedFromLabel: /received from:/i.test(dump.rawText),
      rawTextSample: (dump.rawText || "").slice(0, 4000),
      error: dump.error || "",
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// Shared "already texted" memory across computers. Point every PC at the SAME
// synced folder (a OneDrive/Dropbox shared folder, or a network drive) and they
// all read/write one sent-record — so no lead is ever texted twice, even when
// two PCs run the same list.
app.get("/api/shared-memory", (req, res) => {
  res.json({ sharedDir: getConfiguredSharedDir() });
});
app.post("/api/shared-memory", (req, res) => {
  try {
    const dir = String((req.body && req.body.sharedDir) || "").trim();
    const result = setConfiguredSharedDir(dir);
    // Rebind the engine's ledger so the change takes effect immediately.
    try { engine.sentLedger = new (engine.sentLedger.constructor)(engine.sentLedger.namespace); } catch { /* best-effort */ }
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: `Could not use that folder: ${err.message}` });
  }
});
app.post("/api/recheck-needs-review", async (req, res) => {
  try {
    if (engine.isBusy()) return res.status(409).json({ error: "Automation is running. Stop it first." });
    if (!store) return res.status(400).json({ error: "Pull from REI (or upload) leads first." });
    res.json(await engine.recheckNeedsReview());
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
// ?format=xlsx|csv  &tab=all|text-sent|property-sold|not-interested|bad-leads|
//   out-of-state|active-deal|needs-review
// Exports ONLY the leads in the selected tab (defaults to all). Filenames are
// clean and date-stamped, e.g. text-sent-2026-08-01.xlsx.
app.get("/api/export", (req, res) => {
  if (!store) return res.status(400).json({ error: "No job to export." });
  const format = (req.query.format || "xlsx").toLowerCase();
  const tab = String(req.query.tab || TAB.ALL).toLowerCase();
  const subsetRows = rowsForTab(store.job.rows, tab);
  // Export a shallow job whose rows are just this tab's rows (headers + summary
  // sheet follow the subset). Nothing on the real job is mutated.
  const subJob = { ...store.job, rows: subsetRows };
  const stem = TAB_FILE[tab] || "all-leads";
  const day = new Date().toISOString().slice(0, 10);
  if (format === "csv") {
    const csv = exportToCsv(subJob);
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="${stem}-${day}.csv"`);
    return res.send(csv);
  }
  const buffer = exportToXlsx(subJob);
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${stem}-${day}.xlsx"`);
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
