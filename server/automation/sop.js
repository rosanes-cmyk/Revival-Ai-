// SOP rule engine.
//
// Pure decision logic: given the facts gathered from REI BlackBook for one
// lead, decide the disposition, which REI tag to apply, and whether to send —
// and if so, which company-specific approved message. Keeping this separate
// from the browser automation makes the rules auditable and unit-testable, and
// concentrates every safety rule in one place.

import {
  DISPOSITION,
  ELIGIBILITY,
  REVIVAL_TAG,
  SAFETY_TAG_RULES,
  BLOCKING_PHRASES,
  FAILED_MARKERS,
} from "./constants.js";
import { getApprovedMessage, normalizeCompany } from "./message.js";

/**
 * @typedef {Object} LeadFacts
 * @property {boolean}  matchFound
 * @property {string}   matchStatus
 * @property {string[]} tags               All tag chips read off the contact.
 * @property {boolean}  propertySold
 * @property {string}   soldDate
 * @property {boolean}  propertyListed
 * @property {string}   mlsNote
 * @property {boolean}  phoneExists        A usable phone on the REI contact.
 * @property {string}   historyText        Notes/activity/chat/SMS text (raw).
 * @property {boolean}  lastMessageFailed  Latest outbound failed/undelivered.
 * @property {boolean}  alreadySentApproved Approved msg already in history.
 * @property {string}   companySource      Raw company-source from the sheet.
 * @property {boolean}  uncertain
 * @property {string}   uncertainReason
 */

/**
 * Decide the outcome for one lead. Never sends anything itself.
 * @param {LeadFacts} facts
 * @returns {{disposition:string, tag:string, eligibility:string, notes:string,
 *            propertyStatus:string, safetySummary:string, message:(string|null),
 *            shouldSend:boolean, complianceResult:string}}
 */
