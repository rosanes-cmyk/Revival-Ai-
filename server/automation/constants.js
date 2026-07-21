// Shared constants for dispositions, REI tags, safety rules, and column layout.
// Used by the SOP engine, the dashboard cards/table, and the exported sheet, so
// they must stay consistent everywhere.

export const DISPOSITION = Object.freeze({
  PENDING: "Pending",
  READY_TO_TEXT: "Ready To Text",
  TEXT_SENT: "Text Sent",
  LEAD_NOT_FOUND: "Lead NOT Found",
  PROPERTY_SOLD: "Property Sold",
  LISTED: "Listed",
  OPTED_OUT: "Opted Out",
  NOT_INTERESTED: "Not Interested",
  WRONG_NUMBER: "Wrong Number",
  FAILED_NUMBER: "Failed Number",
  ALREADY_CONTACTED: "Already Contacted",
  BAD_LEAD: "Bad Lead",
  OUT_OF_STATE: "Out of State",
  TEXTED_THIS_MONTH: "Texted This Month",
  RECENT_CONTACT: "Recent Contact",
  NEEDS_REVIEW: "Needs Review",
  ERROR: "Error",
});

// The exact REI tag to apply for each disposition (SOP "REI TAGS TO USE").
export const REVIVAL_TAG = Object.freeze({
  [DISPOSITION.TEXT_SENT]: "Revival - Text Sent",
  [DISPOSITION.OPTED_OUT]: "Revival - Do Not Text",
  [DISPOSITION.NOT_INTERESTED]: "Revival - Not Interested",
  [DISPOSITION.WRONG_NUMBER]: "Revival - Wrong Number",
  [DISPOSITION.FAILED_NUMBER]: "Revival - Failed Number",
  [DISPOSITION.ALREADY_CONTACTED]: "Revival - Already Contacted",
  [DISPOSITION.NEEDS_REVIEW]: "Revival - Needs Review",
  [DISPOSITION.LEAD_NOT_FOUND]: "Revival - Lead Not Found",
  [DISPOSITION.PROPERTY_SOLD]: "Revival - Sold",
  [DISPOSITION.LISTED]: "Revival - Listed",
  [DISPOSITION.BAD_LEAD]: "Revival - Bad Lead",
});

// Dispositions that mean a row is finished and must be skipped on resume/re-run
// (no duplicate texts). Needs Review and Error are re-attempted so a fixed
// selector or manual clearance can let the lead proceed later.
export const TERMINAL_DISPOSITIONS = Object.freeze([
  DISPOSITION.TEXT_SENT,
  DISPOSITION.LEAD_NOT_FOUND,
  DISPOSITION.PROPERTY_SOLD,
  DISPOSITION.LISTED,
  DISPOSITION.OPTED_OUT,
  DISPOSITION.NOT_INTERESTED,
  DISPOSITION.WRONG_NUMBER,
  DISPOSITION.FAILED_NUMBER,
  DISPOSITION.ALREADY_CONTACTED,
  DISPOSITION.BAD_LEAD,
  DISPOSITION.OUT_OF_STATE,
  DISPOSITION.TEXTED_THIS_MONTH,
  DISPOSITION.RECENT_CONTACT,
]);

export const ELIGIBILITY = Object.freeze({
  PENDING: "Pending",
  READY_TO_TEXT: "Ready To Text",
  ELIGIBLE_TEXT_SENT: "Eligible - Text Sent",
  ELIGIBLE_SEND_BLOCKED: "Eligible - Send Blocked",
  NEEDS_REVIEW: "Needs Review",
  NOT_ELIGIBLE: "Not Eligible",
});

export const MATCH_STATUS = Object.freeze({
  UNSEARCHED: "Unsearched",
  MATCH_PIPELINE_FULL: "Match - Pipeline (full address)",
  MATCH_PIPELINE_STREET: "Match - Pipeline (street address)",
  MATCH_PIPELINE_HOUSE_STREET: "Match - Pipeline (house # + street)",
  MATCH_PIPELINE_OWNER: "Match - Pipeline (owner name)",
  MATCH_CONTACTS_ADDRESS: "Match - Contacts (address)",
  MATCH_CONTACTS_PHONE: "Match - Contacts (phone)",
  MATCH_CONTACTS_EMAIL: "Match - Contacts (email)",
  MATCH_CONTACTS_OWNER: "Match - Contacts (owner name)",
  NOT_FOUND: "Not Found",
});

