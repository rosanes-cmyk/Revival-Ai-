// Persistent monthly memory of every lead we've worked this month.
//
// Two jobs:
//   1. Enforce "don't text the same lead twice in one calendar month."
//   2. Remember each lead's LAST result this month so a fresh "Pull all from
//      REI" (or restart) can show the already-checked leads in the dashboard
//      WITH their results and skip re-checking them — only new leads get worked.
//
// Keyed by BOTH the REI contact id (from the contact URL) and the normalized
// phone number, so a match on either is enough. Stored in the writable data
// dir alongside job state. Entries are scoped by month: anything from a prior
// month is ignored, so the campaign starts fresh each month automatically.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = process.env.REVIVAL_DATA_DIR
  ? path.join(process.env.REVIVAL_DATA_DIR, "state")
  : path.join(__dirname, "..", "..", "data", "state");
fs.mkdirSync(STATE_DIR, { recursive: true });
const LEDGER_FILE = path.join(STATE_DIR, "sent-ledger.json");

// SHARED MEMORY across computers: if a shared folder is configured (a synced
// OneDrive/Dropbox folder, or a network drive both PCs can see), the sent
// record lives THERE so every computer knows who the others have already
// texted. Set via SHARED_LEDGER_DIR, or a small config file both the app and
// this module read. Falls back to the local per-PC folder when not configured.
const SHARED_DIR_CONFIG = path.join(STATE_DIR, "shared-dir.txt");
export function getConfiguredSharedDir() {
  const env = String(process.env.SHARED_LEDGER_DIR || "").trim();
  if (env) return env;
  try {
    const v = fs.readFileSync(SHARED_DIR_CONFIG, "utf8").trim();
    return v || "";
  } catch {
    return "";
  }
}
export function setConfiguredSharedDir(dir) {
  const v = String(dir || "").trim();
  if (!v) { try { fs.unlinkSync(SHARED_DIR_CONFIG); } catch { /* already gone */ } return { ok: true, sharedDir: "" }; }
  // Verify we can actually create/write in the folder before saving it.
  fs.mkdirSync(v, { recursive: true });
  const probe = path.join(v, ".revival-write-test");
  fs.writeFileSync(probe, "ok");
  fs.unlinkSync(probe);
  fs.writeFileSync(SHARED_DIR_CONFIG, v);
  return { ok: true, sharedDir: v };
}
// Where a ledger file for `namespace` should live right now.
function ledgerDirFor() {
  const shared = getConfiguredSharedDir();
  if (shared) {
    try { fs.mkdirSync(shared, { recursive: true }); return shared; } catch { /* fall back */ }
  }
  return STATE_DIR;
}

// Keep the later of two ISO timestamps (so the 30-day window is always measured
// from the MOST RECENT send across all computers).
function laterIso(a, b) {
  const ta = Date.parse(a || "") || 0;
  const tb = Date.parse(b || "") || 0;
  if (!ta) return b || "";
  if (!tb) return a || "";
  return ta >= tb ? a : b;
}
// Merge two ledger entries for the same lead without losing either PC's info.
function mergeEntry(x, y) {
  if (!x) return y;
  if (!y) return x;
  return {
    ...x, ...y,
    textedIso: laterIso(x.textedIso, y.textedIso),   // most-recent send wins
    checkedIso: laterIso(x.checkedIso, y.checkedIso),
    doNotText: !!(x.doNotText || y.doNotText),         // either PC suppressing = suppressed
    suppressClass: y.suppressClass || x.suppressClass || "",
    suppressReason: y.suppressReason || x.suppressReason || "",
    textSentTimestamp: laterIso(x.textSentTimestamp, y.textSentTimestamp),
  };
}
// Merge two whole ledger maps by key.
function mergeMaps(a, b) {
  const out = { ...(a || {}) };
  for (const k of Object.keys(b || {})) out[k] = mergeEntry(out[k], b[k]);
  return out;
}

function normalizePhone(phone) {
  const d = String(phone || "").replace(/\D+/g, "");
  if (!d) return "";
  // Drop a leading US country code so "+1 510..." and "510..." match.
  return d.length === 11 && d.startsWith("1") ? d.slice(1) : d;
}

