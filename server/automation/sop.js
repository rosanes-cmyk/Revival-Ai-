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
import { RECENT_CONVERSATION_DAYS, MIN_DAYS_BETWEEN_TEXTS } from "./constants.js";
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

  // Step 15: approved revival message already in REI's chat (read from the
  // actual logged-in account, never a local file). Rule: only block WITHIN THE
  // SAME calendar month. A send from a prior month is allowed to re-engage this
  // month (monthly re-engagement).
  if (facts.alreadySentApproved) {
    // How many days ago was our revival text (from the REI chat date)?
    let ageDays = null;
    if (facts.revivalSentAt) {
      const t = new Date(facts.revivalSentAt).getTime();
      if (t) ageDays = (Date.now() - t) / 86400000;
    }
    const withinMinDays = ageDays !== null && ageDays >= 0 && ageDays <= MIN_DAYS_BETWEEN_TEXTS;
    if (facts.revivalSentThisMonth || withinMinDays) {
      // Sent this calendar month OR within the last MIN_DAYS_BETWEEN_TEXTS days
      // (rolling) → skip. The 30-day rule holds even across a month boundary.
      return out(DISPOSITION.TEXTED_THIS_MONTH, {
        eligibility: ELIGIBILITY.NOT_ELIGIBLE,
        notes: facts.revivalSentAt
          ? `Texted ${fmtSentAgo(facts.revivalSentAt)} per REI chat — skipped (within ${MIN_DAYS_BETWEEN_TEXTS} days).`
          : "REI chat shows the revival text was already sent recently — skipped to avoid a repeat.",
        complianceResult: "Texted recently (per REI) - skipped",
      });
    }
    if (ageDays === null) {
      // Message is present but we could NOT read a usable date next to it (empty
      // OR unparseable), so we can't prove enough time has passed. Don't risk a
      // duplicate — skip.
      return out(DISPOSITION.ALREADY_CONTACTED, {
        eligibility: ELIGIBILITY.NOT_ELIGIBLE,
        notes: "REI chat shows the revival text was already sent (date unreadable) — skipped to be safe against a repeat.",
        complianceResult: "Already contacted (undated)",
      });
    }
    // Otherwise it was sent more than MIN_DAYS_BETWEEN_TEXTS days ago → allowed
    // to re-engage. Fall through and continue the remaining checks.
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

// Format a sent-timestamp as "Aug 8, 2026 (2 days ago)" for skip notes.
function fmtSentAgo(iso) {
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso || "");
    const date = d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
    const days = Math.floor((Date.now() - d.getTime()) / 86400000);
    const ago = days <= 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`;
    return `${date} (${ago})`;
  } catch {
    return String(iso || "");
  }
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

// ---------------------------------------------------------------------------
// Reply classification (used by Recheck Text Sent). Classifies a seller's
// inbound reply into: interested | not_interested | needs_review. Never relies
// on a single isolated keyword when the wider message flips its meaning: if a
// reply carries BOTH clear positive and clear negative intent, it is
// needs_review. STOP / opt-out language ALWAYS routes to not_interested with
// suppression so the existing opt-out protections fire.
// ---------------------------------------------------------------------------
const INTERESTED_PHRASES = [
  "i am interested", "i'm interested", "im interested", "still interested",
  "i want to sell", "want to sell", "i may sell", "i might sell", "considering selling",
  "i am considering", "thinking of selling", "open to selling", "would sell",
  "make me an offer", "make an offer", "send me an offer", "send an offer",
  "what can you offer", "how much can you offer", "how much", "what's your offer",
  "whats your offer", "cash offer", "your offer", "call me", "give me a call",
  "you can call", "let's talk", "lets talk", "we can talk", "contact me later",
  "reach out later", "depending on price", "depends on the price", "for the right price",
  "know my options", "my options", "what are my options", "i would like to know",
  // Willing-to-hear-an-offer language (real sellers phrase interest this way):
  "make a offer", "make offer", "want to make a offer", "want to make an offer",
  "makeme an offer", "im open", "i'm open", "i am open", "still open",
  "open to see", "open to hear", "open to an offer", "open to a offer", "open to offers",
  "open to selling", "open to sell", "see what it is", "see your offer", "see the offer",
  "hear your offer", "hear the offer", "hear an offer", "whats it worth", "what's it worth",
];
const NOT_INTERESTED_PHRASES = [
  "not interested", "no longer interested", "not selling", "i'm not selling",
  "im not selling", "not for sale", "already sold", "i sold", "we sold", "sold it",
  "sold already", "wrong number", "wrong person", "not the owner", "leave me alone",
  "lose my number", "take me off", "stop texting", "stop contacting", "do not want",
  "no thanks", "no thank you", "not right now never",
];

/**
 * Classify a seller reply. Returns
 *   { classification, reason, activeDeal, needsReview, optOut }
 * classification ∈ 'interested' | 'not_interested' | 'needs_review'.
 */
export function classifyReply(replyText) {
  // Strip date/time chrome REI leaves in the captured reply ("Jul 16, 2026 No",
  // "5:21 PM No") so a plain "No" is recognized as a real No instead of falling
  // through to Interested.
  const raw = String(replyText || "")
    .replace(/\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:,?\s*\d{4})?/gi, " ")
    .replace(/\b\d{1,2}:\d{2}\s*(?:am|pm)?\b/gi, " ")
    .replace(/\b(?:today|yesterday|sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  const lower = raw.toLowerCase();
  if (!raw) {
    return { classification: "interested", reason: "Replied (text unreadable) — kept as interested for review.", activeDeal: true, needsReview: false, optOut: false };
  }

  // Hard opt-out first — STOP, unsubscribe, do-not-contact, do-not-automate.
  // Broadened so lowercase/short forms ("stop", "remove", "please remove",
  // "lose my number", "take me off") are caught here and labeled Opted Out,
  // not left as needs_review.
  const REPLY_OPTOUT_RE =
    /\b(stop|stopp|unsubscribe|remove( me| us)?|take me off|lose my number|leave me alone|do ?not ?(text|call|contact|message)|don'?t (text|call|contact|message))\b/i;
  if (DO_NOT_AUTOMATE_REGEX.test(lower) || OPTOUT_REGEX.test(lower) || detectStopReply(raw) || REPLY_OPTOUT_RE.test(lower)) {
    return {
      classification: "not_interested",
      reason: "Opt-out / STOP language — suppression applied.",
      activeDeal: false, needsReview: false, optOut: true,
    };
  }

  // REI joins a multi-message thread into one string with " | " between bubbles
  // ("No | Aug 3, 2026 You, too"). Classify EACH bubble on its own so a bare "No"
  // or "Sold" in one bubble isn't buried by chit-chat ("You too") in the next.
  const segments = raw.split(/\s*\|\s*/).map((s) => s.trim()).filter(Boolean);
  const parts = segments.length ? segments : [raw];

  // A short, standalone yes/no/sold counts (but only when it IS the whole bubble,
  // so an isolated keyword inside a longer, contradictory sentence can't flip it).
  const isBareYes = (s) => /^(yes|yeah|yep|yup|sure|ok|okay|interested)\b[\s.!]*$/i.test(s);
  const isBareNo = (s) =>
    /^(no|nope|nah|not interested|no thanks?|no thank you)\b[\s.!]*$/i.test(s) ||
    /^(sold|already sold|it'?s sold|we sold|i sold|sold it|sold already)\b[\s.!]*$/i.test(s);

  const posHits = INTERESTED_PHRASES.filter((p) => lower.includes(p));
  const negHits = NOT_INTERESTED_PHRASES.filter((p) => lower.includes(p));

  const bareYes = parts.some(isBareYes);
  const bareNo = parts.some(isBareNo);

  const positive = posHits.length > 0 || bareYes;
  const negative = negHits.length > 0 || bareNo;

  // CONDITIONAL SELLER — "I'm not selling UNLESS the price is right", names a
  // minimum price, or "send me a number / I'll consider" — is an INTERESTED
  // lead, even though it contains "not selling". Real sellers phrase interest
  // this way constantly (e.g. Keri: "im not selling nor know I will unless the
  // price is worth it ... 600 minimum ... i am interested"). Catch it before the
  // mixed/negative branches so the "not selling" part doesn't bury the interest.
  const CONDITIONAL_INTEREST_RE = /\b(unless the price|if the price|the right price|right price|price is right|price is worth|for the right price|depending on (the )?price|depends on (the )?price|\d{2,4}\s*(k|,000)?\s*(minimum|min)\b|i (would|will|might) consider|would consider|open to (an?|the) offer|send (me )?a? ?number|make me an offer|if it'?s something i (am|would be) interested)\b/i;
  // A blunt, present-tense "not interested" (or similar hard no) is a real no —
  // don't let a price cue override it. "not selling" is softer (usually the
  // "…unless the price" kind), so it does NOT count as a hard no here.
  const HARD_NEGATIVE_RE = /\b(not interested|no longer interested|never selling|not for sale|leave me alone|do not want)\b/i;
  if (!bareNo && !HARD_NEGATIVE_RE.test(lower) && CONDITIONAL_INTEREST_RE.test(lower)) {
    return {
      classification: "interested",
      reason: "Conditional seller — open to selling at the right price/offer.",
      activeDeal: true, needsReview: false, optOut: false,
    };
  }

  // NO 'needs review' for replies — every reply is Interested or Not Interested.
  // Only a CLEAR negative (with no interest signal) is Not Interested; a mixed
  // reply still counts as Interested (they showed some interest — worth a look).
  // Everything else defaults to Interested so a warm/unclear reply is reviewed,
  // never auto-deleted.
  if (negative && !positive) {
    return {
      classification: "not_interested",
      reason: negHits.length ? `Negative: "${negHits[0]}"` : "Replied No.",
      activeDeal: false, needsReview: false, optOut: false,
    };
  }
  if (positive && negative) {
    return {
      classification: "interested",
      reason: `Mixed reply — kept as interested for review (interested: ${posHits.join(", ") || "yes"}).`,
      activeDeal: true, needsReview: false, optOut: false,
    };
  }
  if (positive) {
    return {
      classification: "interested",
      reason: posHits.length ? `Interest: "${posHits[0]}"` : "Replied Yes.",
      activeDeal: true, needsReview: false, optOut: false,
    };
  }

  // Anything else (a bare question, emoji, "you too", unclear) → Interested, so
  // it gets a human look instead of being deleted as "not interested".
  return {
    classification: "interested",
    reason: "Replied — intent unclear, kept as interested for a human to review.",
    activeDeal: true, needsReview: false, optOut: false,
  };
}

function describePropertyStatus(facts) {
  if (facts.propertySold) return facts.soldDate ? `Sold (${facts.soldDate})` : "Sold";
  if (facts.propertyListed) return "Listed (Active MLS)";
  if (!facts.matchFound) return "Unknown (no match)";
  return "Not sold / not listed";
}