export function decide(facts) {
  const base = {
    disposition: DISPOSITION.PENDING,
    tag: "",
    eligibility: ELIGIBILITY.PENDING,
    notes: "",
    propertyStatus: describePropertyStatus(facts),
    safetySummary: "",
    message: null,
    shouldSend: false,
    complianceResult: "",
  };
  const out = (d, extra = {}) => ({ ...base, disposition: d, tag: REVIVAL_TAG[d] || "", ...extra });

  // Safety: anything uncertain is held for review — never texted (SOP step 16).
  if (facts.uncertain) {
    return out(DISPOSITION.NEEDS_REVIEW, {
      eligibility: ELIGIBILITY.NEEDS_REVIEW,
      notes: facts.uncertainReason || "System could not confirm the record.",
      complianceResult: "Uncertain - held for review",
    });
  }

  // Step 4: no matching lead found after all search methods.
  if (!facts.matchFound) {
    return out(DISPOSITION.LEAD_NOT_FOUND, {
      eligibility: ELIGIBILITY.NOT_ELIGIBLE,
      notes: "Address/owner/phone/email searched. No matching REI lead found.",
      complianceResult: "No match",
    });
  }

  // Step 7: property sold.
  if (facts.propertySold) {
    return out(DISPOSITION.PROPERTY_SOLD, {
      eligibility: ELIGIBILITY.NOT_ELIGIBLE,
      notes: facts.soldDate ? `Sold date: ${facts.soldDate}` : "",
      propertyStatus: facts.soldDate ? `Sold (${facts.soldDate})` : "Sold",
      complianceResult: "Property sold",
    });
  }

  // Step 8: property listed.
  if (facts.propertyListed) {
    return out(DISPOSITION.LISTED, {
      eligibility: ELIGIBILITY.NOT_ELIGIBLE,
      notes: facts.mlsNote ? `Active MLS Listing. ${facts.mlsNote}` : "Active MLS Listing",
      propertyStatus: "Listed (Active MLS)",
      complianceResult: "Property listed",
    });
  }

  // Steps 9-13: contact safety — bad tags first, then blocking phrases in
  // history. Precedence: opt-out > not interested > wrong number.
  const safety = evaluateSafety(facts.tags || [], facts.historyText || "");
  if (safety.outcome) {
    const elig = ELIGIBILITY.NOT_ELIGIBLE;
    const labels = {
      [DISPOSITION.OPTED_OUT]: "Opt-out",
      [DISPOSITION.NOT_INTERESTED]: "Not interested",
      [DISPOSITION.WRONG_NUMBER]: "Wrong number",
      [DISPOSITION.PROPERTY_SOLD]: "Property sold",
      [DISPOSITION.LISTED]: "Property listed",
    };
    const label = labels[safety.outcome] || "Blocked";
    const extra = { eligibility: elig, safetySummary: safety.reason, notes: safety.reason,
      complianceResult: `${label}: ${safety.reason}` };
    if (safety.outcome === DISPOSITION.PROPERTY_SOLD) extra.propertyStatus = "Sold (tag)";
    if (safety.outcome === DISPOSITION.LISTED) extra.propertyStatus = "Listed (tag)";
    return out(safety.outcome, extra);
  }

  // Step 14: latest outbound failed / undelivered.
  if (facts.lastMessageFailed) {
    return out(DISPOSITION.FAILED_NUMBER, {
      eligibility: ELIGIBILITY.NOT_ELIGIBLE,
      notes: "Latest message failed or was undelivered.",
      complianceResult: "Failed/undelivered number",
    });
  }

  // Step 15: same approved message already sent before.
  if (facts.alreadySentApproved) {
    return out(DISPOSITION.ALREADY_CONTACTED, {
      eligibility: ELIGIBILITY.NOT_ELIGIBLE,
      notes: "Approved revival message was already sent to this lead.",
      complianceResult: "Already contacted",
    });
  }

  // Step 17 clean conditions: a usable phone must exist and the company source
  // must be one of the two approved senders (so we know which message to send).
  if (!facts.phoneExists) {
    return out(DISPOSITION.NEEDS_REVIEW, {
      eligibility: ELIGIBILITY.NEEDS_REVIEW,
      notes: "No usable phone number found on the REI contact.",
      complianceResult: "No phone - held for review",
    });
  }
  const company = normalizeCompany(facts.companySource);
  const message = getApprovedMessage(facts.companySource);
  if (!company || !message) {
    return out(DISPOSITION.NEEDS_REVIEW, {
      eligibility: ELIGIBILITY.NEEDS_REVIEW,
      notes: `Company Source "${facts.companySource || "(blank)"}" is not Twin Home Buyer or Equity Track Inc.; cannot choose an approved message.`,
      complianceResult: "Unknown company source - held for review",
    });
  }

  // Step 18: clean — ready to text with the correct company message.
  return {
    ...base,
    disposition: DISPOSITION.READY_TO_TEXT,
    tag: "", // the send-success tag (Revival - Text Sent) is applied after send
    eligibility: ELIGIBILITY.READY_TO_TEXT,
    notes: "",
    message,
    shouldSend: true,
    complianceResult: `Clean - ready to text (${company})`,
  };
}

/** Evaluate bad tags then blocking history phrases. Returns {outcome, reason}. */
export function evaluateSafety(tags, historyText) {
  // Bad tags first (SOP step 9).
  for (const rule of SAFETY_TAG_RULES) {
    const hit = tags.find((t) => t.toLowerCase().includes(rule.match));
    if (hit) return { outcome: rule.outcome, reason: `Tag: ${hit}` };
  }
  // Blocking phrases in history (SOP step 10), in precedence order.
  const text = String(historyText || "").toLowerCase();
  for (const outcome of [DISPOSITION.OPTED_OUT, DISPOSITION.NOT_INTERESTED, DISPOSITION.WRONG_NUMBER]) {
    for (const phrase of BLOCKING_PHRASES[outcome]) {
      if (containsPhrase(text, phrase)) return { outcome, reason: `History phrase: "${phrase}"` };
    }
  }
  return { outcome: null, reason: "" };
}

/** Whole-word / phrase match to avoid false hits like "stop" in "stopwatch". */
function containsPhrase(text, phrase) {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`, "i").test(text);
}

/** Detect failed/undelivered markers in the latest-message text. */
export function detectFailed(latestMessageText) {
  const text = String(latestMessageText || "").toLowerCase();
  return FAILED_MARKERS.some((m) => text.includes(m));
}

function describePropertyStatus(facts) {
  if (facts.propertySold) return facts.soldDate ? `Sold (${facts.soldDate})` : "Sold";
  if (facts.propertyListed) return "Listed (Active MLS)";
  if (!facts.matchFound) return "Unknown (no match)";
  return "Not sold / not listed";
}
