// Automation engine: processes an uploaded job row-by-row, live.
//
// For each pending row: search REI BlackBook, apply the SOP rules, apply the
// correct Revival tag, and — only if the lead is clean and the live-send switch
// is on — send the company-specific approved text immediately, then tag it
// "Revival - Text Sent". State is persisted after every row so Stop/crash can
// be resumed with no duplicate texts. Events drive the live dashboard (SSE) and
// every row is logged.
//
// Control model: Start / Pause / Resume / Stop. Pause halts BETWEEN rows (a row
// in flight always finishes, so a send is never left half-done).

import { EventEmitter } from "events";
import { ReiBlackBookAdapter } from "./reibb.js";
import { decide } from "./sop.js";
import { assertMessageIntegrity } from "./message.js";
import { JOB_STATUS } from "../data/store.js";
import { DISPOSITION, ELIGIBILITY, REVIVAL_TAG } from "./constants.js";

export class AutomationEngine extends EventEmitter {
  constructor() {
    super();
    this.store = null;
    this.logger = null;
    this.adapter = null;
    this._control = "stopped";
    this._loopActive = false;
    this.allowLiveSend = String(process.env.ALLOW_LIVE_SEND).toLowerCase() === "true";
    this.adapterFactory = () => new ReiBlackBookAdapter();
  }

  attach(store, logger) {
    this.store = store;
    this.logger = logger;
  }

  get status() {
    return this.store ? this.store.job.status : JOB_STATUS.IDLE;
  }
  isBusy() {
    return this._loopActive;
  }

  // --- Control surface ------------------------------------------------------
  async start() {
    if (!this.store) throw new Error("No job loaded. Upload a spreadsheet first.");
    if (this._loopActive) return { ok: true, message: "Already running." };
    assertMessageIntegrity();
    this._control = "running";
    this.store.setStatus(JOB_STATUS.RUNNING);
    this.emitState("Live automation started.");
    this._run().catch((err) => {
      this.emit("error", err);
      this.emitState(`Fatal error: ${err.message}`);
    });
    return { ok: true, message: "Live automation started." };
  }

  pause() {
    if (this._control === "running") {
      this._control = "paused";
      if (this.store) this.store.setStatus(JOB_STATUS.PAUSED);
      this.emitState("Pausing after the current row finishes...");
    }
    return { ok: true, status: this.status };
  }

  async resume() {
    if (this._loopActive && this._control === "paused") {
      this._control = "running";
      this.store.setStatus(JOB_STATUS.RUNNING);
      this.emitState("Resumed.");
      return { ok: true, status: this.status };
    }
    return this.start();
  }

  async stop() {
    this._control = "stopping";
    if (this.store) this.store.setStatus(JOB_STATUS.STOPPED);
    this.emitState("Stopping...");
    return { ok: true, status: this.status };
  }

  // --- Main loop ------------------------------------------------------------
  async _run() {
    this._loopActive = true;
    try {
      this.adapter = this.adapterFactory();
      this.emitState("Launching browser and logging into REI BlackBook...");
      await this.adapter.launch();
      this.emitState("Logged in. Processing leads.");

      const rows = this.store.rows;
      for (let i = this.store.job.cursor; i < rows.length; i++) {
        while (this._control === "paused") await sleep(400);
        if (this._control === "stopping") break;

        this.store.job.cursor = i;
        const row = rows[i];

        if (this.store.isProcessed(row)) {
          this.emit("row", { row, skipped: true });
          continue;
        }

        await this._processRow(row);
        this.store.persist();
        this.emit("row", { row });
        this.emit("summary", this.store.summary());
      }

      if (this._control === "stopping") {
        this.store.setStatus(JOB_STATUS.STOPPED);
        this.emitState("Stopped. Progress saved — you can Resume later.");
      } else {
        this.store.job.cursor = rows.length;
        this.store.setStatus(JOB_STATUS.COMPLETED);
        this.emitFinalSummary();
      }
    } finally {
      if (this.adapter) await this.adapter.close();
      this.adapter = null;
      this._loopActive = false;
      this._control = this.status === JOB_STATUS.RUNNING ? "stopped" : this._control;
      this.emit("summary", this.store ? this.store.summary() : null);
    }
  }