function contactId(contactUrl) {
  const m = String(contactUrl || "").match(/\/contacts\/(\d+)/i);
  return m ? m[1] : "";
}

function keysFor({ contactUrl, phone }) {
  const keys = [];
  const id = contactId(contactUrl);
  if (id) keys.push(`c:${id}`);
  const p = normalizePhone(phone);
  if (p) keys.push(`p:${p}`);
  return keys;
}

// "2026-07" style month stamp for a given Date.
function monthKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function sameMonth(iso, when) {
  if (!iso) return false;
  try {
    return monthKey(new Date(iso)) === monthKey(when);
  } catch {
    return false;
  }
}

export class SentLedger {
  // `namespace` scopes the memory to a specific REI account, so opening a
  // DIFFERENT REI account uses a DIFFERENT file — the saved data from one
  // account can never be reused for another. Empty namespace = the default
  // shared file (back-compat, e.g. spreadsheet uploads before login).
  constructor(namespace = "") {
    const ns = String(namespace || "").replace(/[^a-z0-9._-]+/gi, "_").slice(0, 80);
    this.namespace = ns;
    this.map = {};
    this._resolveFile();
    this._readFromDisk();
  }

  // The ledger file path can change at runtime (when a shared folder is set), so
  // resolve it fresh from the current shared-dir config each time we touch disk.
  _resolveFile() {
    const dir = ledgerDirFor();
    this.file = this.namespace
      ? path.join(dir, `sent-ledger-${this.namespace}.json`)
      : path.join(dir, "sent-ledger.json");
    return this.file;
  }

  _readFromDisk() {
    this._resolveFile();
    try {
      if (fs.existsSync(this.file)) {
        const onDisk = JSON.parse(fs.readFileSync(this.file, "utf8")) || {};
        this.map = mergeMaps(this.map, onDisk); // merge, never drop in-memory
      }
    } catch { /* partial/locked file mid-sync — keep what we have */ }
  }

  // Pull in anything other computers wrote to the shared file since we last
  // looked. Call before a duplicate check so a send on PC #2 is seen by PC #1.
  reload() {
    this._readFromDisk();
    return this;
  }

