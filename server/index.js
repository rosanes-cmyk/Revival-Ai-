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

// --- Config surface ---------------------------------------------------------
app.get("/api/config", (req, res) => {
  res.json({
    approvedMessages: APPROVED_MESSAGES,
    allowLiveSend: engine.allowLiveSend,
  });
});

// --- Upload -----------------------------------------------------------------
app.post("/api/upload", upload.single("file"), (req, res) => {
  try {
    if (engine.isBusy()) {
      return res.status(409).json({ error: "Automation is running. Stop it before uploading a new file." });
    }
    if (!req.file) return res.status(400).json({ error: "No file uploaded." });
    const { rows } = parseSpreadsheet(req.file.buffer);
    const jobId = `job-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    store = JobStore.create(jobId, rows, req.file.originalname);
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
    const csv = exportToCsv(store.rows);
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="${base}-updated.csv"`);
    return res.send(csv);
  }
  const buffer = exportToXlsx(store.rows);
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${base}-updated.xlsx"`);
  res.send(buffer);
});

const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => {
  console.log(`\nHigh Equity Lead Revival Dashboard running: http://localhost:${PORT}`);
  console.log(`Live send: ${engine.allowLiveSend ? "ENABLED" : "DISABLED (ALLOW_LIVE_SEND is not true)"}`);
});
