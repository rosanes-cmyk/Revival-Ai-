// Job state persistence (resume support).
//
// A "job" is one uploaded spreadsheet plus the processing state of every row.
// State is written after each row so a stop/crash/restart resumes without
// re-texting anyone (processed rows are skipped).

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { DISPOSITION, ELIGIBILITY, MATCH_STATUS, TERMINAL_DISPOSITIONS } from "../automation/constants.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// State lives in the writable data dir (install dir is read-only in Program Files).
const STATE_DIR = process.env.REVIVAL_DATA_DIR
  ? path.join(process.env.REVIVAL_DATA_DIR, "state")
  : path.join(__dirname, "..", "..", "data", "state");
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

  static create(jobId, parsed, sourceFileName) {
    const job = {
      jobId,
      sourceFileName,
      createdAt: new Date().toISOString(),
      status: JOB_STATUS.IDLE,
      cursor: 0,
      originalHeaders: parsed.originalHeaders || [],
      dispositionHeader: parsed.dispositionHeader || "Disposition",
      notesHeader: parsed.notesHeader || "Notes",
      rows: parsed.rows.map(normalizeRow),
    };
    const store = new JobStore(job);
    store.persist();
    store.setCurrent();
    return store;
  }

  static load(jobId) {
    const file = JobStore.file(jobId);
    if (!fs.existsSync(file)) return null;
    return new JobStore(JSON.parse(fs.readFileSync(file, "utf8")));
  }

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

  isProcessed(row) {
    return TERMINAL_DISPOSITIONS.includes(row.disposition);
  }

  /** Summary counts for the dashboard cards and final summary. */
  summary() {
    return summarizeRows(this.job.rows);
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

/** Disposition counts for any set of rows (used by the dashboard + report). */
export function summarizeRows(rows) {
  const count = (d) => rows.filter((r) => r.disposition === d).length;
  return {
    total: rows.length,
    pending: rows.filter((r) => r.disposition === DISPOSITION.PENDING || r.disposition === DISPOSITION.READY_TO_TEXT).length,
    textSent: count(DISPOSITION.TEXT_SENT),
    leadNotFound: count(DISPOSITION.LEAD_NOT_FOUND),
    propertySold: count(DISPOSITION.PROPERTY_SOLD),
    listed: count(DISPOSITION.LISTED),
    optedOut: count(DISPOSITION.OPTED_OUT),
    notInterested: count(DISPOSITION.NOT_INTERESTED),
    wrongNumber: count(DISPOSITION.WRONG_NUMBER),
    failedNumber: count(DISPOSITION.FAILED_NUMBER),
    alreadyContacted: count(DISPOSITION.ALREADY_CONTACTED),
    badLead: count(DISPOSITION.BAD_LEAD),
    outOfState: count(DISPOSITION.OUT_OF_STATE),
    textedThisMonth: count(DISPOSITION.TEXTED_THIS_MONTH),
    needsReview: count(DISPOSITION.NEEDS_REVIEW),
    errors: count(DISPOSITION.ERROR),
  };
}

function normalizeRow(r) {
  return {
    rowNumber: r.rowNumber,
    original: r.original || {},
    ownerName: r.ownerName,
    propertyAddress: r.propertyAddress,
    street: r.street || "",
    city: r.city,
    state: r.state,
    zip: r.zip,
    companySource: r.companySource || "",
    phone: r.phone || "",
    email: r.email || "",
    disposition: r.disposition || DISPOSITION.PENDING,
    notes: r.notes || "",
    reiMatchStatus: r.reiMatchStatus || MATCH_STATUS.UNSEARCHED,
    reiContactUrl: r.reiContactUrl || "",
    fromRei: !!r.fromRei,
    searchMethod: r.searchMethod || "",
    propertyStatus: r.propertyStatus || "",
    propertyStatusUrl: r.propertyStatusUrl || "",
    safetyStatus: r.safetyStatus || "",
    eligibilityStatus: r.eligibilityStatus || ELIGIBILITY.PENDING,
    reiTagApplied: r.reiTagApplied || "",
    textSentTimestamp: r.textSentTimestamp || "",
    processedAt: r.processedAt || "",
    fromMemory: !!r.fromMemory,
    errorLog: r.errorLog || "",
  };
}