  _save() {
    try {
      this._resolveFile();
      // MERGE-ON-SAVE: re-read the shared file and combine, so two computers
      // writing to the same folder never clobber each other's records.
      let onDisk = {};
      try { if (fs.existsSync(this.file)) onDisk = JSON.parse(fs.readFileSync(this.file, "utf8")) || {}; } catch { onDisk = {}; }
      this.map = mergeMaps(onDisk, this.map);
      const tmp = this.file + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(this.map));
      fs.renameSync(tmp, this.file); // atomic-ish swap so readers never see a half-written file
    } catch (err) {
      console.error("[sentLedger] failed to save:", err.message);
    }
  }

  _lookup({ contactUrl, phone }) {
    for (const key of keysFor({ contactUrl, phone })) {
      if (this.map[key]) return this.map[key];
    }
    return null;
  }

  /**
   * If this lead was already TEXTED in the same calendar month as `when`,
   * return the ISO timestamp of that send; otherwise null.
   */
  sentThisMonth({ contactUrl, phone }, when = new Date()) {
    const e = this._lookup({ contactUrl, phone });
    return e && sameMonth(e.textedIso, when) ? e.textedIso : null;
  }

  /**
   * If this lead was CHECKED (worked at all) in the same calendar month as
   * `when`, return its stored result entry; otherwise null. Used to pre-fill
   * the dashboard and skip re-checking on a fresh REI pull.
   */
  resultThisMonth({ contactUrl, phone }, when = new Date()) {
    const e = this._lookup({ contactUrl, phone });
    return e && sameMonth(e.checkedIso, when) ? e : null;
  }

  /**
   * If this lead was actually TEXTED within the last `days` days (rolling, not
   * calendar month), return that ISO timestamp; otherwise null. Used for the
   * "Available to Text" 30-day rule.
   */
  textedWithinDays({ contactUrl, phone }, days = 30, now = new Date()) {
    const e = this._lookup({ contactUrl, phone });
    if (!e || !e.textedIso) return null;
    const t = Date.parse(e.textedIso);
    if (!t) return null;
    const ageMs = now.getTime() - t;
    return ageMs >= 0 && ageMs <= days * 86400000 ? e.textedIso : null;
  }

  /**
   * How many DISTINCT leads were actually texted on the same calendar DAY as
   * `when`. Persists across runs/restarts, so the backend daily send cap holds
   * even if the app is restarted mid-day. Deduped by contact-url + timestamp
   * (each send writes two keys — one per contact id and phone).
   */
  textedCountOn(when = new Date()) {
    const dayKey = (iso) => {
      try { const d = new Date(iso); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; }
      catch { return ""; }
    };
    const target = dayKey(when.toISOString());
    const seen = new Set();
    for (const e of Object.values(this.map)) {
      if (!e || !e.textedIso) continue;
      if (dayKey(e.textedIso) !== target) continue;
      seen.add(`${e.reiContactUrl || ""}|${e.textedIso}`);
    }
    return seen.size;
  }

  /**
   * Permanently suppress a lead from FUTURE automated revival texts (across
   * months / re-pulls). Used when a seller replied (interested, not interested,
   * opt-out, or unclear) — a human/team takes over from there. Stores the
   * classification so a later pull can route the lead to the right tab.
   */
  suppress({ contactUrl, phone, classification, reason }) {
    const keys = keysFor({ contactUrl, phone });
    if (!keys.length) {
      console.warn("[sentLedger] suppress skipped — no contact URL or phone to key on (reply not persisted).");
      return;
    }
    for (const key of keys) {
      const prev = this.map[key] || {};
      this.map[key] = {
        ...prev,
        doNotText: true,
        suppressClass: classification || prev.suppressClass || "",
        suppressReason: reason || prev.suppressReason || "",
        suppressedAt: new Date().toISOString(),
      };
    }
    this._save();
  }

  /** If this lead is permanently suppressed, return its entry; else null. */
  isSuppressed({ contactUrl, phone }) {
    const e = this._lookup({ contactUrl, phone });
    return e && e.doNotText ? e : null;
  }

  /**
   * Record a confirmed send (back-compat helper). Sets both the texted and
   * checked timestamps.
   */
  record({ contactUrl, phone, company, iso }) {
    const stamp = iso || new Date().toISOString();
    this.recordResult({
      contactUrl,
      phone,
      companySource: company || "",
      textedIso: stamp,
      checkedIso: stamp,
      textSentTimestamp: stamp,
      disposition: "Text Sent",
    });
  }

  /**
   * Record the full result of working a lead. Writes under every available
   * key. `checkedIso` defaults to now; `textedIso` is only set when the lead
   * was actually texted (pass it, or it's preserved from a prior entry).
   */
  recordResult(result) {
    const { contactUrl, phone } = result;
    const keys = keysFor({ contactUrl, phone });
    if (!keys.length) return;
    const now = new Date().toISOString();
    const checkedIso = result.checkedIso || now;
    for (const key of keys) {
      const prev = this.map[key] || {};
      this.map[key] = {
        checkedIso,
        // Keep any earlier texted timestamp unless a new one is given.
        textedIso: result.textedIso || prev.textedIso || "",
        disposition: result.disposition || prev.disposition || "",
        notes: result.notes || "",
        reiContactUrl: result.reiContactUrl || prev.reiContactUrl || "",
        propertyStatus: result.propertyStatus || "",
        propertyStatusUrl: result.propertyStatusUrl || prev.propertyStatusUrl || "",
        eligibilityStatus: result.eligibilityStatus || "",
        reiMatchStatus: result.reiMatchStatus || "",
        reiTagApplied: result.reiTagApplied || "",
        safetyStatus: result.safetyStatus || "",
        searchMethod: result.searchMethod || "",
        companySource: result.companySource || prev.companySource || "",
        textSentTimestamp: result.textSentTimestamp || prev.textSentTimestamp || "",
      };
    }
    this._save();
  }
}
