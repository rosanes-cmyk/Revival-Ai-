// Persistent record of who was texted and when — used to enforce the rule:
// "if a lead was already texted THIS calendar month, don't text it again."
//
// The ledger survives restarts, fresh spreadsheet uploads, and "Pull all from
// REI" runs, so a lead texted earlier in the month is skipped even if it shows
// up again from a different source. Keyed by BOTH the REI contact id (from the
// contact URL) and the normalized phone number, so a match on either blocks a
// resend. Stored in the writable data dir alongside job state.

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

  /**
   * If this lead was already texted in the SAME calendar month as `when`,
   * return the ISO timestamp of that send; otherwise return null.
   */
  sentThisMonth({ contactUrl, phone }, when = new Date()) {
    const wantMonth = monthKey(when);
    for (const key of keysFor({ contactUrl, phone })) {
      const entry = this.map[key];
      if (entry && entry.iso) {
        try {
          if (monthKey(new Date(entry.iso)) === wantMonth) return entry.iso;
        } catch {
          /* ignore bad entry */
        }
      }
    }
    return null;
  }

  /** Record a confirmed send. Writes under every available key. */
  record({ contactUrl, phone, company, iso }) {
    const stamp = iso || new Date().toISOString();
    const keys = keysFor({ contactUrl, phone });
    if (!keys.length) return;
    for (const key of keys) {
      this.map[key] = { iso: stamp, company: company || "" };
    }
    this._save();
  }
}
