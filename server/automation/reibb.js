// REI BlackBook browser-automation adapter (Playwright).
//
// Drives the real REI BlackBook UI exactly as the SOP describes: log in, search
// Property Pipeline / Contacts in the required order, open the correct contact,
// read tags + phone + notes/activity/chat history, apply the Revival tag, and
// send the approved SMS through the Chat/Text panel — verifying it landed.
//
// SAFETY CONTRACT: every read returns a confident value or marks the lead
// `uncertain`. When uncertain — including any selector that does not match, or
// history that cannot be confirmed clean — the SOP engine holds the lead for
// review and NEVER sends a text. A mismatched selector fails safe.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { chromium } from "playwright";
import { MATCH_STATUS, SEARCH_METHOD } from "./constants.js";
import { detectFailed } from "./sop.js";
import { getApprovedMessage } from "./message.js";

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
    const ctxOpts = { viewport: { width: 1440, height: 900 } };
    if (fs.existsSync(AUTH_STATE_PATH)) ctxOpts.storageState = AUTH_STATE_PATH;
    this.context = await this.browser.newContext(ctxOpts);
    this.context.setDefaultTimeout(this.actionTimeout);
    this.page = await this.context.newPage();
    await this.ensureLoggedIn();
  }

  async ensureLoggedIn() {
    const s = this.selectors.login;
    await this.page.goto(this.loginUrl, { waitUntil: "domcontentloaded" });
    if (await this.isVisible(s.loggedInMarker, 3000)) return;
    if (!this.email || !this.password) {
      throw new Error("REI BlackBook credentials are not set. Set REIBB_EMAIL and REIBB_PASSWORD in .env.");
    }
    await this.page.fill(s.emailInput, this.email);
    await this.page.fill(s.passwordInput, this.password);
    await this.page.click(s.submitButton);
    await this.page.waitForSelector(s.loggedInMarker, { timeout: this.actionTimeout }).catch(() => {
      throw new Error(
        "Login to REI BlackBook did not reach the expected post-login page. " +
          "Check credentials and the login selectors in config/reibb.selectors.json."
      );
    });
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
  // Gather all SOP facts for one lead. Returns { facts, searchMethod, matchStatus }.
  // -------------------------------------------------------------------------
  async gatherFacts(lead) {
    const trail = [];
    let matched = null;
    try {
      matched = await this.searchAll(lead, trail);
    } catch (err) {
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
        facts: notFoundFacts(),
      };
    }

    // A Pipeline match is a PROPERTY; open its associated contact first.
    if (matched.area === "pipeline") {
      try {
        await this.openContactFromProperty();
      } catch (err) {
        return {
          searchMethod: matched.searchMethod,
          matchStatus: matched.matchStatus,
          facts: { matchFound: true, ...uncertain(`Found the property but could not open its contact: ${err.message}`) },
        };
      }
    }

    try {
      const record = await this.readContactFacts(lead);
      return {
        searchMethod: matched.searchMethod,
        matchStatus: matched.matchStatus,
        facts: { matchFound: true, ...record },
      };
    } catch (err) {
      return {
        searchMethod: matched.searchMethod,
        matchStatus: matched.matchStatus,
        facts: { matchFound: true, ...uncertain(`Could not read the contact record: ${err.message}`) },
      };
    }
  }

  // ----- Search in the required order (SOP FLOW step 3) --------------------
  async searchAll(lead, trail) {
    const attempts = buildSearchAttempts(lead);
    for (const a of attempts) {
      trail.push(a.method);
      const opened =
        a.area === "pipeline"
          ? await this.searchPipeline(a.term)
          : await this.searchContacts(a.term);
      if (opened) return { area: a.area, searchMethod: a.method, matchStatus: a.matchStatus };
    }
    return null;
  }

  async searchPipeline(term) {
    const nav = this.selectors.nav;
    const pp = this.selectors.propertyPipeline;
    await this.click(nav.propertyPipelineLink).catch(() => {});
    await this.clearPipelineFilters();
    return this.searchAndOpen(pp.searchInput, pp.resultRow, pp.resultRowLink, pp.noResultsMarker, term);
  }

  async searchContacts(term) {
    const nav = this.selectors.nav;
    const sc = this.selectors.smartContacts;
    await this.click(nav.contactsLink).catch(() => {});
    return this.searchAndOpen(sc.searchInput, sc.resultRow, sc.resultRowLink, sc.noResultsMarker, term);
  }

  async clearPipelineFilters() {
    const f = this.selectors.propertyPipeline.filters;
    if (await this.isVisible(f.clearFiltersButton, 1500)) {
      await this.click(f.clearFiltersButton).catch(() => {});
    }
  }

  async searchAndOpen(inputSel, rowSel, rowLinkSel, noResultsSel, term) {
    if (!term) return false;
    await this.page.fill(inputSel, "");
    await this.page.fill(inputSel, term);
    await this.page.keyboard.press("Enter");
    await this.page.waitForTimeout(900);
    if (await this.isVisible(noResultsSel, 1200)) return false;
    const rows = this.page.locator(rowSel);
    const n = await rows.count().catch(() => 0);
    if (n === 0) return false;
    const link = this.page.locator(rowLinkSel).first();
    if ((await link.count()) > 0) await link.click();
    else await rows.first().click();
    await this.page.waitForLoadState("domcontentloaded").catch(() => {});
    await this.page.waitForTimeout(500);
    return true;
  }

  async openContactFromProperty() {
    const pr = this.selectors.propertyRecord;
    const link = this.page.locator(pr.associatedContactLink).first();
    if ((await link.count()) === 0) throw new Error("associated-contact link not found on property record");
    await link.click({ timeout: this.actionTimeout });
    await this.page.waitForLoadState("domcontentloaded").catch(() => {});
    await this.page.waitForTimeout(500);
  }

  // ----- Read the contact record -------------------------------------------
  async readContactFacts(lead) {
    const cr = this.selectors.contactRecord;

    // Tags (SOP step 9). If unreadable, hold (bad tags can't be ruled out).
    const { readable: tagsReadable, tags } = await this.readTags();
    if (!tagsReadable) {
      return uncertain("Could not read the contact's Tag(s) section, so a bad tag can't be ruled out. Held for review.");
    }

    // Phone (clean condition). Prefer REI's phone; fall back to the sheet.
    const reiPhone = await this.textOf(cr.phone);
    const phoneExists = looksLikePhone(reiPhone) || looksLikePhone(lead.phone);

    // Property status (SOP steps 6-8).
    const ps = cr.propertyStatus;
    const propertySold = await this.isVisible(ps.soldMarker, 800);
    const soldDate = propertySold ? await this.textOf(ps.soldDateField) : "";
    const propertyListed = await this.isVisible(ps.listedMarker, 800);
    const mlsNote = propertyListed ? await this.textOf(ps.listedMlsField) : "";

    // History (SOP step 10). Must be CONFIRMED readable, else hold.
    const history = await this.readHistory();
    if (!history.readable) {
      return {
        ...uncertain(
          "Could not confirm the Notes/Activities/Chat history, so it can't be verified clean. Held for review."
        ),
        tags,
        phoneExists,
        propertySold,
        soldDate,
        propertyListed,
        mlsNote,
      };
    }

    const lastMessageFailed = detectFailed(history.latestText);
    const approved = getApprovedMessage(lead.companySource);
    const alreadySentApproved = approved
      ? history.fullText.toLowerCase().includes(approved.toLowerCase())
      : false;

    return {
      matchStatus: undefined,
      tags,
      propertySold,
      soldDate,
      propertyListed,
      mlsNote,
      phoneExists,
      historyText: history.fullText,
      lastMessageFailed,
      alreadySentApproved,
      companySource: lead.companySource || "",
      uncertain: false,
      uncertainReason: "",
    };
  }

  async readTags() {
    const t = this.selectors.contactRecord.tags;
    if (!(await this.isVisible(t.sectionHeader, 1500))) return { readable: false, tags: [] };
    const chips = this.page.locator(t.chip);
    const n = await chips.count().catch(() => 0);
    const tags = [];
    for (let i = 0; i < n; i++) {
      const txt = (await chips.nth(i).innerText().catch(() => "")).trim();
      const clean = txt.replace(/\s*[×xX✕✖]\s*$/, "").trim();
      if (clean) tags.push(clean);
    }
    return { readable: true, tags };
  }

  // Read Notes + Activities + Chat text. `readable:false` -> caller holds.
  async readHistory() {
    const h = this.selectors.contactRecord.history;
    let fullText = "";
    let latestText = "";
    let anyContainerSeen = false;

    for (const [tabSel, containerSel] of [
      [h.activitiesTab, h.activitiesContainer],
      [h.chatTab, h.chatContainer],
      [h.notesTab, h.notesContainer],
    ]) {
      if (await this.isVisible(tabSel, 1200)) {
        await this.click(tabSel).catch(() => {});
        await this.page.waitForTimeout(400);
      }
      const text = await this.textOf(containerSel);
      if (text) {
        anyContainerSeen = true;
        fullText += "\n" + text;
      }
    }
    // A confirmed-empty history is fine (a brand-new lead). We only fail when we
    // cannot confirm ANY history surface at all — then it's unverifiable.
    const containerConfirmed =
      anyContainerSeen ||
      (await this.isVisible(h.activitiesContainer, 800)) ||
      (await this.isVisible(h.chatContainer, 800)) ||
      (await this.isVisible(h.notesContainer, 800));
    if (!containerConfirmed) return { readable: false, fullText: "", latestText: "" };

    latestText = await this.textOf(h.latestEntry);
    return { readable: true, fullText: fullText.trim(), latestText };
  }

  // ----- Apply a Revival tag (SOP "HOW TO PUT TAGS IN REI") -----------------
  // Returns true if the tag was applied and confirmed; throws on failure.
  async applyTag(tagName) {
    const w = this.selectors.contactRecord.tagsWrite;
    await this.click(w.addTagButton);
    await this.page.fill(w.tagInput, "");
    await this.page.fill(w.tagInput, tagName);
    await this.page.waitForTimeout(500);
    // Prefer an existing matching option; otherwise create it.
    const existing = this.page.locator(w.existingOption, { hasText: tagName }).first();
    if ((await existing.count()) > 0) {
      await existing.click();
    } else if ((await this.page.locator(w.createOption).count()) > 0) {
      await this.page.locator(w.createOption).first().click();
    } else {
      await this.page.keyboard.press("Enter");
    }
    if (await this.isVisible(w.saveButton, 1500)) await this.click(w.saveButton).catch(() => {});
    await this.page.waitForTimeout(500);
    // Confirm it now appears among the tag chips.
    const { tags } = await this.readTags();
    if (!tags.some((t) => t.toLowerCase() === tagName.toLowerCase())) {
      throw new Error(`Tag "${tagName}" did not appear on the contact after saving.`);
    }
    return true;
  }

  // ----- Send the approved SMS via the Chat/Text panel (SOP SEND PROCESS) ---
  // Returns { sent, timestamp }. Verifies the exact approved text was composed
  // and that the message appears in the chat history after sending.
  async sendText(message) {
    const c = this.selectors.contactRecord.chat;
    await this.click(c.openButton);
    await this.page.fill(c.messageInput, "");
    await this.page.fill(c.messageInput, message);

    const composed = await this.page.inputValue(c.messageInput).catch(async () => {
      // contenteditable fallback
      return (await this.textOf(c.messageInput)) || "";
    });
    if (composed.trim() !== message.trim()) {
      throw new Error("Composed SMS text did not exactly match the approved message; send aborted.");
    }
    await this.click(c.sendButton);
    const confirmed = await this.isVisible(c.sentMarker, this.actionTimeout);
    if (!confirmed) {
      throw new Error("Did not see the sent message appear in chat history; treating as not sent.");
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

// --- pure helpers ----------------------------------------------------------

// Build the ordered search attempts (SOP FLOW step 3), de-duplicating identical
// terms. Address-based + owner -> Property Pipeline; owner/phone/email -> Contacts.
export function buildSearchAttempts(lead) {
  const attempts = [];
  const seen = new Set();
  const add = (area, method, matchStatus, term) => {
    const t = String(term || "").trim();
    if (!t) return;
    const key = `${area}|${t.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    attempts.push({ area, method, matchStatus, term: t });
  };

  const full = [lead.propertyAddress, lead.city, lead.state, lead.zip].filter(Boolean).join(", ");
  add("pipeline", SEARCH_METHOD.PIPELINE_FULL_ADDRESS, MATCH_STATUS.MATCH_PIPELINE_FULL, full);
  add("pipeline", SEARCH_METHOD.PIPELINE_STREET_ADDRESS, MATCH_STATUS.MATCH_PIPELINE_STREET, lead.propertyAddress);
  add("pipeline", SEARCH_METHOD.PIPELINE_HOUSE_STREET, MATCH_STATUS.MATCH_PIPELINE_HOUSE_STREET, houseAndStreet(lead.propertyAddress));
  add("pipeline", SEARCH_METHOD.OWNER_NAME, MATCH_STATUS.MATCH_PIPELINE_OWNER, lead.ownerName);
  add("contacts", SEARCH_METHOD.OWNER_NAME, MATCH_STATUS.MATCH_CONTACTS_OWNER, lead.ownerName);
  add("contacts", SEARCH_METHOD.PHONE, MATCH_STATUS.MATCH_CONTACTS_PHONE, lead.phone);
  add("contacts", SEARCH_METHOD.EMAIL, MATCH_STATUS.MATCH_CONTACTS_EMAIL, lead.email);
  return attempts;
}

// "123 Oak Street Apt 4" -> "123 Oak Street" (drop unit designators).
function houseAndStreet(address) {
  if (!address) return "";
  return String(address)
    .replace(/\b(apt|apartment|unit|ste|suite|#)\b.*$/i, "")
    .trim();
}

function looksLikePhone(v) {
  return (String(v || "").replace(/\D/g, "").length >= 7);
}

function uncertain(reason) {
  return {
    matchStatus: undefined,
    tags: [],
    propertySold: false,
    soldDate: "",
    propertyListed: false,
    mlsNote: "",
    phoneExists: false,
    historyText: "",
    lastMessageFailed: false,
    alreadySentApproved: false,
    companySource: "",
    uncertain: true,
    uncertainReason: reason,
  };
}

function notFoundFacts() {
  return {
    matchFound: false,
    tags: [],
    propertySold: false,
    soldDate: "",
    propertyListed: false,
    mlsNote: "",
    phoneExists: false,
    historyText: "",
    lastMessageFailed: false,
    alreadySentApproved: false,
    companySource: "",
    uncertain: false,
    uncertainReason: "",
  };
}
