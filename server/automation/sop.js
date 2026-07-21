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
  OPTOUT_REGEX,
  DO_NOT_AUTOMATE_REGEX,
} from "./constants.js";
import { RECENT_CONVERSATION_DAYS } from "./constants.js";
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

  // Safety: if the record can't be fully read, we can't confirm it's clean, so
  // we never text it. Per Juan's instruction, mark these "Lead NOT Found"
  // (incomplete info) rather than "Needs Review".
  if (facts.uncertain) {
    return out(DISPOSITION.LEAD_NOT_FOUND, {
      eligibility: ELIGIBILITY.NOT_ELIGIBLE,
      notes: facts.uncertainReason || "Could not read the full contact record; nothing sent.",
      complianceResult: "Incomplete info - not found",
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
      [DISPOSITION.BAD_LEAD]: "Bad lead",
    };
    const label = labels[safety.outcome] || "Blocked";
    const extra = { eligibility: elig, safetySummary: safety.reason, notes: safety.reason,
      complianceResult: `${label}: ${safety.reason}` };
    if (safety.outcome === DISPOSITION.PROPERTY_SOLD) extra.propertyStatus = "Sold (tag)";
    if (safety.outcome === DISPOSITION.LISTED) extra.propertyStatus = "Listed (tag)";
    return out(safety.outcome, extra);
  }

  // Active-deal tags (appointment booked / offer sent): only re-engage if the
  // conversation has gone COLD (~a month+). If there was contact within the
  // month — or we can't confirm it's stale — skip, so we don't step on an
  // active negotiation.
  if (facts.activeDealTag) {
    if (facts.lastConversationWithinMonth !== false) {
      const when = facts.lastConversationAt ? ` (last contact ${String(facts.lastConversationAt).slice(0, 10)})` : "";
      return out(DISPOSITION.RECENT_CONTACT, {
        eligibility: ELIGIBILITY.NOT_ELIGIBLE,
        notes: `Appointment-booked / offer-sent lead with recent or unconfirmed conversation${when} — skipped so the revival text doesn't interfere with an active deal.`,
        complianceResult: "Active deal - recent contact (skip)",
      });
    }
    // Cold for ~a month+: allow the revival text to re-engage (fall through).
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
    return out(DISPOSITION.LEAD_NOT_FOUND, {
      eligibility: ELIGIBILITY.NOT_ELIGIBLE,
      notes: "No usable phone number found on the REI contact.",
      complianceResult: "No phone - not found",
    });
  }
  const company = normalizeCompany(facts.companySource);
  const message = getApprovedMessage(facts.companySource);
  if (!company || !message) {
    // Could not determine EQT vs THB from REI. Do NOT guess a template — hold
    // for review so the wrong company's message is never sent.
    return out(DISPOSITION.NEEDS_REVIEW, {
      eligibility: ELIGIBILITY.NEEDS_REVIEW,
      notes: "Could not tell if this is a Twin Home Buyer (THB) or Equity Track (EQT) contact from REI's 'From:' line — held so the wrong template isn't sent.",
      complianceResult: "Company (EQT/THB) undetermined - held for review",
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

// Outcomes that mean "this contact is bad" (vs. a property-status outcome).
// Two or more distinct bad-contact tags => the whole lead is junk (Bad Lead).
const BAD_CONTACT_OUTCOMES = [
  DISPOSITION.OPTED_OUT,
  DISPOSITION.NOT_INTERESTED,
  DISPOSITION.WRONG_NUMBER,
];

/**
 * Evaluate bad tags then blocking history phrases.
 * Returns {outcome, reason, badTags} where badTags lists every matched tag.
 * If two or more distinct bad-contact tags are present, the outcome is
 * escalated to Bad Lead (SOP: clearly a junk lead to delete).
 */
export function evaluateSafety(tags, historyText) {
  // Combine tags + notes + conversation history into one text to scan (the
  // suppression spec: read all three together).
  const tagText = (tags || []).join("  |  ");
  const combined = `${tagText}\n${historyText || ""}`;
  const lower = combined.toLowerCase();

  // 0) Do Not Automate — highest precedence. Skip the lead entirely.
  if (DO_NOT_AUTOMATE_REGEX.test(lower)) {
    return { outcome: DISPOSITION.OPTED_OUT, reason: "Do Not Automate — suppressed", badTags: [] };
  }

  // Collect every bad tag that matches, remembering its rule outcome.
  const hits = [];
  const seen = new Set();
  for (const rule of SAFETY_TAG_RULES) {
    for (const tag of tags) {
      if (!tag.toLowerCase().includes(rule.match)) continue;
      const key = tag.toLowerCase();
      if (seen.has(key)) continue; // one entry per distinct tag
      seen.add(key);
      hits.push({ tag, outcome: rule.outcome });
    }
  }

  if (hits.length) {
    // Two or more distinct bad-CONTACT tags => Bad Lead (junk to delete).
    const badContact = hits.filter((h) => BAD_CONTACT_OUTCOMES.includes(h.outcome));
    if (badContact.length >= 2) {
      return {
        outcome: DISPOSITION.BAD_LEAD,
        reason: `Multiple bad tags: ${badContact.map((h) => h.tag).join(", ")}`,
        badTags: badContact.map((h) => h.tag),
      };
    }
    // Otherwise the first matching rule wins (list is in precedence order).
    const first = hits[0];
    return { outcome: first.outcome, reason: `Tag: ${first.tag}`, badTags: hits.map((h) => h.tag) };
  }

  // Broad opt-out / do-not-contact anywhere in tags + notes + history.
  const optMatch = lower.match(OPTOUT_REGEX);
  if (optMatch) {
    return { outcome: DISPOSITION.OPTED_OUT, reason: `Opt-out signal: "${optMatch[0].trim()}"`, badTags: [] };
  }
  // A standalone, uppercase STOP is a lead's SMS opt-out — but ignore the
  // instructional footer ("reply STOP to opt out") that appears in outbound.
  if (detectStopReply(combined)) {
    return { outcome: DISPOSITION.OPTED_OUT, reason: "SMS opt-out: STOP reply", badTags: [] };
  }

  // Remaining blocking phrases in history (SOP step 10), in precedence order.
  for (const outcome of [DISPOSITION.OPTED_OUT, DISPOSITION.NOT_INTERESTED, DISPOSITION.WRONG_NUMBER]) {
    for (const phrase of BLOCKING_PHRASES[outcome]) {
      if (containsPhrase(lower, phrase)) return { outcome, reason: `History phrase: "${phrase}"`, badTags: [] };
    }
  }
  return { outcome: null, reason: "", badTags: [] };
}

/**
 * True if the text contains a genuine standalone uppercase "STOP" (a lead's SMS
 * opt-out reply), excluding the instructional footer wording found in outbound
 * messages ("reply STOP to opt out", "text STOP to unsubscribe", etc.).
 */
function detectStopReply(text) {
  const t = String(text || "");
  const re = /(?:^|[^A-Za-z])STOP(?:[^A-Za-z]|$)/g;
  let m;
  while ((m = re.exec(t)) !== null) {
    const ctx = t.slice(Math.max(0, m.index - 22), m.index + 26).toLowerCase();
    if (/reply stop|text stop|send stop|stop to (?:opt|unsub|stop)|'stop'|"stop"/.test(ctx)) continue;
    return true;
  }
  return false;
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
