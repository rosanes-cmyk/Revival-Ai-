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

// A ROTATING POOL of approved templates per company. One is picked at random
// per send so we don't blast identical copy (which gets flagged/blocked by
// carriers). Index 0 is the preferred wording. To add/adjust wording, edit the
// Twin Home Buyer list; the Equity Track list mirrors it with the company name.
const THB_TEMPLATES = [
  "Hi {{first_name}}, it's Juan with Twin Home Buyer. You reached out about your property a while back, and I realized we never heard what you ended up doing with it. Did you end up selling it, or do you still have it?",
  "Hi {{first_name}}, Juan here with Twin Home Buyer. I was looking back through our notes and saw we never found out what happened with your property. Did you end up selling, or are you still holding onto it?",
  "Hi {{first_name}}, it's Juan with Twin Home Buyer. I was reviewing some older conversations and yours came up. Just curious—what ever happened with the property?",
  "Hey {{first_name}}, it's Juan with Twin Home Buyer. Been a while since we last talked. Is the property still yours, or did you end up selling it?",
  "Hey {{first_name}}, Juan with Twin Home Buyer. Quick question—did you ever end up selling the property, or do you still have it?",
];
// Swap the company name WITHOUT a trailing period — each template already has a
// sentence period right after "Twin Home Buyer", which becomes "Equity Track
// Inc." naturally (no double period).
const EQT_TEMPLATES = THB_TEMPLATES.map((t) =>
  t.split("Twin Home Buyer").join("Equity Track Inc")
);

export const APPROVED_TEMPLATES = Object.freeze({
  [COMPANY.TWIN_HOME_BUYER]: Object.freeze(THB_TEMPLATES),
  [COMPANY.EQUITY_TRACK]: Object.freeze(EQT_TEMPLATES),
});

// Primary (preferred) message per company — used for the dashboard banner and
// as the "a message exists for this company" check.
export const APPROVED_MESSAGES = Object.freeze({
  [COMPANY.TWIN_HOME_BUYER]: THB_TEMPLATES[0],
  [COMPANY.EQUITY_TRACK]: EQT_TEMPLATES[0],
});

// Distinctive, name-free phrases (one per template, plus older scripts) used to
// detect that OUR revival text is already in a contact's REI chat (duplicate
// guard). Lower-cased; matched as substrings. Kept broad enough to catch any
// rotating template AND messages sent with previous wording.
export const REVIVAL_NEEDLES = Object.freeze([
  "what you ended up doing with it",
  "looking back through our notes",
  "reviewing some older conversations",
  "been a while since we last talked",
  "did you ever end up selling the property",
  // Previous scripts (kept so earlier sends are still detected):
  "we never found out how everything turned out",
  "reached out to us about your property",
  "contacted us before about selling your home",
]);

// Structural integrity check — catches an accidental/corrupt edit loudly at
// boot. Every template must name the correct company, keep the {{first_name}}
// token, mention Juan, and be a sane length.
export function assertMessageIntegrity() {
  for (const company of Object.values(COMPANY)) {
    const list = APPROVED_TEMPLATES[company];
    if (!Array.isArray(list) || list.length === 0) {
      throw new Error(`Approved message integrity FAILED: no templates for "${company}".`);
    }
    list.forEach((msg, i) => {
      const problems = [];
      if (typeof msg !== "string" || msg.length < 40 || msg.length > 340) problems.push("length");
      if (!msg.includes(FIRST_NAME_TOKEN)) problems.push("missing {{first_name}}");
      if (!/juan/i.test(msg)) problems.push("missing sender name");
      if (!msg.includes(company)) problems.push(`missing company "${company}"`);
      if (problems.length) {
        throw new Error(
          `Approved message integrity FAILED for "${company}" template #${i + 1}: ${problems.join(", ")}.`
        );
      }
    });
  }
}

/**
 * Pick one approved template for a company at random (rotation), so repeated
 * sends don't use identical copy. Returns null if the company isn't approved.
 * Pass a specific index to force a particular template (used for testing).
 */
export function pickApprovedTemplate(rawCompany, index = null) {
  const company = normalizeCompany(rawCompany);
  if (!company) return null;
  const list = APPROVED_TEMPLATES[company];
  if (!list || !list.length) return null;
  const i = Number.isInteger(index)
    ? ((index % list.length) + list.length) % list.length
    : Math.floor(Math.random() * list.length);
  return list[i];
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
