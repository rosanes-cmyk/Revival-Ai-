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
  constructor() {
    this.map = {};
    try {
      if (fs.existsSync(LEDGER_FILE)) {
        this.map = JSON.parse(fs.readFileSync(LEDGER_FILE, "utf8")) || {};
      }
    } catch {
      this.map = {};
    }
  }

  _save() {
    try {
      fs.writeFileSync(LEDGER_FILE, JSON.stringify(this.map));
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
