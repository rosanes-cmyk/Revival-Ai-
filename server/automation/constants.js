// Shared constants for dispositions, eligibility labels, and match statuses.
// These strings are used by the SOP engine, the dashboard summary cards, and
// the exported spreadsheet, so they must stay consistent everywhere.

export const DISPOSITION = Object.freeze({
  PENDING: "Pending",
  TEXT_SENT: "Text Sent",
  LEAD_NOT_FOUND: "Lead NOT Found",
  PROPERTY_SOLD: "Property Sold",
  LISTED: "Listed",
  OPTED_OUT: "Opted Out",
  NEEDS_REVIEW: "Needs Review",
  ERROR: "Error",
});

// Dispositions that mean a row is already finished and must be skipped on a
// re-run / resume (SOP step A). Needs Review and Error are intentionally NOT
// here: they are re-attempted so a fixed selector or a manual clearance can
// let the lead proceed later.
export const TERMINAL_DISPOSITIONS = Object.freeze([
  DISPOSITION.TEXT_SENT,
  DISPOSITION.LEAD_NOT_FOUND,
  DISPOSITION.PROPERTY_SOLD,
  DISPOSITION.LISTED,
  DISPOSITION.OPTED_OUT,
]);

export const ELIGIBILITY = Object.freeze({
  PENDING: "Pending",
  ELIGIBLE_TEXT_SENT: "Eligible - Text Sent",
  ELIGIBLE_SEND_BLOCKED: "Eligible - Send Blocked",
  NEEDS_REVIEW: "Needs Review",
  NOT_ELIGIBLE: "Not Eligible",
});

export const MATCH_STATUS = Object.freeze({
  UNSEARCHED: "Unsearched",
  MATCH_PIPELINE_FULL: "Match - Pipeline (full address)",
  MATCH_PIPELINE_PARTIAL: "Match - Pipeline (partial address)",
  MATCH_PIPELINE_OWNER: "Match - Pipeline (owner name)",
  MATCH_SMART_CONTACTS: "Match - Smart Contacts (owner name)",
  NOT_FOUND: "Not Found",
});

// Search methods, in the order the SOP requires them to be attempted.
export const SEARCH_METHOD = Object.freeze({
  PIPELINE_FULL_ADDRESS: "Property Pipeline - full address",
  PIPELINE_PARTIAL_ADDRESS: "Property Pipeline - partial address",
  PIPELINE_OWNER_NAME: "Property Pipeline - owner name",
  SMART_CONTACTS_OWNER_NAME: "Smart Contacts - owner name",
});

// The four opt-out conditions that absolutely forbid texting (SOP step D / 6).
export const OPT_OUT_REASONS = Object.freeze([
  "Opted Out",
  "SMS Opt Out",
  "STOP Request",
  "Text Opt Out",
]);

// The columns required on the uploaded spreadsheet (SOP step 1).
export const REQUIRED_COLUMNS = Object.freeze([
  "Owner Name",
  "Property Address",
  "City",
  "State",
  "ZIP Code",
  "Disposition",
  "Notes",
]);

// Full column order for the exported spreadsheet (SOP step 9).
export const EXPORT_COLUMNS = Object.freeze([
  "Owner Name",
  "Property Address",
  "City",
  "State",
  "ZIP Code",
  "Disposition",
  "Notes",
  "REI Match Status",
  "Last Contact Date",
  "Opt-Out Status",
  "Property Status",
  "Eligibility Status",
  "Text Sent Timestamp",
  "Error Log",
]);
