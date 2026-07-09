// SOP rule engine.
//
// Pure decision logic: given the facts gathered from REI BlackBook for one
// lead, decide what disposition/eligibility applies and whether a text may be
// sent. Keeping this separate from the browser automation makes the rules
// auditable and unit-testable, and guarantees the safety rules (SOP step 6)
// are enforced in exactly one place.

import {
  DISPOSITION,
  ELIGIBILITY,
} from "./constants.js";

/**
 * @typedef {Object} LeadFacts
 * @property {boolean} matchFound            Whether any matching lead was found.
 * @property {string}  matchStatus          MATCH_STATUS value.
 * @property {string[]} optOutReasons       Any of OPT_OUT_REASONS found on the record.
 * @property {boolean} propertySold          Property marked sold.
 * @property {string}  soldDate             Sold date text if visible, else "".
 * @property {boolean} propertyListed        Property has an active MLS listing.
 * @property {string}  mlsNote              Listing note if visible, else "".
 * @property {Date|null} lastContactDate     Most recent communication date, or null.
 * @property {boolean} hasDoNotMail          "Do Not Mail" tag present.
 * @property {boolean} hasDoNotContact       "Do Not Contact" tag present.
 * @property {boolean} uncertain             Adapter could not confidently read the record.
 * @property {string}  uncertainReason      Why it was uncertain.
 */

/**
 * Decide the outcome for one lead based on gathered facts.
 * Returns a decision object; it never sends anything itself.
 *
 * @param {LeadFacts} facts
 * @param {Object} opts
 * @param {number} opts.contactWindowDays  Days that count as "recent contact".
 * @param {Date}   opts.now                Reference "now" for the window math.
 * @returns {{disposition:string, eligibility:string, notes:string,
 *            optOutStatus:string, propertyStatus:string,
 *            lastContactDate:(Date|null), shouldSendText:boolean,
 *            complianceResult:string}}
 */
export function decide(facts, { contactWindowDays, now }) {
  const base = {
    disposition: DISPOSITION.PENDING,
    eligibility: ELIGIBILITY.PENDING,
    notes: "",
    optOutStatus: facts.optOutReasons.length
      ? facts.optOutReasons.join(", ")
      : "None",
    propertyStatus: describePropertyStatus(facts),
    lastContactDate: facts.lastContactDate,
    shouldSendText: false,
    complianceResult: "",
  };

  // SOP step 6 / safety: if the system is uncertain about ANY reading, never
  // text. Hold for a human. This also covers a mismatched selector at runtime.
  if (facts.uncertain) {
    return {
      ...base,
      disposition: DISPOSITION.NEEDS_REVIEW,
      eligibility: ELIGIBILITY.NEEDS_REVIEW,
      notes: facts.uncertainReason || "System could not confidently read the record.",
      complianceResult: "Uncertain - held for review",
    };
  }

  // SOP step C: no matching lead found.
  if (!facts.matchFound) {
    return {
      ...base,
      disposition: DISPOSITION.LEAD_NOT_FOUND,
      eligibility: ELIGIBILITY.NOT_ELIGIBLE,
      notes: "Address searched. No matching lead found.",
      complianceResult: "No match",
    };
  }

  // SOP step D: opt-out of any kind is an absolute block.
  if (facts.optOutReasons.length > 0) {
    return {
      ...base,
      disposition: DISPOSITION.OPTED_OUT,
      eligibility: ELIGIBILITY.NOT_ELIGIBLE,
      notes: facts.optOutReasons.join("; "),
      complianceResult: `Opt-out: ${facts.optOutReasons.join(", ")}`,
    };
  }

  // SOP step E: property sold.
  if (facts.propertySold) {
    return {
      ...base,
      disposition: DISPOSITION.PROPERTY_SOLD,
      eligibility: ELIGIBILITY.NOT_ELIGIBLE,
      notes: facts.soldDate ? `Sold date: ${facts.soldDate}` : "",
      complianceResult: "Property sold",
    };
  }

  // SOP step E: property listed for sale.
  if (facts.propertyListed) {
    return {
      ...base,
      disposition: DISPOSITION.LISTED,
      eligibility: ELIGIBILITY.NOT_ELIGIBLE,
      notes: facts.mlsNote ? `Active MLS Listing. ${facts.mlsNote}` : "Active MLS Listing",
      complianceResult: "Property listed",
    };
  }

  // SOP step F: contacted within the last N days -> hold for review, no text.
  if (facts.lastContactDate) {
    const days = daysBetween(facts.lastContactDate, now);
    if (days <= contactWindowDays) {
      return {
        ...base,
        disposition: DISPOSITION.NEEDS_REVIEW,
        eligibility: ELIGIBILITY.NEEDS_REVIEW,
        notes: `Contacted within last ${contactWindowDays} days.`,
        complianceResult: `Recent contact ${days} day(s) ago`,
      };
    }
  }

  // SOP step G: Do Not Mail / Do Not Contact WITHOUT any opt-out does not by
  // itself block a text. We've already confirmed no opt-out and no recent
  // contact above, so the lead remains eligible. We record the tag as a note.
  const dncNote =
    facts.hasDoNotMail || facts.hasDoNotContact
      ? `Has ${[
          facts.hasDoNotMail ? "Do Not Mail" : null,
          facts.hasDoNotContact ? "Do Not Contact" : null,
        ]
          .filter(Boolean)
          .join(" / ")} (no opt-out present; SMS still permitted per SOP).`
      : "";

  // SOP step H: eligible. Text may be sent.
  return {
    ...base,
    disposition: DISPOSITION.PENDING, // becomes Text Sent after a confirmed send
    eligibility: ELIGIBILITY.PENDING,
    notes: dncNote,
    complianceResult: "Passed all checks - eligible",
    shouldSendText: true,
  };
}

function describePropertyStatus(facts) {
  if (facts.propertySold) return facts.soldDate ? `Sold (${facts.soldDate})` : "Sold";
  if (facts.propertyListed) return "Listed (Active MLS)";
  if (!facts.matchFound) return "Unknown (no match)";
  return "Not sold / not listed";
}

export function daysBetween(earlier, later) {
  const ms = later.getTime() - earlier.getTime();
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}
