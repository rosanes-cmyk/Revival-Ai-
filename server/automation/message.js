// Approved revival text messages — one per company source.
//
// DO NOT MODIFY THESE STRINGS. They are the exact, compliance-approved copy for
// the Twin Text Platform lead text-revival campaign. They are frozen so no other code
// path can alter them, and their integrity is checksummed at startup.

export const COMPANY = Object.freeze({
  TWIN_HOME_BUYER: "Twin Home Buyer",
  EQUITY_TRACK: "Equity Track Inc.",
});

export const APPROVED_MESSAGES = Object.freeze({
  [COMPANY.TWIN_HOME_BUYER]:
    "Hi, this is Juan with Twin Home Buyer. You contacted us before about selling your home. Are you still interested? Reply YES or NO. Thanks!",
  [COMPANY.EQUITY_TRACK]:
    "Hi, this is Juan with Equity Track Inc. You contacted us before about selling your home. Are you still interested? Reply YES or NO. Thanks!",
});

// Expected lengths — an accidental edit is caught loudly at boot.
const EXPECTED_LENGTHS = Object.freeze({
  [COMPANY.TWIN_HOME_BUYER]: 138,
  [COMPANY.EQUITY_TRACK]: 139,
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
