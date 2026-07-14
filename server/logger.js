// Structured per-row logging (SOP step 7).
//
// Every processed row appends one JSON line to a per-job log file and keeps an
// in-memory ring so the dashboard "View Logs" panel can display recent entries
// without re-reading the whole file.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Logs go to the writable data dir (install dir is read-only in Program Files).
const LOG_DIR = process.env.REVIVAL_DATA_DIR
  ? path.join(process.env.REVIVAL_DATA_DIR, "logs")
  : path.join(__dirname, "..", "data", "logs");

fs.mkdirSync(LOG_DIR, { recursive: true });

export class JobLogger {
  constructor(jobId) {
    this.jobId = jobId;
    this.file = path.join(LOG_DIR, `${jobId}.log.jsonl`);
    this.recent = [];
    this.maxRecent = 500;
  }

  /**
   * Append one structured log record. `entry` should include all SOP step-7
   * fields the caller has: row, searchMethod, matchFound, complianceResult,
   * propertyStatus, lastContactDate, eligibility, textSent, disposition,
   * notes, error.
   */
  log(entry) {
    const record = { ts: new Date().toISOString(), jobId: this.jobId, ...entry };
    this.recent.push(record);
    if (this.recent.length > this.maxRecent) this.recent.shift();
    try {
      fs.appendFileSync(this.file, JSON.stringify(record) + "\n");
    } catch (err) {
      // Logging must never crash the run.
      console.error(`[logger] failed to write log for job ${this.jobId}:`, err.message);
    }
    return record;
  }

  getRecent(limit = 200) {
    return this.recent.slice(-limit);
  }

  readAll() {
    if (!fs.existsSync(this.file)) return [];
    return fs
      .readFileSync(this.file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return { raw: line };
        }
      });
  }
}
