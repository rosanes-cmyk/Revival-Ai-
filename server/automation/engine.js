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
import { PropertyRadarAdapter } from "./propertyradar.js";
import { RedfinAdapter } from "./redfin.js";
import { resolveRedfinUrl } from "./redfinLink.js";
import { decide } from "./sop.js";
import { assertMessageIntegrity, normalizeCompany, COMPANY } from "./message.js";
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
    this._runStats = { count: 0, totalMs: 0 }; // per-run timing for the ETA
    this.allowLiveSend = String(process.env.ALLOW_LIVE_SEND).toLowerCase() === "true";
    // Default company used when a lead has no (or an unrecognized) Company
    // Source. The two approved messages differ only by this name, so a sheet
    // never needs a Company Source column — it just falls back to this.
    this.defaultCompany = normalizeCompany(process.env.DEFAULT_COMPANY) || COMPANY.TWIN_HOME_BUYER;
    // Max texts to actually SEND per run (batching to protect the number).
    // Defaults to 100 even without a .env; 0 = unlimited. Only successful sends
    // count; skips/other outcomes don't. Adjustable live from the dashboard.
    this.maxSendsPerRun = Number(process.env.MAX_SENDS_PER_RUN ?? 100);
    // Optional property Sold/Listed verification, checked FIRST for each lead.
    // PROPERTY_SOURCE = "redfin" (free, no login) | "propertyradar" (login) |
    // "none". Back-compat: CHECK_PROPERTYRADAR=true still selects propertyradar.
    let source = String(process.env.PROPERTY_SOURCE || "").trim().toLowerCase();
    if (!source && String(process.env.CHECK_PROPERTYRADAR).toLowerCase() === "true") source = "propertyradar";
    if (!source) source = "none";
    this.propertySource = source;
    this.checkPropertyStatus = source === "redfin" || source === "propertyradar";
    // REI tag-writing is OFF: the outcome is recorded in the spreadsheet, so we
    // don't write Revival tags back onto REI contacts. Set WRITE_REI_TAGS=true
    // to re-enable.
    this.writeReiTags = String(process.env.WRITE_REI_TAGS).toLowerCase() === "true";
    // Resolve each address to its exact Redfin page so the dashboard can link
    // straight there for a manual check. Fast JSON lookup, no browser. On by
    // default; set REDFIN_LINKS=false to disable.
    this.redfinLinks = String(process.env.REDFIN_LINKS ?? "true").toLowerCase() !== "false";
    this.adapterFactory = () => new ReiBlackBookAdapter();
    this.statusAdapterFactory = () =>
      this.propertySource === "redfin" ? new RedfinAdapter() : new PropertyRadarAdapter();
    this.statusAdapter = null;
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
      if (this.store) this.store.setStatus(JOB_STATUS.STOPPED);
      this.emit("error", err);
      this.emitState(`Stopped — ${err.message}`);
      this.emit("summary", this.store ? this.store.summary() : null);
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
      this.emitState("Opening REI BlackBook. If a login page appears in the browser window, log in there once — it will be remembered for next time.");
      await this.adapter.launch();
      if (this.checkPropertyStatus) {
        const label = this.propertySource === "redfin" ? "Redfin" : "PropertyRadar";
        this.emitState(`Opening ${label} for Sold/Listed verification...`);
        this.statusAdapter = this.statusAdapterFactory();
        await this.statusAdapter.launch();
      }
      this.emitState("Logged in. Processing leads.");

      const rows = this.store.rows;
      this._runStats = { count: 0, totalMs: 0, sends: 0 };
      let batchLimitReached = false;
      for (let i = this.store.job.cursor; i < rows.length; i++) {
        while (this._control === "paused") await sleep(400);
        if (this._control === "stopping") break;

        this.store.job.cursor = i;

        // Stop before starting a new lead once the per-run send cap is hit.
        if (this.maxSendsPerRun > 0 && this._runStats.sends >= this.maxSendsPerRun) {
          batchLimitReached = true;
          break;
        }

        const row = rows[i];

        if (this.store.isProcessed(row)) {
          this.emit("row", { row, skipped: true });
          continue;
        }

        const t0 = Date.now();
        await this._processRow(row);
        this._runStats.count += 1;
        this._runStats.totalMs += Date.now() - t0;

        this.store.persist();
        this.emit("row", { row });
        this.emit("summary", this.store.summary());
        this.emitProgress(i);
      }

      if (this._control === "stopping") {
        this.store.setStatus(JOB_STATUS.STOPPED);
        this.emitState("Stopped. Progress saved — you can Resume later.");
      } else if (batchLimitReached) {
        this.store.setStatus(JOB_STATUS.STOPPED);
        this.emitState(
          `Batch limit reached: ${this._runStats.sends} text(s) sent this run. Progress saved — click Resume/Start for the next batch.`
        );
      } else {
        this.store.job.cursor = rows.length;
        this.store.setStatus(JOB_STATUS.COMPLETED);
        this.emitFinalSummary();
      }
    } finally {
      if (this.adapter) await this.adapter.close();
      if (this.statusAdapter) await this.statusAdapter.close();
      this.adapter = null;
      this.statusAdapter = null;
      this._loopActive = false;
      this._control = "stopped"; // the loop has ended; ready to Start/Resume again
      this.emit("summary", this.store ? this.store.summary() : null);
    }
  }

  // --- Per-row SOP processing ----------------------------------------------
  async _processRow(row) {
    const logBase = { row: row.rowNumber, owner: row.ownerName, address: row.propertyAddress, company: row.companySource };
    try {
      // Resolve the exact Redfin page for this address (fast JSON lookup, no
      // browser) so the dashboard Property Status / Address always link straight
      // to Redfin. Runs regardless of PROPERTY_SOURCE; the live Redfin adapter
      // (if on) may still refine the URL + status.
      if (this.redfinLinks && !row.propertyStatusUrl) {
        const q = /\d{5}|,/.test(row.propertyAddress)
          ? row.propertyAddress
          : [row.propertyAddress, row.city, row.state, row.zip].filter(Boolean).join(", ");
        row.propertyStatusUrl = await resolveRedfinUrl(q).catch(() => "");
      }

      // Property status (Redfin / PropertyRadar) FIRST (if enabled): if it's
      // sold/listed, skip the REI checks entirely, tag it, and move on.
      if (this.statusAdapter) {
        const handled = await this._propertyStatusFirst(row, logBase);
        if (handled) return;
      }

      const { facts, searchMethod, matchStatus } = await this.adapter.gatherFacts({
        ownerName: row.ownerName,
        propertyAddress: row.propertyAddress,
        street: row.street,
        city: row.city,
        state: row.state,
        zip: row.zip,
        phone: row.phone,
        email: row.email,
        // Fall back to the default company so a missing/unknown Company Source
        // never blocks a send.
        companySource: normalizeCompany(row.companySource) || this.defaultCompany,
      });

      row.searchMethod = searchMethod;
      row.reiMatchStatus = matchStatus;
      if (facts.contactUrl) row.reiContactUrl = facts.contactUrl;

      const decision = decide(facts);
      row.propertyStatus = decision.propertyStatus;
      // If Redfin gave a real status (e.g. Off Market) and REI didn't flag the
      // property sold/listed itself, show Redfin's status instead of the
      // generic "Not sold / not listed".
      if (row._redfinStatus && decision.disposition !== DISPOSITION.PROPERTY_SOLD && decision.disposition !== DISPOSITION.LISTED) {
        row.propertyStatus = `${row._redfinStatus} (Redfin)`;
      }
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
          if (textSent) this._runStats.sends += 1;
          row.disposition = DISPOSITION.TEXT_SENT;
          row.eligibilityStatus = ELIGIBILITY.ELIGIBLE_TEXT_SENT;
          row.textSentTimestamp = result.timestamp;
          row.notes = "Live text sent successfully";
          if (this.writeReiTags) await this._applyTag(row, REVIVAL_TAG[DISPOSITION.TEXT_SENT]);
        }
      } else {
        row.disposition = decision.disposition;
        if (this.writeReiTags && decision.tag) await this._applyTag(row, decision.tag);
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

  // Property-status-first: look the property up in Redfin / PropertyRadar
  // before touching REI. If it is sold or listed, disposition it, tag it in REI
  // (best-effort), and skip the rest. Returns true if it handled the row.
  async _propertyStatusFirst(row, logBase) {
    const src = this.statusAdapter.sourceName || (this.propertySource === "redfin" ? "Redfin" : "PropertyRadar");
    const pr = await this.statusAdapter
      .lookupStatus({ propertyAddress: row.propertyAddress, city: row.city, state: row.state, zip: row.zip })
      .catch((e) => ({ uncertain: true, reason: e.message }));
    // Keep the property-check link (e.g. Redfin) on the row for validation,
    // whether or not it turned out sold/listed.
    if (pr && pr.propertyUrl) row.propertyStatusUrl = pr.propertyUrl;
    // Remember a non-blocking status (e.g. Off Market) to show in the dashboard
    // even though the lead still proceeds to REI.
    if (pr && pr.statusLabel) row._redfinStatus = pr.statusLabel;
    if (!pr || !pr.checked || pr.uncertain || (!pr.sold && !pr.listed)) return false;

    const sold = pr.sold;
    row.searchMethod = `${src} (checked first)`;
    row.eligibilityStatus = ELIGIBILITY.NOT_ELIGIBLE;
    row.disposition = sold ? DISPOSITION.PROPERTY_SOLD : DISPOSITION.LISTED;
    row.propertyStatus = sold ? (pr.soldDate ? `Sold (${pr.soldDate})` : "Sold") : "Listed (Active)";
    row.notes = sold
      ? (pr.soldDate ? `Sold per ${src} (${pr.soldDate})` : `Sold per ${src}`)
      : `Listed per ${src}${pr.listingNote ? ": " + pr.listingNote : ""}`;
    row.errorLog = "";

    // Best-effort: find the REI contact and tag it Sold/Listed.
    try {
      const located = await this.adapter.locateContact({
        ownerName: row.ownerName, propertyAddress: row.propertyAddress, city: row.city,
        state: row.state, zip: row.zip, phone: row.phone, email: row.email,
      });
      row.reiMatchStatus = located.matchFound ? located.matchStatus : "Not Found (skipped as sold/listed)";
      if (located.contactUrl) row.reiContactUrl = located.contactUrl;
      if (this.writeReiTags && located.matchFound) await this._applyTag(row, REVIVAL_TAG[row.disposition]);
    } catch (e) {
      row.errorLog = `${src}-first tag step: ${e.message}`;
    }

    this.logger.log({
      ...logBase,
      searchMethod: row.searchMethod,
      matchFound: String(row.reiMatchStatus).startsWith("Match"),
      matchStatus: row.reiMatchStatus,
      complianceResult: sold ? `Sold (${src})` : `Listed (${src})`,
      propertyStatus: row.propertyStatus,
      eligibility: row.eligibilityStatus,
      textSent: false,
      disposition: row.disposition,
      reiTag: row.reiTagApplied,
      notes: row.notes,
      error: row.errorLog,
    });
    return true;
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

  // Emit avg time-per-lead and an ETA for the leads still to process.
  emitProgress(currentIndex) {
    const rows = this.store.rows;
    const avgMs = this._runStats.count ? this._runStats.totalMs / this._runStats.count : 0;
    let remaining = 0;
    for (let j = currentIndex + 1; j < rows.length; j++) {
      if (!this.store.isProcessed(rows[j])) remaining++;
    }
    this.emit("progress", {
      processedThisRun: this._runStats.count,
      avgMs: Math.round(avgMs),
      remaining,
      etaMs: Math.round(avgMs * remaining),
      done: currentIndex + 1,
      total: rows.length,
    });
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
