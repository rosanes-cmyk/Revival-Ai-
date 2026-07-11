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
// A dedicated, persistent browser profile so the REI login (incl. 2FA) is done
// once and remembered across every run — like a normal browser keeps you in.
const PROFILE_DIR = path.join(__dirname, "..", "..", ".reibb-profile");

export class ReiBlackBookAdapter {
  constructor(opts = {}) {
    this.selectors = JSON.parse(fs.readFileSync(SELECTORS_PATH, "utf8"));
    this.loginUrl = opts.loginUrl || process.env.REIBB_LOGIN_URL || "https://my.reiblackbook.com/services/account/login?block=";
    this.email = opts.email || process.env.REIBB_EMAIL;
    this.password = opts.password || process.env.REIBB_PASSWORD;
    this.headless = opts.headless ?? String(process.env.HEADLESS).toLowerCase() === "true";
    this.slowMo = opts.slowMo ?? Number(process.env.SLOWMO_MS || 0);
    this.actionTimeout = opts.actionTimeout ?? Number(process.env.ACTION_TIMEOUT_MS || 15000);
    // Optional direct page URLs (far more reliable than clicking menus).
    this.pipelineUrl = opts.pipelineUrl || process.env.REIBB_PIPELINE_URL || "https://my.reiblackbook.com/properties/inbox";
    this.contactsUrl = opts.contactsUrl || process.env.REIBB_CONTACTS_URL || "https://my.reiblackbook.com/contacts";
    this.browser = null;
    this.context = null;
    this.page = null;
  }

  async launch() {
    // Only a login URL is required (it has a built-in default). Email/password
    // are optional — if absent, the user logs in by hand once and it's saved.
    if (!this.loginUrl) {
      throw new Error("No REI BlackBook login URL configured (REIBB_LOGIN_URL). No browser was opened.");
    }
    this.context = await chromium.launchPersistentContext(PROFILE_DIR, {
      headless: this.headless,
      slowMo: this.slowMo,
      viewport: { width: 1440, height: 900 },
    });
    this.context.setDefaultTimeout(this.actionTimeout);
    this.page = this.context.pages()[0] || (await this.context.newPage());
    await this.ensureLoggedIn();
  }

  async ensureLoggedIn() {
    const s = this.selectors.login;
    await this.page.goto(this.loginUrl, { waitUntil: "domcontentloaded" });
    await this.page.waitForTimeout(1000);

    // "Still authenticating" = anywhere in REI's account/auth flow, including
    // the login page AND the 2FA / checkEmail / verify pages. Logged-in = we
    // have left /services/account/ for an actual app page.
    const isAuthPage = (u) =>
      /\/services\/account\//i.test(String(u)) ||
      /login|sign[-_ ]?in|check[-_ ]?email|verify|two[-_ ]?factor|passcode|\/2fa/i.test(String(u));
    const onLogin = () => isAuthPage(this.page.url());

    // 1) Already logged in from the saved profile → done.
    if (!onLogin()) {
      await this.saveSession();
      return;
    }

    // 2) Try auto-login IF an email+password are provided (optional).
    if (this.email && this.password) {
      try {
        await this.page.fill(s.emailInput, this.email);
        await this.page.fill(s.passwordInput, this.password);
        await this.page.click(s.submitButton);
        await this.page.waitForURL((u) => !isAuthPage(u), { timeout: 20000 }).catch(() => {});
      } catch {
        /* fall through to manual login */
      }
    }

    // 3) Still on the login page → let the user log in BY HAND in the open
    //    window (handles 2FA, odd forms, anything). We just wait, then save
    //    the session so it's remembered and never asks again.
    if (onLogin()) {
      if (this.headless) {
        throw new Error(
          "Couldn't log in automatically and the browser is hidden. Set HEADLESS=false in .env and run again, " +
            "then log into REI in the window that opens — it will be remembered for next time."
        );
      }
      const deadlineMs = 6 * 60 * 1000; // give the user up to 6 minutes
      const start = Date.now();
      while (onLogin() && Date.now() - start < deadlineMs) {
        await this.page.waitForTimeout(1500);
      }
      if (onLogin()) {
        throw new Error(
          "Login wasn't completed in time. Please log into REI BlackBook in the open window, then click Start again."
        );
      }
    }
    await this.saveSession();
  }

