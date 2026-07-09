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
  OWNER_NAME: "Owner Name",
  PHONE: "Phone",
  EMAIL: "Email",
});

// --- Compliance: bad tags on the contact (SOP step 9) ----------------------
// Each maps to the outcome it triggers. Read every tag chip; if any contains
// one of these (case-insensitive substring), apply the mapped outcome.
export const SAFETY_TAG_RULES = Object.freeze([
  { match: "opt out", outcome: DISPOSITION.OPTED_OUT },
  { match: "opt-out", outcome: DISPOSITION.OPTED_OUT },
  { match: "opted out", outcome: DISPOSITION.OPTED_OUT },
  { match: "stop", outcome: DISPOSITION.OPTED_OUT },
  { match: "do not contact", outcome: DISPOSITION.OPTED_OUT },
  { match: "do not text", outcome: DISPOSITION.OPTED_OUT },
  { match: "close my file", outcome: DISPOSITION.OPTED_OUT },
  { match: "remove me", outcome: DISPOSITION.OPTED_OUT },
  { match: "bad comments", outcome: DISPOSITION.OPTED_OUT },
  { match: "not interested", outcome: DISPOSITION.NOT_INTERESTED },
  { match: "wrong number", outcome: DISPOSITION.WRONG_NUMBER },
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
