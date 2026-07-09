// REI BlackBook browser-automation adapter (Playwright).
//
// REI BlackBook has no public API, so this drives the real web UI exactly as
// the SOP describes: log in, search Property Pipeline (full -> partial address
// -> owner name), then Smart Contacts (owner name); read compliance tags,
// property status and contact history; and send the approved SMS.
//
// SAFETY CONTRACT: every read returns either a confident value or marks the
// lead `uncertain`. When uncertain, the SOP engine holds the lead for review
// and NEVER sends a text. A mismatched selector therefore fails safe.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { chromium } from "playwright";
import { MATCH_STATUS, SEARCH_METHOD, OPT_OUT_REASONS } from "./constants.js";
import { APPROVED_MESSAGE } from "./message.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SELECTORS_PATH = path.join(__dirname, "..", "..", "config", "reibb.selectors.json");
const AUTH_STATE_PATH = path.join(__dirname, "..", "..", ".reibb-auth.json");

export class ReiBlackBookAdapter {
  constructor(opts = {}) {
    this.selectors = JSON.parse(fs.readFileSync(SELECTORS_PATH, "utf8"));
    this.loginUrl = opts.loginUrl || process.env.REIBB_LOGIN_URL;
    this.email = opts.email || process.env.REIBB_EMAIL;
    this.password = opts.password || process.env.REIBB_PASSWORD;
    this.headless = opts.headless ?? String(process.env.HEADLESS).toLowerCase() === "true";
    this.slowMo = opts.slowMo ?? Number(process.env.SLOWMO_MS || 0);
    this.actionTimeout = opts.actionTimeout ?? Number(process.env.ACTION_TIMEOUT_MS || 15000);
    this.browser = null;
    this.context = null;
    this.page = null;
  }

  async launch() {
    this.browser = await chromium.launch({ headless: this.headless, slowMo: this.slowMo });
    const contextOpts = { viewport: { width: 1440, height: 900 } };
    // Reuse a saved auth session if present to avoid re-login each run.
    if (fs.existsSync(AUTH_STATE_PATH)) contextOpts.storageState = AUTH_STATE_PATH;
    this.context = await this.browser.newContext(contextOpts);
    this.context.setDefaultTimeout(this.actionTimeout);
    this.page = await this.context.newPage();
    await this.ensureLoggedIn();
  }

  async ensureLoggedIn() {
    const s = this.selectors.login;
    await this.page.goto(this.loginUrl, { waitUntil: "domcontentloaded" });
    // Already logged in via stored session?
    if (await this.isVisible(s.loggedInMarker, 3000)) return;

    if (!this.email || !this.password) {
      throw new Error(
        "REI BlackBook credentials are not set. Set REIBB_EMAIL and REIBB_PASSWORD in .env."
      );
    }
    await this.page.fill(s.emailInput, this.email);
    await this.page.fill(s.passwordInput, this.password);
    await this.page.click(s.submitButton);
    await this.page.waitForSelector(s.loggedInMarker, { timeout: this.actionTimeout }).catch(() => {
      throw new Error(
        "Login to REI BlackBook did not reach the expected post-login page. " +
          "Check REIBB credentials and the login selectors in config/reibb.selectors.json."
      );
    });
    // Persist session for subsequent rows/runs.
    await this.context.storageState({ path: AUTH_STATE_PATH });
  }

  async close() {
    try {
      if (this.context) await this.context.storageState({ path: AUTH_STATE_PATH }).catch(() => {});
      if (this.browser) await this.browser.close();
    } catch {
      /* ignore */
    }
  }

  // -------------------------------------------------------------------------
  // Main entry: gather all SOP facts for one lead.
  // Returns { facts, searchMethod, matchStatus }.
  // -------------------------------------------------------------------------
  async gatherFacts(lead) {
    const trail = [];
    let matched = null; // { matchStatus, searchMethod }

    try {
      matched = await this.searchPropertyPipeline(lead, trail);
      if (!matched) matched = await this.searchSmartContacts(lead, trail);
    } catch (err) {
      // A hard automation failure -> uncertain, never a send.
      return {
        searchMethod: trail.join(" -> ") || "search failed",
        matchStatus: MATCH_STATUS.NOT_FOUND,
        facts: uncertain(`Search failed: ${err.message}`),
      };
    }

    if (!matched) {
      return {
        searchMethod: trail.join(" -> "),
        matchStatus: MATCH_STATUS.NOT_FOUND,
        facts: {
          matchFound: false,
          matchStatus: MATCH_STATUS.NOT_FOUND,
          optOutReasons: [],
          propertySold: false,
          soldDate: "",
          propertyListed: false,
          mlsNote: "",
          lastContactDate: null,
          hasDoNotMail: false,
          hasDoNotContact: false,
          uncertain: false,
          uncertainReason: "",
        },
      };
    }

    // We are on the matched record page; read compliance/status/history.
    try {
      const record = await this.readRecord();
      return {
        searchMethod: matched.searchMethod,
        matchStatus: matched.matchStatus,
        facts: { matchFound: true, matchStatus: matched.matchStatus, ...record },
      };
    } catch (err) {
      return {
        searchMethod: matched.searchMethod,
        matchStatus: matched.matchStatus,
        facts: { matchFound: true, matchStatus: matched.matchStatus, ...uncertain(`Could not read record: ${err.message}`) },
      };
    }
  }