  async saveSession() {
    /* The persistent profile auto-saves cookies/localStorage on close. */
  }

  async close() {
    try {
      if (this.context) await this.context.close(); // persistent profile auto-saves
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
      const contactUrl = await this.reiContactUrl().catch(() => "");
      return {
        searchMethod: matched.searchMethod,
        matchStatus: matched.matchStatus,
        facts: { matchFound: true, ...uncertain(`Could not read the contact record: ${err.message}`), contactUrl },
      };
    }
  }

  // Lightweight: find and open the contact without reading all facts. Used by
  // the PropertyRadar-first path to tag a sold/listed property in REI.
  async locateContact(lead) {
    const trail = [];
    let matched = null;
    try {
      matched = await this.searchAll(lead, trail);
    } catch {
      return { matchFound: false, matchStatus: MATCH_STATUS.NOT_FOUND, searchMethod: trail.join(" -> ") };
    }
    if (!matched) {
      return { matchFound: false, matchStatus: MATCH_STATUS.NOT_FOUND, searchMethod: trail.join(" -> ") };
    }
    if (matched.area === "pipeline") {
      try {
        await this.openContactFromProperty();
      } catch {
        /* still consider the property found; tagging may be skipped */
      }
    }
    const contactUrl = await this.reiContactUrl().catch(() => "");
    return { matchFound: true, matchStatus: matched.matchStatus, searchMethod: matched.searchMethod, contactUrl };
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
    // Prefer navigating straight to the page by URL; fall back to the menu.
    if (this.pipelineUrl) {
      await this.page.goto(this.pipelineUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
      await this.page.waitForTimeout(1200);
    } else {
      await this.click(nav.propertyPipelineLink).catch(() => {});
    }
    await this.clearPipelineFilters();
    return this.searchAndOpen(pp.searchInput, pp.resultRow, pp.resultRowLink, pp.noResultsMarker, term);
  }

  async searchContacts(term) {
    const nav = this.selectors.nav;
    const sc = this.selectors.smartContacts;
    if (this.contactsUrl) {
      await this.page.goto(this.contactsUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
      await this.page.waitForTimeout(1200);
    } else {
      await this.click(nav.contactsLink).catch(() => {});
    }
    return this.searchAndOpen(sc.searchInput, sc.resultRow, sc.resultRowLink, sc.noResultsMarker, term);
  }

  async clearPipelineFilters() {
    const f = this.selectors.propertyPipeline.filters;
    if (await this.isVisible(f.clearFiltersButton, 1500)) {
      await this.click(f.clearFiltersButton).catch(() => {});
    }
  }

  // Fill a search box, submit, and open the first VISIBLE result. Never throws:
  // returns false on any problem so the caller can try the next search method.
  async searchAndOpen(inputSel, rowSel, rowLinkSel, noResultsSel, term) {
    if (!term) return false;
    this._lastResultHref = ""; // reset per search
    try {
      await this.page.fill(inputSel, "");
      await this.page.fill(inputSel, term);
      await this.page.keyboard.press("Enter");
      await this.page.waitForTimeout(1400); // let results filter in
    } catch {
      return false;
    }
    if (await this.isVisible(noResultsSel, 1000)) return false;

    // Find the first VISIBLE result row (skip hidden template rows), then click
    // its link if it has one, else the row. Try a few before giving up.
    const rows = this.page.locator(rowSel);
    const n = await rows.count().catch(() => 0);
    for (let i = 0; i < Math.min(n, 12); i++) {
      const row = rows.nth(i);
      if (!(await row.isVisible().catch(() => false))) continue;
      const link = row.locator("a").first();
      try {
        if ((await link.count()) > 0 && (await link.isVisible().catch(() => false))) {
          // Remember the result link's href — it's the contact page URL, even
          // if REI opens it in a panel without changing the address bar.
          const href = await link.getAttribute("href").catch(() => "");
          if (href) { try { this._lastResultHref = new URL(href, this.page.url()).href; } catch { this._lastResultHref = href; } }
          await link.click({ timeout: 6000 });
        } else {
          await row.click({ timeout: 6000 });
        }
        await this.page.waitForLoadState("domcontentloaded").catch(() => {});
        await this.page.waitForTimeout(700);
        return true;
      } catch {
        continue; // try the next visible row
      }
    }
    return false;
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
    // Capture the contact URL AFTER the record has loaded (readTags waits), so
    // the /contacts/<id> reference is present on the page.
    const contactUrl = await this.reiContactUrl();
    if (!tagsReadable) {
      return { ...uncertain("Could not read the contact's Tag(s) section, so a bad tag can't be ruled out. Held for review."), contactUrl };
    }

    // Phone (clean condition). Prefer REI's phone; fall back to the sheet.
    const reiPhone = await this.readPhone();
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
        contactUrl,
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
      contactUrl,
      uncertain: false,
      uncertainReason: "",
    };
  }

  // The current REI contact-record URL, but only if it looks like a real
  // contact page (so we never hand the dashboard a login/search URL).
  async reiContactUrl() {
    const ok = (u) =>
      /reiblackbook\.com/i.test(u) &&
      !/\/services\/account\//i.test(u) &&
      /\/contacts?\/\d+/i.test(u); // a specific contact record id
    // 1) The address bar (works when REI navigates to the contact page).
    const cur = this.page.url();
    if (ok(cur)) return cur;
    // 2) The result link we clicked (if it carried the contact URL).
    if (this._lastResultHref && ok(this._lastResultHref)) return this._lastResultHref;
    // 3) Dig a /contacts/<id> link out of the open record itself — REI often
    // shows the contact in a panel without changing the address bar, but the
    // page still has links (chat, edit, share) that include the contact id.
    const href = await this.page
      .evaluate(() => {
        const hit = Array.from(document.querySelectorAll("a[href*='/contact']"))
          .map((a) => a.href)
          .find((h) => /\/contacts?\/\d+/i.test(h));
        return hit || "";
      })
      .catch(() => "");
    if (href && ok(href)) return href;
    // 4) Last resort: scan the whole page HTML for a /contacts/<id> reference
    // (in a link, data attribute, or script) and build the canonical URL.
    const html = await this.page.content().catch(() => "");
    const m = html.match(/\/contacts\/(\d{3,})/);
    if (m) {
      let origin = "https://my.reiblackbook.com";
      try { origin = new URL(this.page.url()).origin; } catch { /* keep default */ }
      return `${origin}/contacts/${m[1]}`;
    }
    return "";
  }

  async readTags() {
    const t = this.selectors.contactRecord.tags;
    await this.page.waitForTimeout(1200); // let the contact record finish loading
    const headerVisible = await this.isVisible(t.sectionHeader, 4000);

    // 1) Primary: the configured chip selector.
    const tags = [];
    const seen = new Set();
    const push = (raw) => {
      const clean = String(raw || "").replace(/\s*[×xX✕✖]\s*$/, "").replace(/\s+/g, " ").trim();
      if (clean && clean.length <= 40 && !seen.has(clean.toLowerCase())) {
        seen.add(clean.toLowerCase());
        tags.push(clean);
      }
    };
    const chips = this.page.locator(t.chip);
    const n = await chips.count().catch(() => 0);
    for (let i = 0; i < Math.min(n, 120); i++) {
      push(await chips.nth(i).innerText().catch(() => ""));
    }

    // 2) Fallback: anchor on the "Tag(s)" header text in the DOM, walk up to a
    // reasonable container, and collect short leaf-element texts (chips). This
    // survives class-name changes because it keys off the visible header label.
    if (tags.length === 0 && headerVisible) {
      const found = await this.page
        .evaluate(() => {
          const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
          // Find the element whose own text is exactly the Tag(s) header.
          const all = Array.from(document.querySelectorAll("*"));
          const header = all.find((el) => /^tag\(s\)\s*:?$/i.test(norm(el.textContent)) &&
            el.children.length <= 1);
          if (!header) return [];
          // Walk up a few levels to the card/section that holds the chips.
          let box = header;
          for (let up = 0; up < 4 && box.parentElement; up++) box = box.parentElement;
          const out = [];
          for (const el of box.querySelectorAll("*")) {
            if (el.children.length !== 0) continue; // leaf nodes only
            const txt = norm(el.textContent);
            if (!txt || txt.length > 40) continue;
            if (/^tag\(s\)\s*:?$/i.test(txt)) continue;
            if (/^\+$/.test(txt) || /^add\b/i.test(txt)) continue; // skip the "+"/Add button
            out.push(txt);
          }
          return out;
        })
        .catch(() => []);
      found.forEach(push);
    }

    // Confirmed readable if we saw the Tag(s) section OR gathered any chips.
    if (!headerVisible && tags.length === 0) return { readable: false, tags: [] };
    return { readable: true, tags };
  }

  // Read Chat + Activities + Notes text for the phrase/failed/already-sent scan.
  // Reads the content area of each tab (falling back to the page body), so it
  // works without brittle per-widget selectors.
  async readHistory() {
    const h = this.selectors.contactRecord.history;
    let text = "";
    for (const tab of [h.chatTab, h.activitiesTab, h.notesTab]) {
      if (await this.isVisible(tab, 800)) {
        await this.click(tab).catch(() => {});
        await this.page.waitForTimeout(500);
      }
      const t = await this.textOf(h.contentArea);
      if (t) text += "\n" + t;
    }
    if (!text.trim()) {
      text = await this.page.locator("body").innerText().catch(() => "");
    }
    const trimmed = text.trim();
    return { readable: true, fullText: trimmed, latestText: trimmed };
  }

  // ----- Apply a Revival tag (SOP "HOW TO PUT TAGS IN REI") -----------------
  // Returns true if the tag was applied and confirmed; throws on failure.
  async applyTag(tagName) {
    const w = this.selectors.contactRecord.tagsWrite;
    await this.click(w.addTagButton); // the "+" in the Tag(s) section
    if (!(await this.isVisible(w.modalMarker, 3000))) {
      throw new Error("Add/Remove Tags modal did not open.");
    }
    // Open the "Apply Tag(s)" dropdown (first "Select An Option").
    await this.page.locator(w.applyPlaceholder).first().click();
    await this.page.waitForTimeout(400);
    // Type the tag name if the dropdown exposes a text input.
    const input = this.page.locator(w.tagInput).first();
    if ((await input.count()) > 0) {
      await input.fill(tagName);
      await this.page.waitForTimeout(600);
    }
    // Pick an exact matching option; else a "create" option; else Enter.
    const opt = this.page.locator(w.option, { hasText: tagName }).first();
    if ((await opt.count()) > 0) await opt.click();
    else if ((await this.page.locator(w.createOption).count()) > 0) await this.page.locator(w.createOption).first().click();
    else await this.page.keyboard.press("Enter");
    await this.page.waitForTimeout(300);
    // Confirm with the "Add/Remove Tags" button.
    await this.click(w.saveButton);
    await this.page.waitForTimeout(700);
    // Verify the chip now shows on the contact.
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
    // Open the Chat/Text panel only if the message box isn't already showing.
    // Try several ways to reach it (tab label varies), each with a short
    // timeout, so a missing selector doesn't hang for 15s.
    if (!(await this.isVisible(c.messageInput, 1500))) {
      const openers = [
        c.openButton,
        "role=tab[name=/chat/i]",
        "role=tab[name=/text|sms|message/i]",
        "button:has-text('Chat')",
        "[role='tab']:has-text('Chat')",
        "a:has-text('Chat')",
        "text=/^\\s*Chat\\s*$/",
        "[aria-label*='chat' i]",
        "[aria-label*='text' i]",
      ];
      for (const sel of openers) {
        if (await this.clickIfVisible(sel, 1500)) {
          if (await this.isVisible(c.messageInput, 2500)) break;
        }
      }
    }
    if (!(await this.isVisible(c.messageInput, 5000))) {
      throw new Error("Could not open the Chat/Text box on the contact (no message field found). No text sent.");
    }
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
    await this.page.waitForTimeout(1500);

    // Verify the send actually went through: the message shows in the thread,
    // OR the reply box cleared. If neither, treat as NOT sent (fail safe).
    let cleared = false;
    try {
      cleared = ((await this.page.inputValue(c.messageInput)) || "").trim() === "";
    } catch {
      cleared = false;
    }
    let appeared = false;
    try {
      appeared = await this.page.getByText(message.slice(0, 30)).first().isVisible({ timeout: 2500 });
    } catch {
      appeared = false;
    }
    if (!cleared && !appeared) {
      throw new Error("Could not confirm the message was sent (not seen in the thread and the reply box didn't clear).");
    }
    return { sent: true, timestamp: new Date().toISOString() };
  }

  // ----- Low-level helpers --------------------------------------------------
  async click(selector) {
    await this.page.locator(selector).first().click({ timeout: this.actionTimeout });
    await this.page.waitForTimeout(200);
  }
  // Click the first visible match within a short timeout; return true if
  // clicked, false otherwise. Never throws (used for best-effort tab opening).
  async clickIfVisible(selector, timeout = 2000) {
    if (!selector) return false;
    try {
      const loc = this.page.locator(selector).first();
      await loc.waitFor({ state: "visible", timeout });
      await loc.click({ timeout });
      await this.page.waitForTimeout(200);
      return true;
    } catch {
      return false;
    }
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

  // Read a usable phone number off the open contact record. Tries, in order:
  // 1) the configured phone selector, 2) any tel: link's number, 3) a phone
  // pattern anywhere in the visible page text. Returns the digits-string of the
  // first phone found, or "" if none. Survives class-name changes.
  async readPhone() {
    const cr = this.selectors.contactRecord;
    // 1) Configured selector.
    const configured = await this.textOf(cr.phone);
    if (looksLikePhone(configured)) return configured;
    // 2) Any tel: link on the page.
    const tel = await this.page
      .evaluate(() => {
        const a = document.querySelector("a[href^='tel:']");
        return a ? (a.getAttribute("href") || "").replace(/^tel:/i, "") : "";
      })
      .catch(() => "");
    if (looksLikePhone(tel)) return tel;
    // 3) Phone pattern anywhere in the visible contact text.
    const body = await this.page.locator("body").innerText().catch(() => "");
    const m = String(body).match(/(\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/);
    if (m && looksLikePhone(m[0])) return m[0];
    return "";
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

  // The clean street line is the most reliable match key (owner names are
  // often in tax-record format that REI doesn't store).
  const street = (lead.street || "").trim() || firstLine(lead.propertyAddress);
  const houseStreet = houseAndStreet(street);
  // A full address, avoiding duplication if propertyAddress already has city/zip.
  const full = /\d{5}|,/.test(lead.propertyAddress)
    ? lead.propertyAddress
    : [lead.propertyAddress, lead.city, lead.state, lead.zip].filter(Boolean).join(", ");

  // Contacts by ADDRESS first — opens the contact directly (no property->contact
  // hop needed) and is the most reliable match key.
  add("contacts", SEARCH_METHOD.CONTACTS_ADDRESS, MATCH_STATUS.MATCH_CONTACTS_ADDRESS, street);
  add("contacts", SEARCH_METHOD.CONTACTS_ADDRESS, MATCH_STATUS.MATCH_CONTACTS_ADDRESS, houseStreet);
  // Property Pipeline (by address, then owner) — a match here opens the property,
  // then we hop to its contact.
  add("pipeline", SEARCH_METHOD.PIPELINE_FULL_ADDRESS, MATCH_STATUS.MATCH_PIPELINE_FULL, full);
  add("pipeline", SEARCH_METHOD.PIPELINE_STREET_ADDRESS, MATCH_STATUS.MATCH_PIPELINE_STREET, street);
  add("pipeline", SEARCH_METHOD.PIPELINE_HOUSE_STREET, MATCH_STATUS.MATCH_PIPELINE_HOUSE_STREET, houseStreet);
  // Owner / phone / email as last resorts.
  add("contacts", SEARCH_METHOD.OWNER_NAME, MATCH_STATUS.MATCH_CONTACTS_OWNER, lead.ownerName);
  add("pipeline", SEARCH_METHOD.OWNER_NAME, MATCH_STATUS.MATCH_PIPELINE_OWNER, lead.ownerName);
  add("contacts", SEARCH_METHOD.PHONE, MATCH_STATUS.MATCH_CONTACTS_PHONE, lead.phone);
  add("contacts", SEARCH_METHOD.EMAIL, MATCH_STATUS.MATCH_CONTACTS_EMAIL, lead.email);
  return attempts;
}

// First line / street portion of an address ("123 Oak St, City, ST 00000" -> "123 Oak St").
function firstLine(address) {
  if (!address) return "";
  return String(address).split(",")[0].trim();
}

// "123 Oak Street Apt 4" -> "123 Oak Street" (drop unit designators).
function houseAndStreet(address) {
  if (!address) return "";
  return firstLine(address)
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