// Search methods, in the order the SOP requires them to be attempted.
export const SEARCH_METHOD = Object.freeze({
  PIPELINE_FULL_ADDRESS: "Full Property Address",
  PIPELINE_STREET_ADDRESS: "Street Address Only",
  PIPELINE_HOUSE_STREET: "House Number + Street Name",
  CONTACTS_ADDRESS: "Contacts - property address",
  OWNER_NAME: "Owner Name",
  PHONE: "Phone",
  EMAIL: "Email",
});

// --- Compliance: bad tags on the contact (SOP step 9) ----------------------
// Each maps to the outcome it triggers. Read every tag chip; if any contains
// one of these (case-insensitive substring), apply the mapped outcome. The
// FIRST rule that matches wins, so the list is ordered by precedence.
//
// These are matched against Juan's real REI BlackBook tag names. NOTE:
// "Do Not Mail" is intentionally NOT here — per the SOP it does not block a
// text (mail-only suppression). Only tags that mean "don't TEXT this person"
// or "this lead/property is dead" are listed.
export const SAFETY_TAG_RULES = Object.freeze([
  // Opt-out / do-not-text (highest precedence — hard compliance stop).
  { match: "do not text", outcome: DISPOSITION.OPTED_OUT },
  { match: "do not contact", outcome: DISPOSITION.OPTED_OUT },
  { match: "do not call", outcome: DISPOSITION.OPTED_OUT },
  { match: "dnc", outcome: DISPOSITION.OPTED_OUT },
  { match: "opt out", outcome: DISPOSITION.OPTED_OUT },
  { match: "opt-out", outcome: DISPOSITION.OPTED_OUT },
  { match: "opted out", outcome: DISPOSITION.OPTED_OUT },
  { match: "unsubscribe", outcome: DISPOSITION.OPTED_OUT },
  { match: "stop", outcome: DISPOSITION.OPTED_OUT },
  { match: "close my file", outcome: DISPOSITION.OPTED_OUT },
  { match: "remove me", outcome: DISPOSITION.OPTED_OUT },
  { match: "remove from list", outcome: DISPOSITION.OPTED_OUT },
  { match: "remove from the list", outcome: DISPOSITION.OPTED_OUT },
  { match: "bad comments", outcome: DISPOSITION.OPTED_OUT },
  { match: "cursed and reported", outcome: DISPOSITION.OPTED_OUT },

  // Property already sold / closed (report as Property Sold — no text).
  { match: "sold", outcome: DISPOSITION.PROPERTY_SOLD },
  { match: "deal closed", outcome: DISPOSITION.PROPERTY_SOLD },
  { match: "under contract", outcome: DISPOSITION.PROPERTY_SOLD },
  { match: "contract signed", outcome: DISPOSITION.PROPERTY_SOLD },
  { match: "signed contract", outcome: DISPOSITION.PROPERTY_SOLD },

  // Property listed / on market (report as Listed — no text).
  { match: "already listed", outcome: DISPOSITION.LISTED },
  { match: "currently for sale on market", outcome: DISPOSITION.LISTED },
  { match: "for sale on market", outcome: DISPOSITION.LISTED },
  { match: "listed", outcome: DISPOSITION.LISTED },

  // Not interested in selling.
  { match: "not interested", outcome: DISPOSITION.NOT_INTERESTED },
  { match: "no interest in selling", outcome: DISPOSITION.NOT_INTERESTED },
  { match: "no longer interested", outcome: DISPOSITION.NOT_INTERESTED },

  // Wrong number / wrong contact.
  { match: "wrong number", outcome: DISPOSITION.WRONG_NUMBER },
  { match: "wrong call", outcome: DISPOSITION.WRONG_NUMBER },
  { match: "not the owner", outcome: DISPOSITION.WRONG_NUMBER },

  // Dead / bad / junk leads (don't text — treat as opt-out so nothing is sent).
  { match: "dead lead", outcome: DISPOSITION.OPTED_OUT },
  { match: "disqualified", outcome: DISPOSITION.OPTED_OUT },
  { match: "spam call", outcome: DISPOSITION.OPTED_OUT },
  { match: "telemarketer", outcome: DISPOSITION.OPTED_OUT },
  { match: "fake lead", outcome: DISPOSITION.OPTED_OUT },
  { match: "invalid lead", outcome: DISPOSITION.OPTED_OUT },
  { match: "delete", outcome: DISPOSITION.OPTED_OUT },
]);