  // ----- Search: Property Pipeline (SOP step B) ----------------------------
  async searchPropertyPipeline(lead, trail) {
    const nav = this.selectors.nav;
    const pp = this.selectors.propertyPipeline;

    await this.click(nav.propertyPipelineLink);
    await this.clearPipelineFilters();

    // Full address.
    const fullAddress = [lead.propertyAddress, lead.city, lead.state, lead.zip]
      .filter(Boolean)
      .join(", ");
    trail.push(SEARCH_METHOD.PIPELINE_FULL_ADDRESS);
    if (await this.pipelineSearchAndOpen(fullAddress)) {
      return { matchStatus: MATCH_STATUS.MATCH_PIPELINE_FULL, searchMethod: SEARCH_METHOD.PIPELINE_FULL_ADDRESS };
    }

    // Partial address (street line only).
    if (lead.propertyAddress) {
      trail.push(SEARCH_METHOD.PIPELINE_PARTIAL_ADDRESS);
      if (await this.pipelineSearchAndOpen(lead.propertyAddress)) {
        return { matchStatus: MATCH_STATUS.MATCH_PIPELINE_PARTIAL, searchMethod: SEARCH_METHOD.PIPELINE_PARTIAL_ADDRESS };
      }
    }

    // Owner name.
    if (lead.ownerName) {
      trail.push(SEARCH_METHOD.PIPELINE_OWNER_NAME);
      if (await this.pipelineSearchAndOpen(lead.ownerName)) {
        return { matchStatus: MATCH_STATUS.MATCH_PIPELINE_OWNER, searchMethod: SEARCH_METHOD.PIPELINE_OWNER_NAME };
      }
    }
    return null;
  }

  async clearPipelineFilters() {
    const f = this.selectors.propertyPipeline.filters;
    // Prefer an explicit "Clear Filters" control if present; otherwise this is
    // a no-op and we rely on the search being global. Never throw here.
    if (await this.isVisible(f.clearFiltersButton, 2000)) {
      await this.click(f.clearFiltersButton).catch(() => {});
    }
  }

  async pipelineSearchAndOpen(term) {
    const pp = this.selectors.propertyPipeline;
    return this.searchAndOpen(pp.searchInput, pp.resultRow, pp.resultRowLink, pp.noResultsMarker, term);
  }

  // ----- Search: Smart Contacts (SOP step B) -------------------------------
  async searchSmartContacts(lead, trail) {
    if (!lead.ownerName) return null;
    const nav = this.selectors.nav;
    const sc = this.selectors.smartContacts;
    await this.click(nav.contactsLink);
    await this.click(nav.smartContactsLink).catch(() => {});
    trail.push(SEARCH_METHOD.SMART_CONTACTS_OWNER_NAME);
    if (await this.searchAndOpen(sc.searchInput, sc.resultRow, sc.resultRowLink, sc.noResultsMarker, lead.ownerName)) {
      return { matchStatus: MATCH_STATUS.MATCH_SMART_CONTACTS, searchMethod: SEARCH_METHOD.SMART_CONTACTS_OWNER_NAME };
    }
    return null;
  }

  // Fill a search box, submit, and open the first result if one exists.
  async searchAndOpen(inputSel, rowSel, rowLinkSel, noResultsSel, term) {
    await this.page.fill(inputSel, "");
    await this.page.fill(inputSel, term);
    await this.page.keyboard.press("Enter");
    // Wait for either results or an explicit "no results" marker.
    await this.page.waitForTimeout(800);
    if (await this.isVisible(noResultsSel, 1500)) return false;
    const rows = this.page.locator(rowSel);
    const n = await rows.count().catch(() => 0);
    if (n === 0) return false;
    // Open the first result.
    const link = this.page.locator(rowLinkSel).first();
    if ((await link.count()) > 0) {
      await link.click();
    } else {
      await rows.first().click();
    }
    await this.page.waitForLoadState("domcontentloaded").catch(() => {});
    await this.page.waitForTimeout(500);
    return true;
  }

