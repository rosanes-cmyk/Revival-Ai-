// Automation engine: processes an uploaded job row-by-row, live.
//
// Responsibilities:
//   - Iterate rows in order, skipping already-processed ones (SOP steps A, 8).
//   - For each pending row: search REI BlackBook, apply SOP rules, and send the
//     approved text immediately IF and ONLY IF the lead is eligible (SOP step H)
//     and the live-send switch is on.
//   - Persist state after every row so Stop/crash can be resumed with no dupes.
//   - Emit events for the live dashboard (SSE) and log every row (SOP step 7).
//
// Control model: Start / Pause / Resume / Stop. Pause halts BETWEEN rows (a row
// in flight always finishes, so a send is never left half-done). Stop ends the
// run and closes the browser; Resume/Start begins again from the cursor.

import { EventEmitter } from "events";
import { ReiBlackBookAdapter } from "./reibb.js";
import { decide } from "./sop.js";
import { assertMessageIntegrity } from "./message.js";
import { JOB_STATUS } from "../data/store.js";
import { DISPOSITION, ELIGIBILITY } from "./constants.js";

export class AutomationEngine extends EventEmitter {
  constructor() {
    super();
    this.store = null;
    this.logger = null;
    this.adapter = null;
    this._control = "stopped"; // running | paused | stopping | stopped
    this._loopActive = false;
    this.contactWindowDays = Number(process.env.CONTACT_WINDOW_DAYS || 90);
    this.allowLiveSend = String(process.env.ALLOW_LIVE_SEND).toLowerCase() === "true";
    // Factory is overridable for testing; production uses the real adapter.
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
    // Not mid-loop (e.g. after a restart): start a fresh loop from the cursor.
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
        // Respect pause/stop between rows.
        while (this._control === "paused") {
          await sleep(400);
        }
        if (this._control === "stopping") break;

        this.store.job.cursor = i;
        const row = rows[i];

        // SOP step A / 8: skip already-processed rows (no duplicate texts).
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
        this.emitState("Completed. All rows processed.");
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
    const logBase = { row: row.rowNumber, owner: row.ownerName, address: row.propertyAddress };
    try {
      // B: search REI BlackBook.
      const { facts, searchMethod, matchStatus } = await this.adapter.gatherFacts({
        ownerName: row.ownerName,
        propertyAddress: row.propertyAddress,
        city: row.city,
        state: row.state,
        zip: row.zip,
      });

      row.searchMethod = searchMethod;
      row.reiMatchStatus = matchStatus;

      // C–G: apply SOP rules.
      const decision = decide(facts, { contactWindowDays: this.contactWindowDays, now: new Date() });

      row.optOutStatus = decision.optOutStatus;
      row.propertyStatus = decision.propertyStatus;
      row.lastContactDate = decision.lastContactDate
        ? new Date(decision.lastContactDate).toISOString().slice(0, 10)
        : "";
      row.eligibilityStatus = decision.eligibility;
      row.notes = decision.notes;
      row.errorLog = "";

      let textSent = false;

      if (decision.shouldSendText) {
        // H: eligible. Send the approved text immediately (live only).
        if (!this.allowLiveSend) {
          row.disposition = DISPOSITION.PENDING;
          row.eligibilityStatus = ELIGIBILITY.ELIGIBLE_SEND_BLOCKED;
          row.notes = "Eligible, but ALLOW_LIVE_SEND is off. No text sent.";
        } else {
          const result = await this.adapter.sendText();
          textSent = result.sent;
          row.disposition = DISPOSITION.TEXT_SENT;
          row.eligibilityStatus = ELIGIBILITY.ELIGIBLE_TEXT_SENT;
          row.textSentTimestamp = result.timestamp;
          // Leave notes blank unless an exception exists (SOP step H).
          if (!facts.hasDoNotMail && !facts.hasDoNotContact) row.notes = "";
        }
      } else {
        // C/D/E/F/G outcome already encoded in the decision.
        row.disposition = decision.disposition;
      }

      this.logger.log({
        ...logBase,
        searchMethod,
        matchFound: facts.matchFound,
        matchStatus,
        complianceResult: decision.complianceResult,
        propertyStatus: row.propertyStatus,
        lastContactDate: row.lastContactDate,
        eligibility: row.eligibilityStatus,
        textSent,
        disposition: row.disposition,
        notes: row.notes,
        error: "",
      });
    } catch (err) {
      // Any unexpected failure -> Error disposition, never a blind send.
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

  emitState(message) {
    this.emit("state", {
      status: this.status,
      cursor: this.store ? this.store.job.cursor : 0,
      total: this.store ? this.store.rows.length : 0,
      allowLiveSend: this.allowLiveSend,
      message,
    });
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
