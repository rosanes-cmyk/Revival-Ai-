// Approved revival text messages — one per company source.
//
// DO NOT MODIFY THESE STRINGS. They are the exact, compliance-approved copy for
// the Twin Text Platform lead text-revival campaign. They are frozen so no other code
// path can alter them, and their integrity is checksummed at startup.

export const COMPANY = Object.freeze({
  TWIN_HOME_BUYER: "Twin Home Buyer",
  EQUITY_TRACK: "Equity Track Inc.",
});

// The {{first_name}} token is replaced with the contact's first name at send
// time (see renderMessage). If no name is known it becomes "there" so the text
// still reads naturally ("Hi there, it's Juan...").
export const FIRST_NAME_TOKEN = "{{first_name}}";

export const APPROVED_MESSAGES = Object.freeze({
  [COMPANY.TWIN_HOME_BUYER]:
    "Hi {{first_name}}, it's Juan with Twin Home Buyer. You reached out to us about your property, but we never found out how everything turned out. What ended up happening?",
  [COMPANY.EQUITY_TRACK]:
    "Hi {{first_name}}, it's Juan with Equity Track Inc. You reached out to us about your property, but we never found out how everything turned out. What ended up happening?",
});

// Distinctive, name-free phrases used to detect that OUR revival text is already
// in a contact's REI chat (duplicate guard) and to confirm a send landed. The
// list also keeps the OLDER script's phrase so a lead texted with the previous
// wording this month is still recognized and not double-texted.
export const REVIVAL_NEEDLES = Object.freeze([
  "we never found out how everything turned out",
  "reached out to us about your property",
  "what ended up happening",
  // Previous script (kept so prior sends are still detected):
  "contacted us before about selling your home",
]);

// Expected lengths — an accidental edit is caught loudly at boot.
const EXPECTED_LENGTHS = Object.freeze({
  [COMPANY.TWIN_HOME_BUYER]: 168,
  [COMPANY.EQUITY_TRACK]: 169,
});

export function assertMessageIntegrity() {
  for (const [company, msg] of Object.entries(APPROVED_MESSAGES)) {
    if (msg.length !== EXPECTED_LENGTHS[company]) {
      throw new Error(
        `Approved message integrity check FAILED for "${company}". ` +
          `Expected length ${EXPECTED_LENGTHS[company]}, got ${msg.length}. The message must not be modified.`
      );
    }
  }
}

/**
 * Normalize a free-text company-source value from the spreadsheet to a known
 * COMPANY key. Returns null if it is neither Twin Home Buyer nor Equity Track.
 */
export function normalizeCompany(raw) {
  const v = String(raw || "").trim().toLowerCase();
  if (!v) return null;
  if (v.includes("twin home")) return COMPANY.TWIN_HOME_BUYER;
  if (v.includes("equity track")) return COMPANY.EQUITY_TRACK;
  return null;
}

/**
 * Get the exact approved message for a company source, or null if the company
 * is not one of the two approved senders (caller must then hold for review).
 */
export function getApprovedMessage(rawCompany) {
  const company = normalizeCompany(rawCompany);
  return company ? APPROVED_MESSAGES[company] : null;
}

/**
 * Pull a usable first name out of an owner/contact name. Handles "John Smith",
 * "SMITH, JOHN", and drops obvious non-names. Returns "" if nothing usable.
 */
export function firstNameFrom(ownerName) {
  let s = String(ownerName || "").trim();
  if (!s) return "";
  // "Last, First" -> take the part after the comma.
  if (s.includes(",")) {
    const after = s.split(",")[1] || "";
    if (after.trim()) s = after.trim();
  }
  // First whitespace-separated token that looks like a name (letters, 2+ chars).
  const tok = s.split(/\s+/).find((w) => /^[A-Za-z][A-Za-z'’.-]{1,}$/.test(w)) || "";
  if (!tok) return "";
  // Title-case it (REI often stores names in ALL CAPS).
  const clean = tok.replace(/[.'’-]+$/g, "");
  return clean ? clean.charAt(0).toUpperCase() + clean.slice(1).toLowerCase() : "";
}

/**
 * Fill the {{first_name}} token in an approved message. Uses the contact's
 * first name when we have one, otherwise "there" so it still reads naturally.
 */
export function renderMessage(template, ownerName) {
  const first = firstNameFrom(ownerName) || "there";
  return String(template || "").split(FIRST_NAME_TOKEN).join(first);
}