  // ----- Read compliance / property status / contact history ---------------
  async readRecord() {
    const cr = this.selectors.contactRecord;

    // Opt-outs (SOP step D).
    const optOutReasons = [];
    const badges = cr.optOutBadges;
    if (await this.isVisible(badges.optedOut, 1000)) optOutReasons.push(OPT_OUT_REASONS[0]);
    if (await this.isVisible(badges.smsOptOut, 1000)) optOutReasons.push(OPT_OUT_REASONS[1]);
    if (await this.isVisible(badges.stopRequest, 1000)) optOutReasons.push(OPT_OUT_REASONS[2]);
    if (await this.isVisible(badges.textOptOut, 1000)) optOutReasons.push(OPT_OUT_REASONS[3]);

    // Do Not Mail / Do Not Contact (SOP step G).
    const hasDoNotMail = await this.isVisible(cr.doNotMailTag, 800);
    const hasDoNotContact = await this.isVisible(cr.doNotContactTag, 800);

    // Property status (SOP step E).
    const ps = cr.propertyStatus;
    const propertySold = await this.isVisible(ps.soldMarker, 800);
    const soldDate = propertySold ? await this.textOf(ps.soldDateField) : "";
    const propertyListed = await this.isVisible(ps.listedMarker, 800);
    const mlsNote = propertyListed ? await this.textOf(ps.listedMlsField) : "";

    // Contact history (SOP step F).
    const ch = cr.communicationHistory;
    const historyPresent = await this.isVisible(ch.container, 1200);
    let lastContactDate = null;
    let historyUncertain = false;
    if (historyPresent) {
      const dateText = await this.textOf(ch.mostRecentDateField);
      if (dateText) {
        const parsed = parseDateSafe(dateText);
        if (parsed) lastContactDate = parsed;
        else historyUncertain = true; // there IS history but we can't read the date -> hold
      }
      // No entries -> no prior contact; lastContactDate stays null (eligible path).
    } else {
      // We could not confirm the activity section at all. Fail safe.
      historyUncertain = true;
    }

    if (historyUncertain) {
      return {
        ...uncertain(
          "Found the lead but could not confidently read its contact history date. Held for manual review so no text is sent."
        ),
        optOutReasons,
        hasDoNotMail,
        hasDoNotContact,
        propertySold,
        soldDate,
        propertyListed,
        mlsNote,
        lastContactDate,
      };
    }

    return {
      optOutReasons,
      propertySold,
      soldDate,
      propertyListed,
      mlsNote,
      lastContactDate,
      hasDoNotMail,
      hasDoNotContact,
      uncertain: false,
      uncertainReason: "",
    };
  }

  // ----- Send the approved SMS (SOP step H) --------------------------------
  // Only ever called by the engine after decide() returns shouldSendText AND
  // the live-send switch is on. Returns { sent, timestamp }.
  async sendText() {
    const sms = this.selectors.contactRecord.sms;
    await this.click(sms.openComposerButton);
    await this.page.fill(sms.messageTextarea, "");
    await this.page.fill(sms.messageTextarea, APPROVED_MESSAGE);

    // Verify the composed text matches the approved message EXACTLY before sending.
    const composed = await this.page.inputValue(sms.messageTextarea);
    if (composed !== APPROVED_MESSAGE) {
      throw new Error("Composed SMS text did not exactly match the approved message; send aborted.");
    }
    await this.click(sms.sendButton);
    // Confirm the send actually went through.
    const confirmed = await this.isVisible(sms.sentConfirmationMarker, this.actionTimeout);
    if (!confirmed) {
      throw new Error("Did not see a send-confirmation from REI BlackBook; treating as not sent.");
    }
    return { sent: true, timestamp: new Date().toISOString() };
  }

  // ----- Low-level helpers --------------------------------------------------
  async click(selector) {
    await this.page.locator(selector).first().click({ timeout: this.actionTimeout });
    await this.page.waitForTimeout(200);
  }

  async isVisible(selector, timeout = this.actionTimeout) {
    if (!selector) return false;
    try {
      await this.page.locator(selector).first().waitFor({ state: "visible", timeout });
      return true;
    } catch {
      return false;
    }
  }

  async textOf(selector) {
    if (!selector) return "";
    try {
      const loc = this.page.locator(selector).first();
      if ((await loc.count()) === 0) return "";
      return (await loc.innerText({ timeout: 2000 })).trim();
    } catch {
      return "";
    }
  }
}

function uncertain(reason) {
  return {
    optOutReasons: [],
    propertySold: false,
    soldDate: "",
    propertyListed: false,
    mlsNote: "",
    lastContactDate: null,
    hasDoNotMail: false,
    hasDoNotContact: false,
    uncertain: true,
    uncertainReason: reason,
  };
}

// Parse common date formats seen in CRM activity feeds without pulling in a
// date library. Returns a Date or null.
function parseDateSafe(text) {
  if (!text) return null;
  // Try "MM/DD/YYYY" and "Mon DD, YYYY" and ISO; also relative "X days ago".
  const rel = text.match(/(\d+)\s+day/i);
  if (rel) {
    const d = new Date();
    d.setDate(d.getDate() - Number(rel[1]));
    return d;
  }
  const t = Date.parse(text);
  if (!Number.isNaN(t)) return new Date(t);
  return null;
}
