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
import { decide, classifyReply } from "./sop.js";
import { assertMessageIntegrity, normalizeCompany, COMPANY, renderMessage, pickApprovedTemplate, cleanPersonName } from "./message.js";
import { JOB_STATUS, categorizeRow, TAB } from "../data/store.js";
import { SentLedger } from "../data/sentLedger.js";
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
    // DEPRECATED (kept for back-compat with old .env / saved config): the
    // per-run "Texts per Run" cap is no longer used to stop a run and is no
    // longer shown in the UI. Sending is now governed by the backend daily hard
    // cap below. The field remains so old configs / the /api/batch-limit route
    // don't break.
    this.maxSendsPerRun = Number(process.env.MAX_SENDS_PER_RUN ?? 0);
    this.autoContinue = String(process.env.AUTO_CONTINUE ?? "true").toLowerCase() !== "false";
    this.batchPauseMs = Number(process.env.BATCH_PAUSE_MS ?? 8000);
    // Backend SAFETY MAXIMUM: never send more than this many texts in one
    // calendar day (across runs/restarts — counted from the ledger). This is the
    // guardrail that replaces the removed UI batch control so removing it can't
    // create an uncontrolled sending loop. 0 = unlimited (not recommended).
    this.dailySendHardCap = Number(process.env.DAILY_SEND_HARD_CAP ?? 300);
    // Gentle pacing: pause briefly every N successful sends to protect the
    // number from carrier spam flags (replaces the old per-batch stop).
    this.pacingEvery = Number(process.env.SEND_PACING_EVERY ?? 40);
    this._dailySends = 0;        // sends counted this run (seeded from ledger)
    this._pacedAtSends = 0;      // guard so a pacing pause fires once per step
    this._sentThisRun = new Set(); // in-run dedup keys (no persistence) — never text the same contact twice in one run
    this._recheckCursor = 0;     // resume point for Recheck Text Sent
    this._recheckList = null;    // frozen row list for the current recheck pass
    this._recheckStop = false;
    // Eligibility-scan mode: run the full pipeline but NEVER send — eligible
    // leads are marked Ready To Text (Available to Text tab) instead. Used to
    // build the Available-to-Text list without texting anyone.
    this._scanOnly = false;
    // "Recently texted" window (days) that keeps a lead OUT of Available to Text.
    this.recentTextDays = Number(process.env.AVAILABLE_TEXT_MIN_DAYS ?? 30);
    // After a LIVE texting run finishes, automatically Recheck the sent texts
    // (delivery status + replies) so the Percentage Report is accurate without a
    // manual click. Set AUTO_RECHECK_AFTER_RUN=false to turn off.
    this.autoRecheckAfterRun = String(process.env.AUTO_RECHECK_AFTER_RUN ?? "true").toLowerCase() !== "false";
    // Optional property Sold/Listed verification, checked FIRST for each lead.
    // PROPERTY_SOURCE = "redfin" (free, no login) | "propertyradar" (login) |
    // "none". Back-compat: CHECK_PROPERTYRADAR=true still selects propertyradar.
    let source = String(process.env.PROPERTY_SOURCE || "").trim().toLowerCase();
    if (!source && String(process.env.CHECK_PROPERTYRADAR).toLowerCase() === "true") source = "propertyradar";
    // Default to Redfin (free, no login) so the Sold/Listed check is ALWAYS on
    // unless explicitly turned off with PROPERTY_SOURCE=none.
    if (!source) source = "redfin";
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
    // Only text properties in these states (default California). Anything else
    // is skipped as Out of State. Override with TEXT_STATES="CA,NV" etc.
    this.allowedStates = new Set(
      String(process.env.TEXT_STATES || "CA,California")
        .split(",")
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean)
    );
    // If a lead's state is UNKNOWN (blank on the sheet AND unreadable from REI),
    // hold it for review instead of texting blind — so an out-of-state lead is
    // never texted by mistake. Set ALLOW_UNKNOWN_STATE_TEXT=true to text
    // unknown-state leads anyway.
    this.allowUnknownStateText =
      String(process.env.ALLOW_UNKNOWN_STATE_TEXT || "false").toLowerCase() === "true";
    this.adapterFactory = () => new ReiBlackBookAdapter();
    this.statusAdapterFactory = () =>
      this.propertySource === "redfin" ? new RedfinAdapter() : new PropertyRadarAdapter();
    this.statusAdapter = null;
    // Rule: never text the same lead twice in the same calendar month. The
    // ledger persists across runs / uploads / REI pulls (keyed by REI contact
    // id and phone). Set SKIP_TEXTED_THIS_MONTH=false to disable.
    this.skipTextedThisMonth =
      String(process.env.SKIP_TEXTED_THIS_MONTH ?? "true").toLowerCase() !== "false";
    // NO LOCAL MEMORY (default): the app does NOT remember past results in a
    // local file. Every lead is re-checked FRESH from REI/Redfin each run, and
    // double-texting is prevented by reading the lead's LIVE REI chat (the SOP
    // "already texted this month" check in decide()), not a saved file. Set
    // USE_LEDGER_MEMORY=true to restore the persistent local memory/prefill.
    this.useLedgerMemory = String(process.env.USE_LEDGER_MEMORY ?? "false").toLowerCase() === "true";
    this.sentLedger = new SentLedger();
  }

  attach(store, logger) {
    this.store = store;
    this.logger = logger;
    // A new job invalidates any in-progress recheck resume state, so a Recheck
    // after an upload/pull can't iterate the previous job's orphaned rows.
    this._recheckList = null;
    this._recheckCursor = 0;
  }

  get status() {
    return this.store ? this.store.job.status : JOB_STATUS.IDLE;
  }
  isBusy() {
    return this._loopActive;
  }

  // Build the "Available to Text" list: run the full eligibility pipeline over
  // every loaded lead WITHOUT sending. Eligible + not-texted-in-30-days leads
  // end up marked Ready To Text (Available to Text tab). Nothing is texted, even
  // if Live Sending is on.
  async startAvailabilityScan() {
    if (!this.store) throw new Error("No leads loaded. Pull from REI (or upload) first.");
    if (this._loopActive) return { ok: false, message: "Already running." };
    this._scanOnly = true;
    try {
      return await this.start();
    } catch (e) {
      this._scanOnly = false; // never leave scan-mode stuck if start() fails
      throw e;
    }
  }

  // --- Control surface ------------------------------------------------------
  async start() {
    if (!this.store) throw new Error("No job loaded. Upload a spreadsheet first.");
    if (this._loopActive) return { ok: true, message: "Already running." };
    assertMessageIntegrity();
    // Fresh start: rewind to the first unfinished lead so errored / held /
    // pending leads get re-checked (finished ones are still skipped instantly).
    const firstUnfinished = this.store.rows.findIndex((r) => !this.store.isProcessed(r));
    this.store.job.cursor = firstUnfinished >= 0 ? firstUnfinished : this.store.rows.length;
    // A fresh run invalidates any partial manual-recheck resume, so the
    // auto-recheck after this run builds a fresh list covering newly-sent texts.
    this._recheckCursor = 0;
    this._recheckList = null;
    this._control = "running";
    this.store.setStatus(JOB_STATUS.RUNNING);
    this.emitState(this._scanOnly
      ? "Building Available-to-Text list — rechecking every lead's eligibility (no texts sent)…"
      : "Live automation started.");
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
    let doAutoRecheck = false;
    try {
      this.adapter = this.adapterFactory();
      this.emitState("Opening REI BlackBook. If a login page appears in the browser window, log in there once — it will be remembered for next time.");
      await this.adapter.launch();
      // Scope the monthly memory to whichever REI account is logged in now, so
      // a different account never reuses another account's saved data.
      await this._bindLedgerToAccount();
      if (this.checkPropertyStatus) {
        const label = this.propertySource === "redfin" ? "Redfin" : "PropertyRadar";
        this.emitState(`Opening ${label} for Sold/Listed verification...`);
        this.statusAdapter = this.statusAdapterFactory();
        await this.statusAdapter.launch();
      }
      this.emitState("Logged in. Processing leads.");

      const rows = this.store.rows;
      this._runStats = { count: 0, totalMs: 0, sends: 0 };
      // Seed today's send count from the ledger so the daily cap holds across
      // restarts within the same day. With no local memory, the cap is a
      // per-run counter starting at 0.
      this._dailySends = this.useLedgerMemory ? this.sentLedger.textedCountOn(new Date()) : 0;
      this._pacedAtSends = 0;
      this._sentThisRun = new Set(); // fresh per run
      let batchLimitReached = false; // = daily hard cap reached
      for (let i = this.store.job.cursor; i < rows.length; i++) {
        while (this._control === "paused") await sleep(400);
        if (this._control === "stopping") break;

        this.store.job.cursor = i;

        // Backend daily hard cap hit → stop this run (progress saved). Protects
        // the number no matter how many leads remain.
        if (this.dailySendHardCap > 0 && this._dailySends >= this.dailySendHardCap) {
          batchLimitReached = true;
          break;
        }

        // Gentle pacing: brief pause every `pacingEvery` successful sends.
        if (
          this.pacingEvery > 0 &&
          this._runStats.sends > 0 &&
          this._runStats.sends % this.pacingEvery === 0 &&
          this._pacedAtSends !== this._runStats.sends
        ) {
          this._pacedAtSends = this._runStats.sends;
          this.emitState(`Sent ${this._runStats.sends} so far — brief pause to protect the number…`);
          const until = Date.now() + this.batchPauseMs;
          while (Date.now() < until && this._control !== "stopping") await sleep(400);
          if (this._control === "stopping") break;
        }

        const row = rows[i];

        if (this.store.isProcessed(row)) {
          // Backfill a missing REI link on already-finished out-of-state leads
          // (older runs didn't capture it). Everything else is skipped as done.
          const needsLinkBackfill =
            row.disposition === DISPOSITION.OUT_OF_STATE && !row.reiContactUrl;
          if (!needsLinkBackfill) {
            this.emit("row", { row, skipped: true });
            continue;
          }
        }

        const t0 = Date.now();
        await this._processRow(row);
        // If the browser closed/crashed mid-check, reopen it and retry this
        // lead once so a single closed window doesn't error out the whole run.
        if (
          row.disposition === DISPOSITION.ERROR &&
          this._isBrowserGone(row.errorLog) &&
          this._control !== "stopping"
        ) {
          const recovered = await this._recoverBrowser();
          if (recovered) {
            row.disposition = DISPOSITION.PENDING;
            row.errorLog = "";
            await this._processRow(row);
          }
        }
        this._runStats.count += 1;
        this._runStats.totalMs += Date.now() - t0;

        // Guarantee: a lead that was NOT texted always carries a written reason.
        // We never guess — every skip above sets one; this is only a backstop so
        // a reason can never be blank.
        if (
          !String(row.notes || "").trim() &&
          row.disposition !== DISPOSITION.PENDING &&
          row.disposition !== DISPOSITION.READY_TO_TEXT &&
          row.disposition !== DISPOSITION.TEXT_SENT
        ) {
          row.notes = `Not texted — status: ${row.disposition}. See the Opt-Out/Safety and Property Status for the specific reason.`;
        }

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
          `Daily send limit reached (${this.dailySendHardCap} texts today). Progress saved — it will continue automatically tomorrow, or click Start to resume other checks.`
        );
      } else {
        this.store.job.cursor = rows.length;
        this.store.setStatus(JOB_STATUS.COMPLETED);
        // A finished LIVE run that actually sent texts → auto-recheck them so
        // delivery status + replies + percentages are accurate. Not after an
        // eligibility scan (nothing was sent).
        doAutoRecheck = this.autoRecheckAfterRun && !this._scanOnly && (this._runStats.sends || 0) > 0;
        this.emitFinalSummary();
      }
    } finally {
      if (this.adapter) await this.adapter.close();
      if (this.statusAdapter) await this.statusAdapter.close();
      this.adapter = null;
      this.statusAdapter = null;
      this._loopActive = false;
      this._control = "stopped"; // the loop has ended; ready to Start/Resume again
      this._scanOnly = false;    // clear eligibility-scan mode
      this.emit("summary", this.store ? this.store.summary() : null);
    }
    // Auto-recheck runs AFTER the send loop fully closed its browser, so it gets
    // a clean read-only pass. Guarded so it can't recurse.
    if (doAutoRecheck) {
      this.emitState("Run complete — automatically rechecking sent texts (delivery + replies) so the numbers are accurate…");
      await this.recheckTextSent().catch((err) => this.emitState(`Auto-recheck could not finish: ${err.message}`));
    }
  }

  // --- Re-verify already-"Text Sent" leads ---------------------------------
  // Opens each lead currently marked Text Sent and checks whether an approved
  // revival message is REALLY in its chat. Confirmed ones stay Text Sent;
  // leads where it isn't found (e.g. opted-out numbers that never actually
  // sent) are reset to Pending so a later run re-checks them correctly. Never
  // sends anything.
  async reverify() {
    if (this._loopActive) throw new Error("Automation is running. Stop it first, then Re-verify.");
    if (!this.store) throw new Error("No leads loaded to re-verify.");
    this._loopActive = true;
    this._control = "running";
    try {
      this.adapter = this.adapterFactory();
      this.emitState("Opening REI to re-verify leads marked Text Sent (log in if prompted)...");
      await this.adapter.launch();

      const rows = this.store.rows.filter((r) => r.disposition === DISPOSITION.TEXT_SENT);
      let confirmed = 0;
      let reset = 0;
      let uncheckable = 0;
      this.emitState(`Re-verifying ${rows.length} lead(s) marked Text Sent...`);

      for (const row of rows) {
        if (this._control === "stopping") break;
        const present = await this.adapter.verifyApprovedMessagePresent(row.reiContactUrl);
        if (present === true) {
          confirmed++;
          row.notes = "Re-verified: approved message found in the REI chat.";
        } else if (present === false) {
          reset++;
          row.disposition = DISPOSITION.PENDING;
          row.eligibilityStatus = ELIGIBILITY.PENDING;
          row.textSentTimestamp = "";
          // It wasn't actually sent — clear the send record AND any reply data
          // (a reply we recorded against a non-sent message is invalid) so it
          // isn't counted in the tabs / percentage report.
          row.sentMessageBody = "";
          row.messageDeliveryStatus = "";
          row.deliveryStatusEvidence = "";
          row.replyReceived = false;
          row.replyText = "";
          row.replyReceivedAt = "";
          row.replyClassification = "";
          row.replyClassificationReason = "";
          row.notes = "Re-verify: approved message NOT found in chat — was not actually sent (likely opted out). Reset to re-check.";
        } else {
          uncheckable++;
          row.notes = (row.notes ? row.notes + " " : "") + "(Re-verify: could not open the contact to check.)";
        }
        this.store.persist();
        this.emit("row", { row });
        this.emit("summary", this.store.summary());
      }

      // Let the reset leads be re-processed on the next Start.
      this.store.job.cursor = 0;
      this.store.persist();
      this.emitState(
        `Re-verify done. Confirmed sent: ${confirmed}. Reset to re-check: ${reset}. Could not open: ${uncheckable}. ` +
          (reset > 0 ? "Click Start to re-check the reset leads (turn Live Sending on if you want them re-sent/opt-out-checked)." : "")
      );
      this.emit("summary", this.store.summary());
      return { confirmed, reset, uncheckable };
    } finally {
      if (this.adapter) await this.adapter.close();
      this.adapter = null;
      this._loopActive = false;
      this._control = "stopped";
    }
  }

  // --- Recheck Text Sent (manual, read-only) --------------------------------
  // Opens each Text Sent lead's REI chat, verifies the exact outbound message,
  // reads any visible delivery status, and detects + classifies a seller reply.
  // NEVER sends, types, clicks Send, changes the sent timestamp, or writes the
  // ledger. Supports Stop (progress preserved) and auto-resume from where it
  // stopped. Streams a "recheck" progress event.
  requestStopRecheck() { this._recheckStop = true; }

  async recheckTextSent() {
    if (this._loopActive) throw new Error("Automation is running. Stop it first, then Recheck.");
    if (!this.store) throw new Error("No leads loaded to recheck.");
    this._loopActive = true;
    this._control = "running";
    this._recheckStop = false;
    const norm = (s) => String(s || "").replace(/\s+/g, " ").trim().toLowerCase();
    try {
      this.adapter = this.adapterFactory();
      this.emitState("Opening REI to recheck Text Sent leads (log in if prompted)…");
      await this.adapter.launch();
      // Bind the monthly/suppression ledger to the logged-in REI account FIRST,
      // so suppression writes (replied sellers) go to the correct account file —
      // the same file the live run reads for isSuppressed. (Without this a
      // Recheck run before any Start could suppress into the default file and be
      // invisible later — a replied/opted-out seller could then be re-texted.)
      await this._bindLedgerToAccount();

      // Resume uses the SAME frozen list captured when the pass began — NOT a
      // freshly filtered one. A reply can reclassify a lead out of "Text Sent"
      // mid-pass; rebuilding the list would shift indexes and skip un-checked
      // leads. So we keep the row references from the first pass.
      let list;
      if (this._recheckList && this._recheckCursor > 0 && this._recheckCursor < this._recheckList.length) {
        list = this._recheckList; // resume a stopped pass
      } else {
        list = this.store.rows.filter((r) => categorizeRow(r) === TAB.TEXT_SENT);
        this._recheckList = list;
        this._recheckCursor = 0;
      }
      const total = list.length;
      const startIdx = this._recheckCursor;

      let checked = startIdx, replies = 0, interested = 0, notInt = 0, failed = 0, needsRev = 0, errors = 0;
      const emitRecheck = (extra = {}) =>
        this.emit("recheck", {
          total, checked, remaining: Math.max(0, total - checked),
          replies, interested, notInterested: notInt, failed, needsReview: needsRev, errors,
          percent: total ? Number(((checked / total) * 100).toFixed(2)) : 0,
          ...extra,
        });

      this.emitState(`Rechecking ${total} Text Sent lead(s)…`);
      emitRecheck({ running: true });

      for (let i = startIdx; i < list.length; i++) {
        if (this._recheckStop || this._control === "stopping") { this._recheckCursor = i; break; }
        const row = list[i];
        emitRecheck({ running: true, currentSeller: row.ownerName || "", currentProperty: row.propertyAddress || "" });

        const detail = await this.adapter.readConversationDetail(row.reiContactUrl, {
          sentMessageBody: row.sentMessageBody,
          sentTimestamp: row.textSentTimestamp,
        });

        row.messageStatusLastCheckedAt = new Date().toISOString();
        row.messageStatusCheckAttempts = (row.messageStatusCheckAttempts || 0) + 1;

        if (detail.ok) {
          row.messageDeliveryStatus = detail.deliveryStatus; // Sent|Delivered|Failed|Undelivered|Unknown
          row.deliveryStatusEvidence = detail.deliveryEvidence || "";
          row.recheckError = "";
          row.recheckCompleted = true;
          if (detail.deliveryStatus === "Failed" || detail.deliveryStatus === "Undelivered") failed++;

          if (detail.replyReceived && detail.replyText) {
            row.replyReceived = true;
            // NEVER overwrite the original stored reply — keep the earliest.
            if (!row.replyText) {
              row.replyText = detail.replyText;
              row.replyReceivedAt = detail.replyAt || row.replyReceivedAt || row.messageStatusLastCheckedAt;
            }
            const cls = classifyReply(row.replyText);
            row.replyClassification = cls.classification;
            row.replyClassificationReason = cls.reason;
            replies++; // one reply per lead in a pass

            if (cls.classification === "interested") {
              interested++;
              row.activeDeal = true;
              row.activeDealReason = "Seller reply shows interest — " + cls.reason;
              row.needsManualReview = false;
            } else if (cls.classification === "not_interested") {
              notInt++;
              row.disposition = DISPOSITION.NOT_INTERESTED;
              row.eligibilityStatus = ELIGIBILITY.NOT_ELIGIBLE;
              if (cls.optOut) {
                row.safetyStatus = "Opted out (seller reply) — suppressed";
                // Suppression is persisted below via the ledger; we deliberately
                // do NOT write a REI tag here — Recheck stays strictly read-only
                // (no typing, no Send, no tag writes). The lead is now terminal-
                // negative and permanently suppressed regardless.
              }
            } else {
              needsRev++;
              row.needsManualReview = true;
            }
            row.notes = (row.notes ? row.notes + " " : "") + `Reply (${cls.classification}): "${row.replyText.slice(0, 140)}"`;
            // A seller who replied is taken over by the team — ALWAYS persist a
            // permanent do-not-text suppression (this is a compliance safety
            // list, kept even when the dashboard "memory" is off), so a later
            // pull never re-texts someone who already replied or opted out.
            this.sentLedger.suppress({
              contactUrl: row.reiContactUrl,
              phone: row.phone,
              classification: cls.classification,
              reason: cls.reason,
            });
          }
        } else {
          // Transient: expired login / browser / selector / missing conversation.
          // Keep the lead in Text Sent so a later recheck retries it. Do NOT
          // fabricate a delivery status or mark it a bad lead.
          row.messageDeliveryStatus = "Needs Recheck";
          row.recheckError = detail.error || "Could not verify this conversation.";
          row.recheckCompleted = false;
          errors++;
          this.store.persist();
          this.emit("row", { row });
          // If the REI login expired, every remaining lead would also fail — stop
          // the pass now (resumable) so the user can log back in and continue.
          if (/login/i.test(detail.error || "")) {
            this._recheckCursor = i; // resume here (this lead not yet completed)
            this.emitState("Recheck paused — REI login expired. Log back into REI, then click Recheck Text Sent to resume.");
            emitRecheck({ running: false, stopped: true });
            return { checked, total, replies, interested, notInterested: notInt, failed, needsReview: needsRev, errors, stopped: true, loginExpired: true };
          }
        }

        checked++;
        this._recheckCursor = i + 1;
        this.store.persist();
        this.emit("row", { row });
        this.emit("summary", this.store.summary());
        emitRecheck({ running: true });
      }

      const stopped = this._recheckStop || this._control === "stopping";
      if (!stopped) { this._recheckCursor = 0; this._recheckList = null; } // full pass done → next is fresh
      emitRecheck({ running: false, done: !stopped, stopped });
      this.emitState(
        stopped
          ? `Recheck stopped at ${checked}/${total}. Results saved — click Recheck Text Sent to resume.`
          : `Recheck complete: ${checked} checked · ${replies} replies (interested ${interested}, not interested ${notInt}, needs review ${needsRev}) · ${failed} failed/undelivered · ${errors} could not check.`
      );
      return { checked, total, replies, interested, notInterested: notInt, failed, needsReview: needsRev, errors, stopped };
    } finally {
      if (this.adapter) await this.adapter.close();
      this.adapter = null;
      this._loopActive = false;
      this._control = "stopped";
      this._recheckStop = false;
    }
  }

  // --- Pull all contacts from REI (no spreadsheet) --------------------------
  // Launches the browser, logs in, and enumerates every contact URL from the
  // REI Contacts list. Returns an array of contact URLs. The caller turns these
  // into a job. (Each still goes through all safety checks when processed.)
  async enumerateReiContacts(max = 10000) {
    if (this._loopActive) throw new Error("Automation is running. Stop it first.");
    const adapter = this.adapterFactory();
    this.emitState("Opening REI to pull all contacts (log in if prompted)...");
    await adapter.launch();
    try {
      // Scope the monthly memory to the logged-in REI account before we build
      // rows / apply memory, so a different account uses a different file.
      const account = await this._bindLedgerFromAdapter(adapter);
      const urls = await adapter.enumerateContactIds(max, (n) => this.emitState(`Found ${n} REI contacts...`));
      // Name/phone captured from the list page, keyed by contact url.
      const info = adapter._pulledInfo instanceof Map ? adapter._pulledInfo : new Map();
      return { urls, info, account };
    } finally {
      await adapter.close();
    }
  }

  // Point this.sentLedger at the file for the given account fingerprint. Safe to
  // call repeatedly; only rebuilds when the account actually changes. Returns
  // the account label ("" if it couldn't be detected).
  // --- Connection self-test (read-only) -------------------------------------
  // Opens REI and verifies the whole read path the safety checks depend on —
  // login, open a contact, read tags, read the chat, and confirm the reply box
  // + Send button are present. NEVER sends. Streams a "selftest" event with a
  // ✅/❌ checklist and an overall pass/fail.
  async selfTest() {
    if (this._loopActive) throw new Error("Automation is running. Stop it first, then Test Connection.");
    this._loopActive = true;
    this._control = "running";
    const steps = [];
    const add = (name, okv, detail = "") => { steps.push({ name, ok: !!okv, detail }); this.emit("selftest", { running: true, steps }); };
    try {
      this.adapter = this.adapterFactory();
      this.emitState("Connection test — opening REI (log in the window if prompted)…");
      await this.adapter.launch(); // resolves only once logged in
      add("Logged into REI BlackBook", true, "Session is active.");

      const url = await this.adapter.firstAnyContactUrl();
      add("Opened the Contacts list", !!url, url ? "Found a contact to test with." : "Could not find any contact link on the Contacts page.");

      if (url) {
        const p = await this.adapter.probeContact(url);
        add("Opened a contact record", p.opened, p.error || "");
        add("Read the contact's tags", p.tagsReadable, p.tagsReadable ? "" : "Could not confirm the Tag(s) section — safety tags might not be read on this layout.");
        add("Read the chat / conversation", p.chatReadable, p.chatReadable ? "" : "Could not confirm the chat loaded — the duplicate-text check depends on this.");
        add("Reply box + Send button present", p.sendBoxPresent && p.sendButtonPresent, "(found only — never typed or clicked)");
      }

      const pass = steps.length > 0 && steps.every((s) => s.ok);
      this.emit("selftest", { running: false, done: true, pass, steps });
      this.emitState(pass
        ? "Connection test PASSED ✅ — REI login and reading work on this account. Safe to run."
        : "Connection test found issues ❌ — see the checklist; texting shouldn't run until these read steps pass.");
      return { pass, steps };
    } catch (e) {
      add("Connection", false, e.message);
      this.emit("selftest", { running: false, done: true, pass: false, steps });
      this.emitState(`Connection test error: ${e.message}`);
      return { pass: false, steps };
    } finally {
      if (this.adapter) await this.adapter.close();
      this.adapter = null;
      this._loopActive = false;
      this._control = "stopped";
    }
  }

  // Keys for the in-run duplicate guard: REI contact id + normalized phone.
  _runDedupKeys(contactUrl, phone) {
    const keys = [];
    const m = String(contactUrl || "").match(/\/contacts\/(\d+)/i);
    if (m) keys.push(`c:${m[1]}`);
    const p = String(phone || "").replace(/\D+/g, "").replace(/^1(\d{10})$/, "$1");
    if (p.length >= 10) keys.push(`p:${p}`);
    return keys;
  }

  _bindLedger(account) {
    const ns = String(account || "");
    // Never DOWNGRADE from a real (non-empty) account to the shared default
    // file. If the account can't be detected right now but we already bound a
    // real one, keep it — otherwise suppression/monthly writes scatter into the
    // wrong ledger and a replied/opted-out seller could be re-texted.
    if (!ns && this._ledgerAccount) return this._ledgerAccount;
    if (this._ledgerAccount === ns && this.sentLedger) return ns;
    this._ledgerAccount = ns;
    this.sentLedger = new SentLedger(ns);
    return ns;
  }

  async _bindLedgerFromAdapter(adapter) {
    let account = "";
    try {
      if (adapter && typeof adapter.accountFingerprint === "function") {
        account = await adapter.accountFingerprint();
      }
    } catch { /* best-effort */ }
    this._bindLedger(account);
    return account;
  }

  async _bindLedgerToAccount() {
    return this._bindLedgerFromAdapter(this.adapter);
  }

  // True if an error means the Playwright page/context/browser was closed or
  // crashed (so the rest of the run would fail until we reopen it).
  _isBrowserGone(msg) {
    return /has been closed|Target (page|closed)|browser has been closed|Target closed|crash|Connection closed|Session closed/i.test(
      String(msg || "")
    );
  }

  // Reopen the automation browser (and the property-status browser) after an
  // unexpected close/crash, so the run can keep going. Returns true on success.
  async _recoverBrowser() {
    if (this._control === "stopping") return false;
    this.emitState("Browser closed unexpectedly — reopening and continuing…");
    try {
      try { await this.adapter.close(); } catch { /* already gone */ }
      this.adapter = this.adapterFactory();
      await this.adapter.launch();
      if (this.checkPropertyStatus) {
        try { if (this.statusAdapter) await this.statusAdapter.close(); } catch { /* ignore */ }
        this.statusAdapter = this.statusAdapterFactory();
        await this.statusAdapter.launch();
      }
      this.emitState("Browser reopened — continuing.");
      return true;
    } catch (e) {
      this.emitState(`Could not reopen the browser: ${e.message}. It will be retried on the next run.`);
      return false;
    }
  }

  // --- Per-row SOP processing ----------------------------------------------
  async _processRow(row) {
    const logBase = { row: row.rowNumber, owner: row.ownerName, address: row.propertyAddress, company: row.companySource };
    try {
      // Rule: only text California properties. Skip out-of-state leads (no text)
      // — but still fetch the REI contact link so you can open the contact in
      // REI. Blank state is allowed through (can't confirm).
      const st = String(row.state || "").trim().toUpperCase();
      if (st && !this.allowedStates.has(st)) {
        row.disposition = DISPOSITION.OUT_OF_STATE;
        row.eligibilityStatus = ELIGIBILITY.NOT_ELIGIBLE;
        row.reiMatchStatus = "Skipped (out of state)";
        row.searchMethod = "";
        row.propertyStatus = "";
        row.safetyStatus = "Out of state";
        row.notes = `Property state "${row.state}" is outside California — not texted.`;
        row.errorLog = "";
        // Best-effort: get the REI contact link so it's clickable in the table.
        // Pulled-from-REI rows already have it; spreadsheet rows get a quick
        // lookup (no safety/send work).
        try {
          if (row.reiContactUrl) {
            row.reiMatchStatus = "Found — out of state (not texted)";
          } else {
            const located = await this.adapter.locateContact({
              ownerName: row.ownerName, propertyAddress: row.propertyAddress, city: row.city,
              state: row.state, zip: row.zip, phone: row.phone, email: row.email,
            });
            if (located.contactUrl) row.reiContactUrl = located.contactUrl;
            row.reiMatchStatus = located.matchFound
              ? "Found — out of state (not texted)"
              : "Not found — out of state (not texted)";
          }
        } catch { /* link is best-effort; leave the skip status as-is */ }
        this.logger.log({
          ...logBase,
          complianceResult: "Out of state - skipped",
          matchStatus: row.reiMatchStatus,
          disposition: row.disposition,
          textSent: false,
          notes: row.notes,
        });
        return;
      }

      // Resolve the exact Redfin page for this address (fast JSON lookup) — only
      // when we actually have an address (pulled-from-REI rows don't yet).
      if (this.redfinLinks && !row.propertyStatusUrl && row.propertyAddress) {
        const q = /\d{5}|,/.test(row.propertyAddress)
          ? row.propertyAddress
          : [row.propertyAddress, row.city, row.state, row.zip].filter(Boolean).join(", ");
        row.propertyStatusUrl = await resolveRedfinUrl(q).catch(() => "");
      }

      // Property status (Redfin / PropertyRadar) FIRST (if enabled + we have an
      // address): if sold/listed, skip the REI checks and move on.
      if (this.statusAdapter && row.propertyAddress) {
        const handled = await this._propertyStatusFirst(row, logBase);
        if (handled) return;
      }

      // Pulled-from-REI rows open the contact directly by URL (no search);
      // spreadsheet rows search REI by address/owner/phone/email.
      const { facts, searchMethod, matchStatus } =
        row.fromRei && row.reiContactUrl
          ? await this.adapter.gatherFactsByUrl(row.reiContactUrl)
          : await this.adapter.gatherFacts({
              ownerName: row.ownerName,
              propertyAddress: row.propertyAddress,
              street: row.street,
              city: row.city,
              state: row.state,
              zip: row.zip,
              phone: row.phone,
              email: row.email,
              // Only the sheet's own company (if any). The real company is
              // detected from REI's "From:" persona (EQT/THB) — no default here,
              // so a failed detection can't send the WRONG template.
              companySource: normalizeCompany(row.companySource) || "",
            });

      row.searchMethod = searchMethod;
      row.reiMatchStatus = matchStatus;
      if (facts.contactUrl) row.reiContactUrl = facts.contactUrl;
      // Fill details from REI when the row didn't have them (pulled leads start
      // blank): owner name, phone, email, and property address/city/state/zip.
      if (!row.ownerName && facts.ownerName) row.ownerName = cleanPersonName(facts.ownerName);
      if (!row.phone && facts.phone) row.phone = facts.phone;
      if (!row.email && facts.email) row.email = facts.email;
      if (!row.propertyAddress && facts.propertyAddress) row.propertyAddress = facts.propertyAddress;
      if (!row.city && facts.city) row.city = facts.city;
      if (!row.state && facts.state) row.state = facts.state;
      if (!row.zip && facts.zip) row.zip = facts.zip;

      // California-only, second chance: pulled leads have no state up front, so
      // the early check was skipped. Now that REI gave us the state, enforce it.
      const stNow = String(row.state || "").trim().toUpperCase();
      if (stNow && !this.allowedStates.has(stNow)) {
        row.disposition = DISPOSITION.OUT_OF_STATE;
        row.eligibilityStatus = ELIGIBILITY.NOT_ELIGIBLE;
        row.propertyStatus = "";
        row.safetyStatus = "Out of state";
        row.notes = `Property state "${row.state}" is outside California — not texted.`;
        row.errorLog = "";
        this.logger.log({ ...logBase, complianceResult: "Out of state - skipped", disposition: row.disposition, textSent: false, notes: row.notes });
        return;
      }

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

      // California-only safety: if the state is still UNKNOWN after REI (blank
      // sheet + unparseable REI address), do NOT text blind — hold for review so
      // an out-of-state lead can't slip through. (ALLOW_UNKNOWN_STATE_TEXT=true
      // overrides.)
      if (decision.shouldSend && !this.allowUnknownStateText && !String(row.state || "").trim()) {
        row.disposition = DISPOSITION.NEEDS_REVIEW;
        row.needsManualReview = true;
        row.eligibilityStatus = ELIGIBILITY.NEEDS_REVIEW;
        row.safetyStatus = "State unknown — can't confirm California";
        row.notes = "Property state is unknown (not on the sheet or in REI) — held for review so an out-of-state lead isn't texted by mistake. Set ALLOW_UNKNOWN_STATE_TEXT=true to text unknown-state leads.";
        row.errorLog = "";
        this.logger.log({ ...logBase, complianceResult: "State unknown - held for review", disposition: row.disposition, textSent: false, notes: row.notes });
        return;
      }

      // Bug fix: the property SOLD after our last contact with the lead. Redfin
      // may not flag it "sold" (e.g. the sale is outside the recent window, or it
      // shows as Off Market), but if the recorded sale date is LATER than our
      // last conversation, the deal is done — do NOT text. (A sale BEFORE our
      // last contact means they already owned it when we spoke, so that stays
      // textable.) Only applies when we could read both dates.
      if (decision.shouldSend && row._redfinSoldDateISO && facts.lastConversationAt) {
        const soldT = Date.parse(row._redfinSoldDateISO);
        const lastT = Date.parse(facts.lastConversationAt);
        if (soldT && lastT && soldT >= lastT) {
          row.disposition = DISPOSITION.PROPERTY_SOLD;
          row.eligibilityStatus = ELIGIBILITY.NOT_ELIGIBLE;
          row.propertyStatus = `Sold ${row._redfinSoldDateText} (after last contact)`;
          row.notes = `Redfin shows the property sold (${row._redfinSoldDateText}) AFTER our last contact (${new Date(facts.lastConversationAt).toLocaleDateString()}) — sold since we last spoke, not texted.`;
          row.errorLog = "";
          if (this.writeReiTags && row.reiContactUrl) {
            try { await this._applyTag(row, REVIVAL_TAG[DISPOSITION.PROPERTY_SOLD]); } catch { /* best-effort */ }
          }
          this.logger.log({
            ...logBase,
            searchMethod,
            matchFound: facts.matchFound,
            matchStatus,
            complianceResult: "Sold after last contact - skipped",
            propertyStatus: row.propertyStatus,
            eligibility: row.eligibilityStatus,
            textSent: false,
            disposition: row.disposition,
            notes: row.notes,
          });
          // Record so a re-pull shows it (only when local memory is enabled).
          if (this.useLedgerMemory) {
            this.sentLedger.recordResult({
              contactUrl: row.reiContactUrl,
              phone: facts.phone || row.phone,
              disposition: row.disposition,
              notes: row.notes,
              propertyStatus: row.propertyStatus,
              eligibilityStatus: row.eligibilityStatus,
              reiMatchStatus: row.reiMatchStatus,
              searchMethod: row.searchMethod,
              companySource: facts.companySource || "",
            });
          }
          return;
        }
      }

      let textSent = false;

      // Rule: if this lead was already texted THIS calendar month, don't text
      // it again — mark it and skip the send (checked against the persistent
      // Permanent suppression: a lead whose seller already REPLIED (interested,
      // not interested, opted out, or unclear) must never get another automated
      // revival text — even on a fresh pull in a later month. Route it to the
      // right tab from the stored reply classification.
      if (decision.shouldSend) {
        const sup = this.sentLedger.isSuppressed({ contactUrl: row.reiContactUrl, phone: facts.phone || row.phone });
        if (sup) {
          const cls = sup.suppressClass || "";
          if (cls === "interested") {
            row.activeDeal = true;
            row.activeDealReason = "Seller previously replied with interest — " + (sup.suppressReason || "handled as an active deal");
            row.disposition = DISPOSITION.RECENT_CONTACT;
          } else if (cls === "not_interested") {
            row.disposition = DISPOSITION.NOT_INTERESTED;
          } else if (cls === "needs_review") {
            row.needsManualReview = true;
            row.disposition = DISPOSITION.NEEDS_REVIEW;
          } else {
            row.disposition = DISPOSITION.ALREADY_CONTACTED;
          }
          row.eligibilityStatus = ELIGIBILITY.NOT_ELIGIBLE;
          row.safetyStatus = "Seller replied earlier — not re-texted";
          row.notes = `Seller already replied (${cls || "reply on file"}) — suppressed from further revival texts.`;
          row.errorLog = "";
          this.logger.log({ ...logBase, complianceResult: "Suppressed (seller replied) - skipped", disposition: row.disposition, textSent: false, notes: row.notes });
          return;
        }
      }

      // IN-RUN duplicate guard (always on, no persistence): never text the same
      // contact/phone twice in ONE run — catches duplicate contacts in the list
      // even with local memory off and even if the REI chat read misses.
      if (decision.shouldSend) {
        const dupKeys = this._runDedupKeys(row.reiContactUrl, facts.phone || row.phone);
        if (dupKeys.some((k) => this._sentThisRun.has(k))) {
          row.disposition = DISPOSITION.TEXTED_THIS_MONTH;
          row.eligibilityStatus = ELIGIBILITY.NOT_ELIGIBLE;
          row.safetyStatus = "Duplicate contact — already texted in this run";
          row.notes = "This same contact/phone was already texted earlier in this run (duplicate) — skipped to avoid a second text.";
          row.errorLog = "";
          this.logger.log({ ...logBase, complianceResult: "Duplicate in run - skipped", disposition: row.disposition, textSent: false, notes: row.notes });
          return;
        }
      }

      // ledger, keyed by REI contact id + phone). Only when local memory is on;
      // otherwise decide() already blocks same-month re-texts by reading the
      // LIVE REI chat (facts.revivalSentThisMonth).
      if (decision.shouldSend && this.skipTextedThisMonth && this.useLedgerMemory) {
        const key = { contactUrl: row.reiContactUrl, phone: facts.phone || row.phone };
        // Skip if texted THIS calendar month OR within the last 30 days
        // (rolling) — the latter keeps recently-texted leads out of Available.
        const prevIso = this.sentLedger.sentThisMonth(key) || this.sentLedger.textedWithinDays(key, this.recentTextDays);
        if (prevIso) {
          const when = new Date(prevIso).toLocaleDateString();
          row.disposition = DISPOSITION.TEXTED_THIS_MONTH;
          row.eligibilityStatus = ELIGIBILITY.NOT_ELIGIBLE;
          row.notes = `Already texted recently (${when}) — skipped to avoid a repeat within ${this.recentTextDays} days.`;
          row.errorLog = "";
          this.logger.log({
            ...logBase,
            searchMethod,
            matchFound: facts.matchFound,
            matchStatus,
            complianceResult: "Already texted this month - skipped",
            propertyStatus: row.propertyStatus,
            eligibility: row.eligibilityStatus,
            textSent: false,
            disposition: row.disposition,
            notes: row.notes,
          });
          return;
        }
      }

      if (decision.shouldSend) {
        if (!this.allowLiveSend || this._scanOnly) {
          row.disposition = DISPOSITION.READY_TO_TEXT;
          row.eligibilityStatus = ELIGIBILITY.ELIGIBLE_SEND_BLOCKED;
          row.notes = this._scanOnly
            ? "Available to text — passed every eligibility rule and not texted in the last " + this.recentTextDays + " days. (Eligibility scan; no text sent.)"
            : "Clean & ready, but ALLOW_LIVE_SEND is off. No text sent.";
        } else {
          // Pick a random approved template for this company (rotation avoids
          // carrier spam-blocking from identical copy), then fill {{first_name}}
          // with the contact's first name (or a clean "there" fallback) — never
          // sends a blank or a literal {{first_name}}.
          const template =
            pickApprovedTemplate(facts.companySource || decision.company) || decision.message;
          const outbound = renderMessage(template, facts.ownerName || row.ownerName);
          const result = await this.adapter.sendText(outbound);
          // Record the in-run dedup key on ANY outcome that isn't a definite
          // no-send ("blocked" = Send button never enabled). This covers an
          // actual-but-unconfirmed send so a retry within the run can't double-
          // text. Blocking a legitimate resend is the safe direction.
          if (result && !result.blocked) {
            this._runDedupKeys(row.reiContactUrl, facts.phone || row.phone).forEach((k) => this._sentThisRun.add(k));
          }
          if (result && result.blocked) {
            // REI wouldn't let us send (e.g. the contact is opted out — the Send
            // button stays disabled). Record it as Opted Out, not an error.
            row.disposition = DISPOSITION.OPTED_OUT;
            row.eligibilityStatus = ELIGIBILITY.NOT_ELIGIBLE;
            row.safetyStatus = result.reason || "Opted out (REI blocked sending)";
            row.notes = result.reason || "REI would not send (contact appears opted out).";
          } else if (result && result.sent) {
            textSent = true;
            this._runStats.sends += 1;
            this._dailySends += 1; // backend daily hard-cap counter
            row.disposition = DISPOSITION.TEXT_SENT;
            row.eligibilityStatus = ELIGIBILITY.ELIGIBLE_TEXT_SENT;
            row.textSentTimestamp = result.timestamp;
            // Save the EXACT text sent so the Recheck can verify the right
            // message (templates rotate + {{first_name}} is filled per lead).
            row.sentMessageBody = outbound;
            row.messageDeliveryStatus = "Sent"; // confirmed present in REI chat
            row.notes = "Live text sent successfully";
            // Record in the monthly ledger (only when local memory is enabled).
            // With no memory, the REI chat itself is the record of the send.
            if (this.useLedgerMemory) {
              this.sentLedger.record({
                contactUrl: row.reiContactUrl,
                phone: facts.phone || row.phone,
                company: facts.companySource || decision.company || "",
                iso: result.timestamp,
              });
            }
            if (this.writeReiTags) await this._applyTag(row, REVIVAL_TAG[DISPOSITION.TEXT_SENT]);
          } else {
            // Text was NOT sent (couldn't confirm / couldn't open chat / etc.).
            // Per Juan: mark Needs Review, not Error. Retried on a later run
            // (the history check prevents a duplicate if it did go out).
            row.disposition = DISPOSITION.NEEDS_REVIEW;
            row.eligibilityStatus = ELIGIBILITY.NEEDS_REVIEW;
            row.notes = (result && result.reason) || "Text was not sent — needs review.";
            row.errorLog = "";
          }
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
    } finally {
      // Stamp when this lead was worked (drives the "Today" report) and, if it
      // reached a final result, remember it for the month so a fresh REI pull
      // shows it in the dashboard and skips re-checking it.
      row.processedAt = new Date().toISOString();
      try {
        if (this.store.isProcessed(row)) this._rememberResult(row);
      } catch { /* memory is best-effort */ }
    }
  }

  // Save a finished lead's result to the monthly memory (keyed by REI contact
  // id + phone) so it persists across runs, uploads, and REI pulls.
  _rememberResult(row) {
    if (!this.useLedgerMemory) return; // no local memory — nothing is remembered
    this.sentLedger.recordResult({
      contactUrl: row.reiContactUrl,
      phone: row.phone,
      reiContactUrl: row.reiContactUrl,
      disposition: row.disposition,
      notes: row.notes,
      propertyStatus: row.propertyStatus,
      propertyStatusUrl: row.propertyStatusUrl,
      eligibilityStatus: row.eligibilityStatus,
      reiMatchStatus: row.reiMatchStatus,
      reiTagApplied: row.reiTagApplied,
      safetyStatus: row.safetyStatus,
      searchMethod: row.searchMethod,
      companySource: row.companySource,
      textedIso: row.disposition === DISPOSITION.TEXT_SENT ? (row.textSentTimestamp || row.processedAt) : "",
      textSentTimestamp: row.textSentTimestamp,
      checkedIso: row.processedAt,
    });
  }

  // Pre-fill rows from the monthly memory: any lead already worked THIS month
  // gets its stored result copied onto the row (so it shows in the dashboard)
  // and is marked done (so it's skipped, not re-checked). Only rows still
  // Pending are touched. Returns how many were pre-filled.
  applyMonthlyMemory(rows) {
    if (!this.useLedgerMemory) return 0; // no local memory — never pre-fill
    let filled = 0;
    for (const row of rows) {
      if (row.disposition && row.disposition !== DISPOSITION.PENDING) continue;
      const e = this.sentLedger.resultThisMonth({ contactUrl: row.reiContactUrl, phone: row.phone });
      if (!e) continue;
      row.disposition = e.disposition || row.disposition;
      row.notes = e.notes || row.notes;
      row.reiContactUrl = e.reiContactUrl || row.reiContactUrl || "";
      row.propertyStatus = e.propertyStatus || row.propertyStatus || "";
      row.propertyStatusUrl = e.propertyStatusUrl || row.propertyStatusUrl || "";
      row.eligibilityStatus = e.eligibilityStatus || row.eligibilityStatus;
      row.reiMatchStatus = e.reiMatchStatus || row.reiMatchStatus;
      row.reiTagApplied = e.reiTagApplied || row.reiTagApplied || "";
      row.safetyStatus = e.safetyStatus || row.safetyStatus || "";
      row.searchMethod = e.searchMethod || row.searchMethod || "";
      row.companySource = e.companySource || row.companySource || "";
      row.textSentTimestamp = e.textSentTimestamp || row.textSentTimestamp || "";
      row.processedAt = e.checkedIso || "";
      row.fromMemory = true;
      filled += 1;
    }
    return filled;
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
    // Remember any sold date Redfin reported — even for an off-market property
    // whose sale is outside the "recent" window — so the post-facts step can
    // compare it against our last contact date.
    if (pr && pr.soldDateISO) { row._redfinSoldDateISO = pr.soldDateISO; row._redfinSoldDateText = pr.soldDate || ""; }
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
