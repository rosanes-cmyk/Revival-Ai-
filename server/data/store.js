// Job state persistence (SOP step 8: resume support).
//
// A "job" is one uploaded spreadsheet plus the processing state of every row.
// State is written to disk after each row so that a stop/crash/restart can be
// resumed without re-texting anyone (processed rows are skipped).

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { DISPOSITION, ELIGIBILITY, MATCH_STATUS, TERMINAL_DISPOSITIONS } from "../automation/constants.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = path.join(__dirname, "..", "..", "data", "state");
fs.mkdirSync(STATE_DIR, { recursive: true });

const CURRENT_POINTER = path.join(STATE_DIR, "current.json");

export const JOB_STATUS = Object.freeze({
  IDLE: "idle",
  RUNNING: "running",
  PAUSED: "paused",
  STOPPED: "stopped",
  COMPLETED: "completed",
});

export class JobStore {
  constructor(job) {
    this.job = job;
  }

  static file(jobId) {
    return path.join(STATE_DIR, `${jobId}.json`);
  }

  /** Create a fresh job from parsed rows. */
  static create(jobId, rows, sourceFileName) {
    const job = {
      jobId,
      sourceFileName,
      createdAt: new Date().toISOString(),
      status: JOB_STATUS.IDLE,
      cursor: 0, // index of the next row to process
      rows: rows.map(normalizeRow),
    };
    const store = new JobStore(job);
    store.persist();
    store.setCurrent();
    return store;
  }

  /** Load a job by id from disk. */
  static load(jobId) {
    const file = JobStore.file(jobId);
    if (!fs.existsSync(file)) return null;
    const job = JSON.parse(fs.readFileSync(file, "utf8"));
    return new JobStore(job);
  }

  /** Load the most recently active job, if any (for resume after restart). */
  static loadCurrent() {
    if (!fs.existsSync(CURRENT_POINTER)) return null;
    try {
      const { jobId } = JSON.parse(fs.readFileSync(CURRENT_POINTER, "utf8"));
      return JobStore.load(jobId);
    } catch {
      return null;
    }
  }

  setCurrent() {
    fs.writeFileSync(CURRENT_POINTER, JSON.stringify({ jobId: this.job.jobId }));
  }

  persist() {
    fs.writeFileSync(JobStore.file(this.job.jobId), JSON.stringify(this.job, null, 2));
  }

  setStatus(status) {
    this.job.status = status;
    this.persist();
  }

  get rows() {
    return this.job.rows;
  }

  /** Rows that are already finished and must be skipped (SOP step A / 8). */
  isProcessed(row) {
    return TERMINAL_DISPOSITIONS.includes(row.disposition);
  }

  /** Summary counts for the dashboard cards (SOP step 2). */
  summary() {
    const rows = this.job.rows;
    const count = (d) => rows.filter((r) => r.disposition === d).length;
    return {
      total: rows.length,
      pending: count(DISPOSITION.PENDING),
      textSent: count(DISPOSITION.TEXT_SENT),
      leadNotFound: count(DISPOSITION.LEAD_NOT_FOUND),
      propertySold: count(DISPOSITION.PROPERTY_SOLD),
      listed: count(DISPOSITION.LISTED),
      optedOut: count(DISPOSITION.OPTED_OUT),
      needsReview: count(DISPOSITION.NEEDS_REVIEW),
      errors: count(DISPOSITION.ERROR),
    };
  }

  snapshot() {
    return {
      jobId: this.job.jobId,
      sourceFileName: this.job.sourceFileName,
      status: this.job.status,
      cursor: this.job.cursor,
      createdAt: this.job.createdAt,
      summary: this.summary(),
      rows: this.job.rows,
    };
  }
}

function normalizeRow(r) {
  return {
    rowNumber: r.rowNumber,
    ownerName: r.ownerName,
    propertyAddress: r.propertyAddress,
    city: r.city,
    state: r.state,
    zip: r.zip,
    disposition: r.disposition || DISPOSITION.PENDING,
    notes: r.notes || "",
    reiMatchStatus: r.reiMatchStatus || MATCH_STATUS.UNSEARCHED,
    lastContactDate: r.lastContactDate || "",
    optOutStatus: r.optOutStatus || "",
    propertyStatus: r.propertyStatus || "",
    eligibilityStatus: r.eligibilityStatus || ELIGIBILITY.PENDING,
    searchMethod: r.searchMethod || "",
    textSentTimestamp: r.textSentTimestamp || "",
    errorLog: r.errorLog || "",
  };
}