  // --- Per-row SOP processing ----------------------------------------------
  async _processRow(row) {
    const logBase = { row: row.rowNumber, owner: row.ownerName, address: row.propertyAddress, company: row.companySource };
    try {
      const { facts, searchMethod, matchStatus } = await this.adapter.gatherFacts({
        ownerName: row.ownerName,
        propertyAddress: row.propertyAddress,
        city: row.city,
        state: row.state,
        zip: row.zip,
        phone: row.phone,
        email: row.email,
        companySource: row.companySource,
      });

      row.searchMethod = searchMethod;
      row.reiMatchStatus = matchStatus;

      const decision = decide(facts);
      row.propertyStatus = decision.propertyStatus;
      row.safetyStatus = decision.safetySummary || "None";
      row.eligibilityStatus = decision.eligibility;
      row.notes = decision.notes;
      row.errorLog = "";

      let textSent = false;

      if (decision.shouldSend) {
        if (!this.allowLiveSend) {
          row.disposition = DISPOSITION.READY_TO_TEXT;
          row.eligibilityStatus = ELIGIBILITY.ELIGIBLE_SEND_BLOCKED;
          row.notes = "Clean & ready, but ALLOW_LIVE_SEND is off. No text sent.";
        } else {
          const result = await this.adapter.sendText(decision.message);
          textSent = result.sent;
          row.disposition = DISPOSITION.TEXT_SENT;
          row.eligibilityStatus = ELIGIBILITY.ELIGIBLE_TEXT_SENT;
          row.textSentTimestamp = result.timestamp;
          row.notes = "Live text sent successfully";
          await this._applyTag(row, REVIVAL_TAG[DISPOSITION.TEXT_SENT]);
        }
      } else {
        row.disposition = decision.disposition;
        if (decision.tag) await this._applyTag(row, decision.tag);
      }

      this.logger.log({
        ...logBase,
        searchMethod,
        matchFound: facts.matchFound,
        matchStatus,
        complianceResult: decision.complianceResult,
        propertyStatus: row.propertyStatus,
        safety: row.safetyStatus,
        eligibility: row.eligibilityStatus,
        textSent,
        disposition: row.disposition,
        reiTag: row.reiTagApplied,
        notes: row.notes,
        error: row.errorLog,
      });
    } catch (err) {
      row.disposition = DISPOSITION.ERROR;
      row.eligibilityStatus = ELIGIBILITY.NEEDS_REVIEW;
      row.errorLog = err.message;
      this.logger.log({
        ...logBase,
        searchMethod: row.searchMethod || "",
        matchFound: false,
        complianceResult: "error",
        eligibility: row.eligibilityStatus,
        textSent: false,
        disposition: row.disposition,
        notes: row.notes,
        error: err.message,
      });
    }
  }

  // Apply a Revival tag; best-effort. A tag failure is recorded but never
  // reverses a successful send or changes the disposition.
  async _applyTag(row, tagName) {
    if (!tagName) return;
    try {
      await this.adapter.applyTag(tagName);
      row.reiTagApplied = tagName;
    } catch (err) {
      row.reiTagApplied = `${tagName} (FAILED)`;
      row.errorLog = row.errorLog
        ? `${row.errorLog}; tag apply failed: ${err.message}`
        : `Tag apply failed: ${err.message}`;
    }
  }

  emitState(message) {
    this.emit("state", {
      status: this.status,
      cursor: this.store ? this.store.job.cursor : 0,
      total: this.store ? this.store.rows.length : 0,
      allowLiveSend: this.allowLiveSend,
      message,
    });
  }

  emitFinalSummary() {
    const s = this.store.summary();
    const texted = this.store.rows
      .filter((r) => r.disposition === DISPOSITION.TEXT_SENT)
      .map((r) => `${r.ownerName || "Unknown"} — ${r.propertyAddress}`);
    const tagsAdded = this.store.rows
      .filter((r) => r.reiTagApplied && !r.reiTagApplied.includes("FAILED"))
      .map((r) => r.reiTagApplied);
    const failures = this.store.rows
      .filter((r) => r.disposition === DISPOSITION.ERROR || (r.errorLog && r.disposition === DISPOSITION.NEEDS_REVIEW))
      .map((r) => `row ${r.rowNumber}: ${r.errorLog}`);
    this.emit("final", { summary: s, texted, tagsAdded, failures });
    this.emitState("Completed. All rows processed.");
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
