// Job state persistence (resume support).
//
// A "job" is one uploaded spreadsheet plus the processing state of every row.
// State is written after each row so a stop/crash/restart resumes without
// re-texting anyone (processed rows are skipped).

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { DISPOSITION, ELIGIBILITY, MATCH_STATUS, TERMINAL_DISPOSITIONS } from "../automation/constants.js";
import { cleanPersonName } from "../automation/message.js";
import { classifyReply } from "../automation/sop.js";

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
    const job = JSON.parse(fs.readFileSync(file, "utf8"));
    // Normalize rows on load too, so an OLD job file (saved before the new
    // verification/reply fields existed) gets those fields defaulted in — every
    // downstream read can rely on them being present.
    if (Array.isArray(job.rows)) job.rows = job.rows.map(normalizeRow);
    return new JobStore(job);
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

  // Forget the current job so the dashboard starts empty (does NOT touch the
  // monthly "texted this month" memory, so duplicate protection stays intact).
  static clearCurrent() {
    try { fs.unlinkSync(CURRENT_POINTER); } catch { /* already gone */ }
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
    recentContact: count(DISPOSITION.RECENT_CONTACT),
    needsReview: count(DISPOSITION.NEEDS_REVIEW),
    errors: count(DISPOSITION.ERROR),
  };
}

export function normalizeRow(r) {
  // AUTO-CORRECT a stale "Unknown" delivery status. If we have the exact text
  // we sent AND the timestamp of the send (both are only recorded on a CONFIRMED
  // send), then the text WAS sent — a later "Unknown / could not locate" is just
  // a slow re-read, not a real problem. Promote it to "Sent" so nobody has to
  // keep clicking Re-verify to clear it. A real Failed/Undelivered is left as-is.
  let deliveryStatus = r.messageDeliveryStatus || "";
  const wasConfirmedSent = !!(r.sentMessageBody && r.textSentTimestamp);
  if (wasConfirmedSent && (deliveryStatus === "" || deliveryStatus === "Unknown" || deliveryStatus === "Needs Recheck")) {
    deliveryStatus = "Sent";
  }
  // RE-CLASSIFY a stored reply against the CURRENT rules on load, so a reply
  // saved under older logic (e.g. Keri saved as "needs review" before the
  // conditional-seller rule existed) self-corrects to "interested" without
  // needing a manual Re-verify. Only recomputes when we actually have the words.
  let replyClassification = r.replyClassification || "";
  let replyClassificationReason = r.replyClassificationReason || "";
  let activeDeal = !!r.activeDeal;
  let needsManualReview = !!r.needsManualReview;
  let disposition = r.disposition || DISPOSITION.PENDING;
  if (r.replyReceived && r.replyText) {
    const cls = classifyReply(r.replyText);
    replyClassification = cls.classification;
    replyClassificationReason = cls.reason;
    // Keep the tab in sync with the (re)classification so a stale flag can't
    // strand a lead in the wrong tab after the rules improve.
    if (cls.classification === "interested") { activeDeal = true; needsManualReview = false; }
    else if (cls.classification === "not_interested") {
      needsManualReview = false;
      activeDeal = false;
      // Move a reply that is now a clear No / bounce OUT of Text Sent / Active
      // Deal into its result tab. Leave dispositions that already sit in the
      // right negative tab (opted out, wrong number, sold, out of state, bad).
      const KEEP = new Set([
        DISPOSITION.OPTED_OUT, DISPOSITION.WRONG_NUMBER, DISPOSITION.PROPERTY_SOLD,
        DISPOSITION.LISTED, DISPOSITION.OUT_OF_STATE, DISPOSITION.BAD_LEAD,
        DISPOSITION.FAILED_NUMBER, DISPOSITION.LEAD_NOT_FOUND,
      ]);
      if (cls.undeliverable) disposition = DISPOSITION.FAILED_NUMBER;
      else if (!KEEP.has(disposition)) disposition = DISPOSITION.NOT_INTERESTED;
    }
    else { needsManualReview = true; } // genuinely unclear
  }
  return {
    rowNumber: r.rowNumber,
    original: r.original || {},
    // Strip REI's initials-avatar monogram from scraped names (e.g.
    // "DGDuane Garrido" -> "Duane Garrido"). Safe for normal names.
    ownerName: cleanPersonName(r.ownerName),
    propertyAddress: r.propertyAddress,
    street: r.street || "",
    city: r.city,
    state: r.state,
    zip: r.zip,
    companySource: r.companySource || "",
    phone: r.phone || "",
    email: r.email || "",
    disposition: disposition,
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

    // --- Verification / reply fields (added for Recheck Text Sent). Old job
    // files without these load fine — every field defaults here. ---------------
    sentMessageBody: r.sentMessageBody || "",             // exact text sent
    messageDeliveryStatus: deliveryStatus, // Sent|Delivered|Failed|Undelivered|Unknown|Needs Recheck (auto-promoted above)
    deliveryStatusEvidence: r.deliveryStatusEvidence || "",
    messageStatusLastCheckedAt: r.messageStatusLastCheckedAt || "",
    messageStatusCheckAttempts: Number(r.messageStatusCheckAttempts || 0),
    replyReceived: !!r.replyReceived,
    replyText: r.replyText || "",
    replyReceivedAt: r.replyReceivedAt || "",
    replyClassification: replyClassification,     // re-classified above against current rules
    replyClassificationReason: replyClassificationReason,
    needsManualReview: needsManualReview,
    activeDeal: activeDeal,
    activeDealReason: r.activeDealReason || "",
    recheckCompleted: !!r.recheckCompleted,
    recheckError: r.recheckError || "",
  };
}