// --- Compliance: blocking phrases in notes/activity/chat/SMS (SOP step 10) --
// Categorized by the outcome each phrase triggers. Order of the buckets below
// is the precedence: opt-out beats not-interested beats wrong-number.
export const BLOCKING_PHRASES = Object.freeze({
  [DISPOSITION.OPTED_OUT]: [
    "stop",
    "unsubscribe",
    "opt out",
    "remove",
    "do not text",
    "do not contact",
    "do not call",
    "close my file",
    "close my account",
    "close the file",
    "close this file",
    "close my lead",
    "remove my file",
    "please close",
    "close it",
    "do not follow up",
    "stop following up",
    "leave me alone",
    "complaint",
    "legal",
    "spam",
  ],
  [DISPOSITION.NOT_INTERESTED]: ["not interested", "no longer interested"],
  [DISPOSITION.WRONG_NUMBER]: ["wrong number"],
});

// Broad opt-out / do-not-contact detector, scanned against the COMBINED text of
// tags + notes + conversation history. Catches phrasings the tag/phrase lists
// miss. NOTE: physical-mail-only "do not mail" is intentionally excluded — per
// the SOP it does not block texting. (Toggle in one place here if that changes.)
export const OPTOUT_REGEX =
  /\b(?:unsubscribe|do ?not ?(?:call|text|e-?mail|contact|automate|market|solicit)|opt(?:ed)? ?out|remove me|remove from (?:the )?list|dnc|no (?:more )?(?:texts?|calls?|e-?mails?|contact)|stop (?:texting|calling|contacting|messaging))\b/i;

// "Do Not Automate" — skip the lead entirely (highest precedence).
export const DO_NOT_AUTOMATE_REGEX = /\bdo ?not ?automate\b/i;

// Active-deal tags: the lead is further along (an appointment is booked or an
// offer went out). We only re-engage these with a revival text if the deal has
// gone COLD (no conversation for ~a month); if there was contact within the
// month, we skip so we don't step on an active negotiation.
export const ACTIVE_DEAL_TAG_REGEX =
  /\b(appointment\s*(?:booked|set|scheduled)|appt\s*(?:booked|set)|offer\s*(?:sent|made|submitted|out)|under\s*(?:contract\s*)?negotiation|in\s*negotiation)\b/i;

// A conversation is "recent" if the last message was within this many days.
export const RECENT_CONVERSATION_DAYS = Number(process.env.RECENT_CONVERSATION_DAYS || 31);

// Markers that indicate the latest outbound message failed / was undelivered.
export const FAILED_MARKERS = Object.freeze([
  "failed",
  "undelivered",
  "delivery failed",
  "not delivered",
  "send failed",
  "could not be delivered",
]);

// --- Spreadsheet columns ----------------------------------------------------
export const REQUIRED_COLUMNS = Object.freeze([
  "Owner Name",
  "Property Address",
  "City",
  "State",
  "ZIP Code",
  "Disposition",
  "Notes",
]);

// Optional columns we use if present (Company Source drives which message).
export const OPTIONAL_COLUMNS = Object.freeze([
  "Company Source",
  "Phone",
  "Email",
]);

// Full column order for the exported spreadsheet (SOP FINAL OUTPUT / step 10).
export const EXPORT_COLUMNS = Object.freeze([
  "Owner Name",
  "Property Address",
  "City",
  "State",
  "ZIP Code",
  "Company Source",
  "Phone",
  "Email",
  "Disposition",
  "Notes",
  "REI Match Status",
  "Search Method Used",
  "Property Status",
  "Opt-Out / Safety",
  "Eligibility Status",
  "REI Tag Applied",
  "Text Sent Timestamp",
  "Error Log",
]);