// -------- Tab categorization (non-destructive; computed from saved fields) ----
// Every lead ALWAYS appears in "all". Outside "all", each lead lands in exactly
// ONE result tab, chosen by precedence below from its latest disposition / reply
// / review flags. Nothing here mutates the row.
export const TAB = Object.freeze({
  ALL: "all",
  AVAILABLE: "available-to-text",
  TEXT_SENT: "text-sent",
  PROPERTY_SOLD: "property-sold",
  NOT_INTERESTED: "not-interested",
  BAD_LEADS: "bad-leads",
  OUT_OF_STATE: "out-of-state",
  ACTIVE_DEAL: "active-deal",
  ALREADY_TEXTED: "already-texted",
  NEEDS_REVIEW: "needs-review",
});

// Clean, download-friendly filename stem per tab.
export const TAB_FILE = Object.freeze({
  [TAB.ALL]: "all-leads",
  [TAB.AVAILABLE]: "available-to-text",
  [TAB.TEXT_SENT]: "text-sent",
  [TAB.PROPERTY_SOLD]: "property-sold",
  [TAB.NOT_INTERESTED]: "not-interested-to-delete",
  [TAB.BAD_LEADS]: "bad-leads",
  [TAB.OUT_OF_STATE]: "out-of-state",
  [TAB.ACTIVE_DEAL]: "active-deals",
  [TAB.ALREADY_TEXTED]: "already-texted",
  [TAB.NEEDS_REVIEW]: "needs-review",
});

/** The single result tab a row belongs to (besides "all"), or null. */
export function categorizeRow(row) {
  const d = row.disposition;
  // 1) Needs Review — unclear reply, uncertain match, or a TECHNICAL error
  //    (temporary browser/login/selector issues are NOT bad leads).
  if (row.needsManualReview || d === DISPOSITION.NEEDS_REVIEW || d === DISPOSITION.ERROR) {
    return TAB.NEEDS_REVIEW;
  }
  // 2) Active Deal — reply shows interest, or an active-deal REI tag/stage.
  if (row.activeDeal || d === DISPOSITION.RECENT_CONTACT) return TAB.ACTIVE_DEAL;
  // 3) Text Sent — the app completed a send.
  if (d === DISPOSITION.TEXT_SENT) return TAB.TEXT_SENT;
  // 4) Available to Text — passed EVERY eligibility rule and not texted in the
  //    last 30 days, but not yet sent (eligibility scan, or live-send was off).
  if (d === DISPOSITION.READY_TO_TEXT) return TAB.AVAILABLE;
  // 4) Not Interested / To Delete — negative replies, opt-outs, wrong number.
  if (d === DISPOSITION.NOT_INTERESTED || d === DISPOSITION.OPTED_OUT || d === DISPOSITION.WRONG_NUMBER) {
    return TAB.NOT_INTERESTED;
  }
  // 5) Property Sold / Listed.
  if (d === DISPOSITION.PROPERTY_SOLD || d === DISPOSITION.LISTED) return TAB.PROPERTY_SOLD;
  // 6) Out of State.
  if (d === DISPOSITION.OUT_OF_STATE) return TAB.OUT_OF_STATE;
  // 7) Bad Leads — junk / unusable contact or a real send failure.
  if (d === DISPOSITION.BAD_LEAD || d === DISPOSITION.FAILED_NUMBER || d === DISPOSITION.LEAD_NOT_FOUND) {
    return TAB.BAD_LEADS;
  }
  // 8) Already texted (this month / previously) — skipped to avoid a repeat, so
  //    every worked lead lands in a tab and the counts add up to the total.
  if (d === DISPOSITION.TEXTED_THIS_MONTH || d === DISPOSITION.ALREADY_CONTACTED) {
    return TAB.ALREADY_TEXTED;
  }
  // Pending / Ready → only in "all".
  return null;
}

/** True if we actually texted this lead (regardless of any later reply). */
export function wasTexted(row) {
  return !!(row.textSentTimestamp || row.sentMessageBody || row.disposition === DISPOSITION.TEXT_SENT);
}

/** Rows belonging to a given tab ("all" returns everything). */
export function rowsForTab(rows, tab) {
  if (!tab || tab === TAB.ALL) return rows.slice();
  // Text Sent shows EVERY lead we texted — even ones who later replied and also
  // appear in a result tab — so the tab count matches the "Texts Sent" total and
  // there's no "6 sent but tab shows 1" confusion.
  if (tab === TAB.TEXT_SENT) return rows.filter(wasTexted);
  return rows.filter((r) => categorizeRow(r) === tab);
}

/** Count of rows per tab (for tab badges). */
export function tabCounts(rows) {
  const counts = { [TAB.ALL]: rows.length };
  for (const key of Object.values(TAB)) if (key !== TAB.ALL) counts[key] = 0;
  for (const r of rows) {
    const t = categorizeRow(r);
    if (t) counts[t] += 1;
  }
  // Text Sent counts ALL texted leads (overlaps with the result tabs on purpose),
  // so its badge equals the true number of texts sent.
  counts[TAB.TEXT_SENT] = rows.filter(wasTexted).length;
  return counts;
}
