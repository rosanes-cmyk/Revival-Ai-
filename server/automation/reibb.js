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
import { MATCH_STATUS, SEARCH_METHOD, ACTIVE_DEAL_TAG_REGEX, RECENT_CONVERSATION_DAYS } from "./constants.js";
import { detectFailed } from "./sop.js";
import { getApprovedMessage, REVIVAL_NEEDLES, cleanPersonName } from "./message.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SELECTORS_PATH = path.join(__dirname, "..", "..", "config", "reibb.selectors.json");
// A dedicated, persistent browser profile so the REI login (incl. 2FA) is done
// once and remembered across every run — like a normal browser keeps you in.
// Browser profile lives in the writable data dir (the app's install dir is
// read-only when installed to Program Files).
const DATA_ROOT = process.env.REVIVAL_DATA_DIR || path.join(__dirname, "..", "..");
const PROFILE_DIR = path.join(DATA_ROOT, ".reibb-profile");

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
    const opened = await this.searchAndOpen(sc.searchInput, sc.resultRow, sc.resultRowLink, sc.noResultsMarker, term);
    // Clicking a result doesn't always navigate into the record (REI can keep
    // us on the list). If we're not on a contact page, open the first matching
    // contact DIRECTLY by its /contacts/<id> URL so the full record (incl. the
    // Chat/TinyMCE box) loads. This makes matching + sending reliable.
    if (!/\/contacts\/\d+/i.test(this.page.url())) {
      const href = await this.firstContactLink();
      if (href) {
        await this.page.goto(href, { waitUntil: "domcontentloaded" }).catch(() => {});
        await this.page.waitForTimeout(1200);
        return true;
      }
      return opened;
    }
    return opened;
  }

  // ----- READ-ONLY connection self-test helpers -----------------------------
  // Open the Contacts list and return the first contact URL found (for the
  // "Test Connection" check). Never sends anything.
  async firstAnyContactUrl() {
    const url = this.contactsUrl || "https://my.reiblackbook.com/contacts";
    await this.page.goto(url, { waitUntil: "domcontentloaded" }).catch(() => {});
    await this.page.waitForTimeout(1500);
    return await this.firstContactLink();
  }

  // Open one contact and probe everything the safety checks + send rely on —
  // WITHOUT sending: does the record open, can we read tags, can we read the
  // chat, and are the reply box + Send button present (never clicked)?
  async probeContact(url) {
    const out = { opened: false, tagsReadable: false, chatReadable: false, sendBoxPresent: false, sendButtonPresent: false, name: "", error: "" };
    try {
      await this.page.goto(url, { waitUntil: "domcontentloaded" }).catch(() => {});
      await this.page.waitForTimeout(1200);
      out.opened = /\/contacts\/\d+/i.test(this.page.url());
      try { const tg = await this.readTags(); out.tagsReadable = !!tg.readable; } catch { /* leave false */ }
      try { const h = await this.readHistory(); out.chatReadable = !!h.readable; } catch { /* leave false */ }
      const c = (this.selectors.contactRecord && this.selectors.contactRecord.chat) || {};
      try { out.sendBoxPresent = !!(await this.findVisibleAcrossFrames(c.messageInput, 3000)); } catch { /* false */ }
      try { out.sendButtonPresent = !!(await this.findVisibleAcrossFrames(c.sendButton, 2000)); } catch { /* false */ }
    } catch (e) { out.error = e.message; }
    return out;
  }

  // The first matching contact's URL from the search-results page. Tries anchor
  // hrefs, then any /contacts/<id> anywhere in the page HTML (data attrs, JS).
  async firstContactLink() {
    await this.page.waitForTimeout(800); // let results render
    const href = await this.page
      .evaluate(() => {
        const a = Array.from(document.querySelectorAll("a[href*='/contacts/']"))
          .map((x) => x.href)
          .find((h) => /\/contacts\/\d+/i.test(h));
        return a || "";
      })
      .catch(() => "");
    if (href) return href;
    // Fallback: scan the whole results HTML for a contact id.
    const html = await this.page.content().catch(() => "");
    const m = html.match(/\/contacts\/(\d{3,})/);
    if (m) {
      let origin = "https://my.reiblackbook.com";
      try { origin = new URL(this.page.url()).origin; } catch { /* default */ }
      return `${origin}/contacts/${m[1]}`;
    }
    return "";
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

  // Best-effort fingerprint of the CURRENTLY logged-in REI account, read from
  // the live app (localStorage / cookies), so the monthly memory can be scoped
  // per account. Returns a stable short string (email or user id) or "".
  async accountFingerprint() {
    try {
      const blob = await this.page.evaluate(() => {
        const parts = [];
        try {
          for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            parts.push(k + "=" + (localStorage.getItem(k) || ""));
          }
        } catch { /* ignore */ }
        try { parts.push(document.cookie || ""); } catch { /* ignore */ }
        return parts.join("\n");
      }).catch(() => "");
      const s = String(blob || "");
      const email = s.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
      if (email) return email[0].toLowerCase();
      const uid = s.match(/"(?:userId|user_id|accountId|account_id|agencyId|agency_id|uid|id)"\s*:\s*"?(\d{3,})"?/i);
      if (uid) return "uid-" + uid[1];
      return "";
    } catch {
      return "";
    }
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

    // Contact name + address/email — so pulled-from-REI leads show these in the
    // table (they start blank on a pull).
    const contactName = await this.readContactName();
    const addr = await this.readAddressParts();
    const email = await this.readEmailAddress();

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

    // Detect the sending company from REI's "From:" persona (e.g. "PPC LEAD
    // THB" -> Twin Home Buyer, "PPC LEAD EQT" -> Equity Track Inc.). This picks
    // the correct approved template per lead, straight from REI — no Company
    // column needed. Falls back to the sheet/default if not detectable.
    const detectedCompany = await this.readSenderCompany();
    const companySource = detectedCompany || lead.companySource || "";

    // "Failed Number" must be based on the LATEST OUTBOUND TEXT's delivery
    // status, scoped to the chat thread — NOT a stray "failed" anywhere on the
    // page (call notes/activity logs would brand a working number as dead).
    // Prefer the structured chat read (latest outbound bubble's own status);
    // only if that couldn't parse do we fall back to the tightened,
    // SMS-delivery-specific markers — which no longer match a bare "failed" in a
    // call note, so even a whole-text scan stays safe.
    const lastMessageFailed =
      history.latestOutboundFailed === true
        ? true
        : history.latestOutboundFailed === false
          ? false
          : detectFailed(history.fullText); // null → conservative marker scan
    // Cross-machine duplicate guard: if OUR revival text is already anywhere in
    // this contact's REI conversation, don't send again — no matter which
    // computer sent it or which company (EQT/THB) wording was used. Match on the
    // distinctive, name-free phrases shared by the approved messages (current +
    // previous script), since the sent text has the contact's real name filled in.
    const hist = history.fullText.toLowerCase();
    const matchedNeedle = REVIVAL_NEEDLES.find((n) => hist.includes(n));
    const alreadySentApproved = !!matchedNeedle;

    // REI is the source of truth (NOT any local file): find the date next to the
    // revival message in this account's chat. If that date is in the CURRENT
    // calendar month, we've already texted this contact this month. Works no
    // matter which computer or which REI account is logged in.
    const revivalSentAt = matchedNeedle
      ? nearestDateToPhrase(history.fullText, matchedNeedle)
      : null;
    const _now = new Date();
    const revivalSentThisMonth = !!(
      revivalSentAt &&
      revivalSentAt.getFullYear() === _now.getFullYear() &&
      revivalSentAt.getMonth() === _now.getMonth()
    );

    // Active-deal recency: for appointment-booked / offer-sent contacts, find the
    // most recent conversation date so the SOP can decide re-engage vs. skip.
    const activeDealTag = ACTIVE_DEAL_TAG_REGEX.test((tags || []).join(" ") + " " + hist);
    const lastConversationAt = parseLatestDate(history.fullText);
    let lastConversationWithinMonth = null; // null = unknown
    if (lastConversationAt) {
      const ageDays = (Date.now() - lastConversationAt.getTime()) / 86400000;
      lastConversationWithinMonth = ageDays >= 0 && ageDays <= RECENT_CONVERSATION_DAYS;
    }

    return {
      matchStatus: undefined,
      tags,
      propertySold,
      soldDate,
      propertyListed,
      mlsNote,
      phoneExists,
      phone: reiPhone || lead.phone || "",
      ownerName: contactName || "",
      email: email || "",
      propertyAddress: addr.propertyAddress || "",
      city: addr.city || "",
      state: addr.state || "",
      zip: addr.zip || "",
      historyText: history.fullText,
      lastMessageFailed,
      alreadySentApproved,
      revivalSentAt: revivalSentAt ? revivalSentAt.toISOString() : "",
      revivalSentThisMonth,
      activeDealTag,
      lastConversationAt: lastConversationAt ? lastConversationAt.toISOString() : "",
      lastConversationWithinMonth,
      companySource,
      contactUrl,
      uncertain: false,
      uncertainReason: "",
    };
  }

  // Read REI's "From:" sender persona in the Chat panel and map it to a company
  // so the correct approved template is used. Returns "Twin Home Buyer",
  // "Equity Track Inc.", or "" if it can't tell.
  async readSenderCompany() {
    // Poll for up to ~6s so the "From:" sender has time to render. Prefer the
    // From chunk (authoritative), then the whole page. EQT checked first.
    const deadline = Date.now() + 6000;
    const detect = (text) => {
      const t = String(text || "").toLowerCase();
      if (/\beqt\b|equity\s*track/.test(t)) return "Equity Track Inc.";
      if (/\bthb\b|twin\s*home/.test(t)) return "Twin Home Buyer";
      return "";
    };
    do {
      const body = (await this.page.locator("body").innerText().catch(() => "")) || "";
      const m = body.match(/From:\s*([\s\S]{0,80}?)(?:\n\s*\n|Message Length|Personalize|$)/i);
      const fromChunk = m && m[1] ? m[1] : "";
      // From chunk is authoritative — it's the actual sending persona.
      const fromHit = detect(fromChunk);
      if (fromHit) return fromHit;
      const bodyHit = detect(body);
      if (bodyHit) return bodyHit;
      await this.page.waitForTimeout(500);
    } while (Date.now() < deadline);
    return "";
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
    let chatOpened = false;
    // End on the Chat tab so the message box is showing for the send step.
    for (const tab of [h.notesTab, h.activitiesTab, h.chatTab]) {
      if (await this.isVisible(tab, 800)) {
        await this.click(tab).catch(() => {});
        await this.page.waitForTimeout(500);
        if (tab === h.chatTab) {
          chatOpened = true;
          // HARDENING: wait for the conversation to actually FINISH loading
          // before reading, so a recent text (e.g. sent yesterday) can never be
          // missed by reading a half-loaded/skeleton chat. We wait until the
          // reply box is present AND the thread shows real content (a time like
          // "AM/PM" or a message bubble), up to ~8s.
          await this._waitForChatLoaded();
          // Then scroll the whole history in so OLDER messages load into the DOM.
          await this._scrollChatToTop();
          await this.page.waitForTimeout(400);
        }
      }
      const t = await this.textOf(h.contentArea);
      if (t) text += "\n" + t;
    }
    // ALWAYS also capture the full visible page text (which includes the open
    // Chat conversation) — NOT only when the tab containers returned nothing.
    // Otherwise Notes/Activities text can be non-empty while the chat messages
    // are missed, giving a false "not texted" → a duplicate send. This is the
    // primary source the duplicate guard relies on.
    const bodyText = await this.page.locator("body").innerText().catch(() => "");
    if (bodyText) text += "\n" + bodyText;
    const trimmed = text.trim();

    // Whether the LATEST OUTBOUND text message failed to deliver — computed from
    // the CHAT bubbles ONLY (their own status text), never from the whole page.
    // Scanning the whole page for "failed" wrongly flags working numbers when a
    // call note or activity log happens to contain that word. Returns:
    //   true  = latest outbound SMS shows a delivery-failure status
    //   false = latest outbound SMS present and not failed (or no outbound found)
    //   null  = couldn't parse the chat structurally (caller stays conservative)
    const latestOutboundFailed = await this._latestOutboundFailed();
    // FAIL-SAFE: only trust "no revival message found → not texted" if we can
    // confirm the chat actually rendered. If we couldn't open the Chat tab AND
    // the reply box / chat control isn't present, the conversation may have only
    // partially loaded — mark it UNREADABLE so decide() HOLDS the lead for review
    // instead of risking a duplicate text. (An opened-but-empty chat is readable
    // and textable — that's a brand-new lead with no messages.)
    let chatConfirmed = chatOpened;
    if (!chatConfirmed) {
      // Fall back only to the SPECIFIC chat controls — the Chat tab itself or
      // REI's "Write Your Reply" box — NOT a generic contenteditable, so an
      // unrelated textbox on the page can't falsely count as "chat loaded".
      const c = (this.selectors.contactRecord && this.selectors.contactRecord.chat) || {};
      const specificReply =
        "[data-mce-placeholder*='Write Your Reply' i], [aria-placeholder*='Write Your Reply' i], textarea[placeholder*='Write Your Reply' i], body#tinymce[contenteditable='true'], .mce-content-body[contenteditable='true']";
      chatConfirmed =
        (c.openButton && (await this.isVisible(c.openButton, 800))) ||
        (await this.isVisible(specificReply, 800)) ||
        false;
    }
    return { readable: !!chatConfirmed, fullText: trimmed, latestText: trimmed, latestOutboundFailed };
  }

  // Parse the chat bubbles and return whether the MOST RECENT OUTBOUND message
  // shows a delivery-failure status. Scoped to the SMS thread only — call notes
  // and activity logs are never consulted. Best-effort: returns null if the
  // chat can't be parsed into messages, so the caller can stay conservative
  // (better to text a possibly-dead number once — the recheck catches a real
  // undelivered later — than to permanently skip a good lead on a false match).
  async _latestOutboundFailed() {
    const conv = (this.selectors.contactRecord && this.selectors.contactRecord.conversation) || {};
    if (!conv.messageItem) return null;
    let messages = [];
    try {
      messages = await this.page.evaluate((cfg) => {
        const inRe = new RegExp(cfg.inboundClassHint, "i");
        const outRe = new RegExp(cfg.outboundClassHint, "i");
        const items = Array.from(document.querySelectorAll(cfg.messageItem)).slice(0, 400);
        return items.map((el) => {
          const cls = (el.className || "") + " " + ((el.parentElement && el.parentElement.className) || "");
          let dir = "unknown";
          if (outRe.test(cls)) dir = "out";
          else if (inRe.test(cls)) dir = "in";
          const textEl = el.querySelector(cfg.messageText) || el;
          const msgText = (textEl.innerText || textEl.textContent || "").replace(/\s+/g, " ").trim();
          const stEl = el.querySelector(cfg.deliveryStatusText);
          const statusText = stEl ? (stEl.innerText || stEl.textContent || "").replace(/\s+/g, " ").trim() : "";
          return { dir, text: msgText, statusText };
        }).filter((m) => m.text);
      }, conv);
    } catch {
      return null;
    }
    if (!messages.length) return null;
    // The last outbound bubble is the one whose delivery status matters.
    let lastOut = null;
    for (const m of messages) if (m.dir === "out") lastOut = m;
    if (!lastOut) return false; // no outbound message → nothing failed
    const failedRe = new RegExp(conv.failedHint || "failed to send|delivery failed|undeliverable|not delivered", "i");
    // Only the message's OWN status text counts as a failure signal — not its
    // body (a normal message could quote the word "failed").
    return failedRe.test(lastOut.statusText || "");
  }

  // Wait until the Chat conversation has actually rendered (not skeleton/empty),
  // so the duplicate guard never reads a half-loaded chat and miss a recent
  // text. Ready = the reply box is present AND the thread shows real content
  // (a message time like "9:27 AM", a date row, or our sender name "Juan").
  // Best-effort: resolves after ~8s even if the heuristic never trips, so it
  // never hangs the run.
  async _waitForChatLoaded() {
    try {
      await this.page.waitForFunction(() => {
        const txt = (document.body && document.body.innerText) || "";
        const hasReply = !!document.querySelector(
          "[data-mce-placeholder*='Write Your Reply' i],[aria-placeholder*='Write Your Reply' i],textarea[placeholder*='Write Your Reply' i],body#tinymce,.mce-content-body,[contenteditable='true'],div[role='textbox']"
        );
        const hasContent = /\b\d{1,2}:\d{2}\s*(AM|PM)\b/i.test(txt) || /\b(Yesterday|Today)\b/.test(txt) || /juan/i.test(txt);
        return hasReply && hasContent;
      }, { timeout: 8000 });
    } catch { /* proceed with whatever loaded — readable/needle logic still applies */ }
    await this.page.waitForTimeout(300);
  }

  // Scroll the chat/message list to the very top so lazy-loaded older messages
  // render. Finds the tallest scrollable element (the message log) and scrolls
  // it up repeatedly until it stops growing or reaches the top. Best-effort.
  async _scrollChatToTop() {
    try {
      let lastHeight = -1;
      for (let i = 0; i < 14; i++) {
        const info = await this.page.evaluate(() => {
          let best = null, bestH = 0;
          for (const el of document.querySelectorAll("div,section,main,ul,ol")) {
            const s = getComputedStyle(el);
            if (!/(auto|scroll)/.test(s.overflowY)) continue;
            if (el.scrollHeight - el.clientHeight > 40 && el.scrollHeight > bestH) {
              best = el; bestH = el.scrollHeight;
            }
          }
          if (!best) return { atTop: true, height: 0 };
          const atTop = best.scrollTop <= 0;
          best.scrollTop = 0;
          return { atTop, height: best.scrollHeight };
        });
        if (!info || (info.atTop && info.height === lastHeight)) break;
        lastHeight = info.height;
        await this.page.waitForTimeout(350);
      }
    } catch {
      /* best effort — if scrolling fails we still read what's visible */
    }
  }

  // Enumerate contact-record URLs from the REI Contacts list. Collects every
  // /contacts/<id> link, then scrolls / clicks "Next" to load more, until no
  // new ones appear or `max` is reached. DOM-tolerant (keys off the id in the
  // href). Returns an array of absolute contact URLs.
  // Set the contacts list to show as many per page as possible (100) so there
  // are far fewer pages to walk. Best-effort: native <select> first, then a
  // custom dropdown. Returns true if it set it.
  async setPerPage(n = 100) {
    try {
      const selects = this.page.locator("select");
      const cnt = await selects.count().catch(() => 0);
      for (let i = 0; i < cnt; i++) {
        const s = selects.nth(i);
        const opts = (await s.locator("option").allTextContents().catch(() => [])).map((t) => t.trim());
        if (opts.includes(String(n))) {
          await s.selectOption(String(n)).catch(() => {});
          await this.page.waitForTimeout(1800);
          return true;
        }
      }
      // Custom (Chakra) dropdown: click a per-page trigger, then the option.
      const trigger = this.page
        .locator("[data-testid*='per' i], [aria-label*='per page' i], [class*='chakra-select__wrapper'] select")
        .first();
      if ((await trigger.count().catch(() => 0)) > 0) {
        await trigger.click().catch(() => {});
        await this.page.waitForTimeout(500);
        const opt = this.page.locator(`[role='option']:has-text("${n}"), li:has-text("${n}"), button:text-is("${n}")`).first();
        if ((await opt.count().catch(() => 0)) > 0) {
          await opt.click().catch(() => {});
          await this.page.waitForTimeout(1800);
          return true;
        }
      }
    } catch { /* best effort */ }
    return false;
  }

  async enumerateContactIds(max = 10000, onProgress = null) {
    // Keep insertion order and capture name/phone per contact straight from the
    // LIST page (names are shown there, so we don't depend on the detail-page
    // DOM to fill the dashboard). info: url -> { name, phone }.
    const info = new Map();
    // Names/phones read from the list, keyed by url — exposed for the caller.
    this._pulledInfo = info;
    const url = this.contactsUrl || "https://my.reiblackbook.com/contacts";
    await this.page.goto(url, { waitUntil: "domcontentloaded" }).catch(() => {});
    await this.page.waitForTimeout(2000);
    // Show 100 per page (fewer pages to walk = much faster collection).
    await this.setPerPage(100);
    let origin = "https://my.reiblackbook.com";
    try { origin = new URL(this.page.url()).origin; } catch { /* default */ }

    const collect = async () => {
      // For each contact link, grab the visible name (link text or the row's
      // first text cell) and a phone number from the same row if present.
      const records = await this.page
        .evaluate(() => {
          const out = [];
          const nav = /^(rei\s*blackbook|dashboard|contacts?|home|pipeline|notes|activities|tag\(s\)|about|smart|all)$/i;
          const phoneRe = /(\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/;
          const anchors = Array.from(document.querySelectorAll("a[href*='/contacts/']"))
            .filter((a) => /\/contacts\/\d+/i.test(a.getAttribute("href") || a.href || ""));
          for (const a of anchors) {
            const href = a.getAttribute("href") || a.href || "";
            const m = href.match(/\/contacts\/(\d+)/i);
            if (!m) continue;
            const id = m[1];
            // Name: the anchor's own text if it reads like a name.
            let name = (a.textContent || "").trim().replace(/\s+/g, " ");
            if (!name || name.length > 60 || nav.test(name) || !/[a-z]/i.test(name) || /^\d/.test(name)) {
              name = "";
            }
            // Row container to pull name/phone from if the link text wasn't a name.
            const row = a.closest("tr,[role='row'],li,[class*='row'],[class*='Row']") || a.parentElement;
            const rowText = row ? (row.innerText || row.textContent || "") : "";
            let phone = "";
            const pm = rowText.match(phoneRe);
            if (pm) phone = pm[0].trim();
            if (!name && row) {
              // First non-empty, name-looking line in the row.
              const lines = rowText.split("\n").map((s) => s.trim()).filter(Boolean);
              const cand = lines.find(
                (l) => l.length >= 2 && l.length <= 60 && /[a-z]/i.test(l) && !/^\d/.test(l) &&
                  !nav.test(l) && !phoneRe.test(l) && !/@/.test(l)
              );
              if (cand) name = cand;
            }
            // Address, if the list row happens to show one (free — no detail page).
            let address = "";
            const am = rowText.match(/\d{1,6}\s+[^\n,]{2,45},\s*[A-Za-z .'-]{2,30},\s*[A-Z]{2}\s*\d{5}(?:-\d{4})?/);
            if (am) address = am[0].replace(/\s+/g, " ").trim();
            out.push({ id, name, phone, address });
          }
          return out;
        })
        .catch(() => []);
      for (const r of records) {
        const u = `${origin}/contacts/${r.id}`;
        const prev = info.get(u) || {};
        info.set(u, {
          name: prev.name || cleanPersonName(r.name) || "",
          phone: prev.phone || r.phone || "",
          address: prev.address || r.address || "",
        });
      }
    };

    await collect();
    // Try to click a "next page" control. REI uses numbered pages with a "›"
    // arrow, so we look broadly: aria/title "next", Next text, chevron glyphs
    // (› » →), and common pagination classes. Returns true if a click happened.
    const clickNext = async () => {
      const selectors = [
        "button[data-testid='next']:not([disabled])",   // REI (Chakra) next-page button
        "[data-testid='next']:not([disabled])",
        "[data-testid='pagination-next']:not([disabled])",
        "[aria-label*='next' i]:not([disabled])",
        "[title*='next' i]:not([disabled])",
        "button:has-text('Next'):not([disabled])",
        "a:has-text('Next')",
        ".pagination-next:not(.disabled)",
        "li.next:not(.disabled) a",
        "nav[aria-label*='pag' i] button:last-child:not([disabled])",
        "[class*='pagination'] button:last-child:not([disabled])",
      ];
      for (const sel of selectors) {
        const el = this.page.locator(sel).first();
        if ((await el.count().catch(() => 0)) > 0 && (await el.isVisible().catch(() => false)) && !(await el.isDisabled().catch(() => true))) {
          await el.click().catch(() => {});
          return true;
        }
      }
      // Fallback: a clickable element whose trimmed text is a right-arrow glyph.
      const glyph = await this.page.evaluate(() => {
        const arrows = ["›", "»", "→", ">"];
        const els = Array.from(document.querySelectorAll("button, a, li, span"));
        const hit = els.find((e) => arrows.includes((e.textContent || "").trim()) &&
          !e.hasAttribute("disabled") && !/disabled/i.test(e.className || ""));
        if (hit) { hit.click(); return true; }
        return false;
      }).catch(() => false);
      return glyph;
    };

    // Signature of the current page = the list of contact ids visible right now.
    // We use it to confirm that a "Next" click actually loaded a different page
    // before we collect, instead of trusting a fixed wait.
    const pageSignature = async () =>
      (await this.page
        .evaluate(() =>
          Array.from(document.querySelectorAll("a[href*='/contacts/']"))
            .map((a) => (a.getAttribute("href") || "").match(/\/contacts\/(\d+)/i)?.[1])
            .filter(Boolean)
            .join(",")
        )
        .catch(() => "")) || "";

    // Is there a Next control that is present, visible and NOT disabled?
    const nextEnabled = async () => {
      const selectors = [
        "button[data-testid='next']",
        "[data-testid='next']",
        "[data-testid='pagination-next']",
        "[aria-label*='next' i]",
        "[title*='next' i]",
      ];
      for (const sel of selectors) {
        const el = this.page.locator(sel).first();
        if (
          (await el.count().catch(() => 0)) > 0 &&
          (await el.isVisible().catch(() => false)) &&
          !(await el.isDisabled().catch(() => true))
        ) {
          return true;
        }
      }
      return false;
    };

    // Wait until the page id-signature changes (real advance) or time runs out.
    const waitForChange = async (prevSig, timeoutMs = 9000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        await this.page.waitForTimeout(400);
        const sig = await pageSignature();
        if (sig && sig !== prevSig) return sig;
      }
      return null;
    };

    // Walk FORWARD through every page. REI shows newest on page 1 and oldest on
    // the last page, so the collected order is newest -> oldest; we reverse it at
    // the end so the automation works the OLDEST first. We stop ONLY when Next is
    // genuinely disabled (true last page) or after repeated failures to advance.
    let stagnant = 0;
    let pages = 1;
    while (info.size < max) {
      await this.page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
      await this.page.waitForTimeout(500);
      await collect();
      if (onProgress) onProgress(info.size);

      // Truly the last page? Then we're done.
      if (!(await nextEnabled())) break;

      const sigBefore = await pageSignature();
      const advanced = await clickNext();
      if (!advanced) { stagnant++; if (stagnant >= 4) break; continue; }

      // Confirm the list actually changed before collecting the new page.
      const newSig = await waitForChange(sigBefore);
      if (newSig) {
        stagnant = 0;
        pages++;
        await collect();
      } else {
        // Click registered but page didn't change yet — retry a couple times
        // (slow load) before giving up.
        stagnant++;
        if (stagnant >= 4) break;
      }
    }
    if (onProgress) onProgress(info.size);
    const list = Array.from(info.keys()).slice(0, max);
    return String(process.env.REI_PULL_ORDER || "oldest").toLowerCase() === "asis"
      ? list
      : list.reverse();
  }

  // Read a pulled contact's facts by navigating directly to its URL (no search).
  async gatherFactsByUrl(contactUrl) {
    try {
      await this.page.goto(contactUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
      await this.page.waitForTimeout(1200);
      const record = await this.readContactFacts({ companySource: "", phone: "" });
      return {
        searchMethod: "REI contact (pulled)",
        matchStatus: MATCH_STATUS.MATCH_CONTACTS_ADDRESS,
        facts: { matchFound: true, ...record, contactUrl: record.contactUrl || contactUrl },
      };
    } catch (err) {
      return {
        searchMethod: "REI contact (pulled)",
        matchStatus: MATCH_STATUS.MATCH_CONTACTS_ADDRESS,
        facts: { matchFound: true, ...uncertain(`Could not read the pulled contact: ${err.message}`), contactUrl },
      };
    }
  }

  // Re-verify: open a contact by URL and report whether an approved revival
  // message is actually present in the chat. Returns true / false, or null if
  // the contact couldn't be opened/checked. Never sends anything.
  async verifyApprovedMessagePresent(contactUrl) {
    if (!contactUrl) return null;
    try {
      await this.page.goto(contactUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
      await this.page.waitForTimeout(1500);
      for (const sel of ["[role='tab']:has-text('Chat')", "button:has-text('Chat')", "text=Chat"]) {
        if (await this.clickIfVisible(sel, 1200)) break;
      }
      await this.page.waitForTimeout(800);
      const body = ((await this.page.locator("body").innerText().catch(() => "")) || "")
        .replace(/\s+/g, " ")
        .toLowerCase();
      if (!body) return null;
      return REVIVAL_NEEDLES.some((n) => body.includes(n));
    } catch {
      return null;
    }
  }

  // ----- READ-ONLY conversation detail for "Recheck Text Sent" ---------------
  // Opens a contact's Chat, confirms our outbound revival message is present,
  // reads any visible delivery status, and detects a seller reply that came
  // AFTER our message. Returns a structured result. NEVER types, NEVER clicks
  // Send, NEVER writes anything. Degrades safely: an unreadable/unparseable
  // status is "Unknown" or "Needs Recheck" — it never invents "Delivered".
  //
  // @param {string} contactUrl
  // @param {{sentMessageBody?:string, sentTimestamp?:string}} opts
  // @returns {{ok, outboundFound, deliveryStatus, deliveryEvidence,
  //            replyReceived, replyText, replyAt, error}}
  // DIAGNOSTIC: open a contact's Chat and return the RAW text the recheck sees,
  // plus what the label-parser makes of it. Used to fix reply detection against
  // the real REI page instead of guessing. Read-only; sends nothing.
  async dumpChatText(contactUrl) {
    const out = { url: contactUrl, rawText: "", parsed: [], error: "" };
    if (!contactUrl) { out.error = "No contact URL."; return out; }
    try {
      await this.page.goto(contactUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
      await this.page.waitForTimeout(1200);
      for (const sel of ["[role='tab']:has-text('Chat')", "button:has-text('Chat')", "text=Chat"]) {
        if (await this.clickIfVisible(sel, 1200)) break;
      }
      await this.page.waitForTimeout(900);
      await this._waitForChatLoaded();
      await this._scrollChatToTop();
      await this.page.waitForTimeout(300);
      const raw = ((await this.page.locator("body").innerText().catch(() => "")) || "").replace(/\s+/g, " ");
      out.rawText = raw;
      out.parsed = parseConversationByLabels(raw);
    } catch (err) {
      out.error = err.message;
    }
    return out;
  }

  async readConversationDetail(contactUrl, opts = {}) {
    const sentBody = String(opts.sentMessageBody || "");
    const sentIso = opts.sentTimestamp || "";
    const out = {
      ok: false, outboundFound: false,
      deliveryStatus: "Needs Recheck", deliveryEvidence: "",
      replyReceived: false, replyText: "", replyAt: "", error: "",
    };
    if (!contactUrl) { out.error = "No REI contact URL saved for this lead."; return out; }
    const conv = (this.selectors.contactRecord && this.selectors.contactRecord.conversation) || {};
    try {
      await this.page.goto(contactUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
      await this.page.waitForTimeout(1200);
      // Login expired / redirected back to auth → Needs Recheck (not a failure).
      if (/\/services\/account\//i.test(this.page.url())) {
        out.error = "REI login appears to have expired — needs recheck.";
        return out;
      }
      for (const sel of ["[role='tab']:has-text('Chat')", "button:has-text('Chat')", "text=Chat"]) {
        if (await this.clickIfVisible(sel, 1200)) break;
      }
      await this.page.waitForTimeout(900);
      // HARDENING: wait for the conversation to actually finish rendering, and
      // scroll older messages in, BEFORE reading — otherwise a slow/half-loaded
      // chat makes us miss the outbound message and wrongly report "Unknown /
      // could not locate" for a text that really did send.
      await this._waitForChatLoaded();
      await this._scrollChatToTop();
      await this.page.waitForTimeout(300);

      const bodyText = ((await this.page.locator("body").innerText().catch(() => "")) || "").replace(/\s+/g, " ");
      if (!bodyText) { out.error = "Chat did not load."; return out; }
      const bodyLow = bodyText.toLowerCase();

      // Distinctive, name-free chunk of the exact text we sent (drop the first
      // sentence, which carries the contact's name + company).
      const afterFirst = sentBody.split(/[.?!]\s+/).slice(1).join(" ").replace(/\s+/g, " ").trim().toLowerCase();
      const sentChunk = afterFirst.slice(0, 45);

      // Structured message list (best-effort; may be empty if selectors miss).
      let messages = [];
      try {
        messages = await this.page.evaluate((cfg) => {
          const inRe = new RegExp(cfg.inboundClassHint, "i");
          const outRe = new RegExp(cfg.outboundClassHint, "i");
          const items = Array.from(document.querySelectorAll(cfg.messageItem)).slice(0, 400);
          return items.map((el) => {
            const cls = (el.className || "") + " " + ((el.parentElement && el.parentElement.className) || "");
            let dir = "unknown";
            if (outRe.test(cls)) dir = "out";
            else if (inRe.test(cls)) dir = "in";
            const textEl = el.querySelector(cfg.messageText) || el;
            const text = (textEl.innerText || textEl.textContent || "").replace(/\s+/g, " ").trim();
            const tsEl = el.querySelector(cfg.messageTimestamp);
            const ts = tsEl ? (tsEl.getAttribute("datetime") || tsEl.getAttribute("title") || tsEl.innerText || "").trim() : "";
            const stEl = el.querySelector(cfg.deliveryStatusText);
            const statusText = stEl ? (stEl.innerText || stEl.textContent || "").replace(/\s+/g, " ").trim() : "";
            return { dir, text, ts, statusText };
          }).filter((m) => m.text);
        }, conv);
      } catch { /* selectors not present; fall back to body scanning */ }

      // 1) Locate OUR outbound message.
      const needleHit = REVIVAL_NEEDLES.some((n) => bodyLow.includes(n));
      let outIdx = -1;
      if (messages.length) {
        outIdx = messages.findIndex(
          (m) => m.dir !== "in" &&
            ((sentChunk && m.text.toLowerCase().includes(sentChunk)) ||
             REVIVAL_NEEDLES.some((n) => m.text.toLowerCase().includes(n)))
        );
      }
      out.outboundFound = outIdx >= 0 || needleHit || (!!sentChunk && bodyLow.includes(sentChunk));

      // 2) Delivery status — prefer the matched message's own status text; never
      //    invent "Delivered".
      const failedRe = new RegExp(conv.failedHint || "failed|undeliverable", "i");
      const deliveredRe = new RegExp(conv.deliveredHint || "delivered", "i");
      const undeliveredRe = /undeliverable|invalid number|no longer in service|not in service|bounced/i;
      const matchedStatus = outIdx >= 0 ? (messages[outIdx].statusText || messages[outIdx].text) : "";
      const statusHay = (matchedStatus || "").toLowerCase();
      if (statusHay && undeliveredRe.test(statusHay)) { out.deliveryStatus = "Undelivered"; out.deliveryEvidence = matchedStatus.slice(0, 120); }
      else if (statusHay && failedRe.test(statusHay)) { out.deliveryStatus = "Failed"; out.deliveryEvidence = matchedStatus.slice(0, 120); }
      else if (statusHay && deliveredRe.test(statusHay)) { out.deliveryStatus = "Delivered"; out.deliveryEvidence = matchedStatus.slice(0, 120); }
      else if (out.outboundFound) {
        // Message visibly present but no reliable per-message status → Sent
        // (confirmed present), unless a clear failure notice sits in the thread.
        if (/failed to send|message failed|not delivered|could not be delivered|undeliverable/i.test(bodyLow)) {
          out.deliveryStatus = "Failed";
          out.deliveryEvidence = "Failure notice found in conversation.";
        } else {
          out.deliveryStatus = "Sent";
          out.deliveryEvidence = outIdx >= 0 ? "Outbound message located in thread." : "Revival message present in chat.";
        }
      } else {
        out.deliveryStatus = "Unknown";
        out.deliveryEvidence = "Could not locate the outbound revival message in the chat.";
      }

      // 3) Seller reply AFTER our message (inbound, not our outbound, dedup).
      if (messages.length && outIdx >= 0) {
        const laterInbound = messages
          .slice(outIdx + 1)
          .filter((m) => m.dir === "in" && m.text && !REVIVAL_NEEDLES.some((n) => m.text.toLowerCase().includes(n)));
        if (laterInbound.length) {
          const last = laterInbound[laterInbound.length - 1];
          out.replyReceived = true;
          out.replyText = last.text.slice(0, 2000);
          out.replyAt = last.ts || "";
        }
      }

      // 3b) TEXT FALLBACK — the structured DOM parse above usually finds nothing
      // on real REI (its message selectors are unconfirmed), so replies were
      // being missed entirely. REI labels every message with "Sent to: (phone)"
      // (our outbound) or "Received from: (phone)" (the seller's reply). Parse
      // the visible page text by those labels — no fragile selectors — and treat
      // any inbound AFTER our revival message as a reply. This is what makes the
      // reply rate actually accurate.
      if (!out.replyReceived) {
        const convo = parseConversationByLabels(bodyText);
        if (convo.length) {
          let ours = convo.findIndex(
            (m) => m.dir === "out" &&
              ((sentChunk && m.text.toLowerCase().includes(sentChunk)) ||
               REVIVAL_NEEDLES.some((n) => m.text.toLowerCase().includes(n)))
          );
          if (ours < 0) ours = convo.findIndex((m) => m.dir === "out"); // fall back to first outbound
          const laterInbound = convo
            .slice(ours >= 0 ? ours + 1 : 0)
            .filter((m) => m.dir === "in" && m.text && !REVIVAL_NEEDLES.some((n) => m.text.toLowerCase().includes(n)));
          if (laterInbound.length) {
            out.replyReceived = true;
            // Join ALL of the seller's replies so classification sees the full
            // picture (e.g. "open to an offer … I'll think about it") and the
            // dashboard shows everything they said — newest last.
            out.replyText = laterInbound.map((m) => m.text).join(" | ").slice(0, 2000);
            out.replyAt = laterInbound[laterInbound.length - 1].time || "";
            if (out.deliveryStatus === "Unknown") out.deliveryStatus = "Sent"; // a reply proves it sent
          }
        }
      }

      // 3c) LAST-RESORT reply presence — guarantees the reply RATE is right even
      // if bubble parsing didn't cleanly split messages. REI shows the seller's
      // inbound texts with a "Received from: <phone>" label. If that label
      // appears AT ALL in this conversation, the seller replied — count it. We
      // grab the words just before the last such label as the reply text so it
      // can still be classified; if we can't, it's flagged for a human.
      if (!out.replyReceived && /received from/i.test(bodyText)) {
        out.replyReceived = true;
        if (out.deliveryStatus === "Unknown") out.deliveryStatus = "Sent";
        const idx = bodyText.toLowerCase().lastIndexOf("received from");
        // The seller's message text sits just before its "Received from" label.
        const before = bodyText.slice(Math.max(0, idx - 300), idx)
          .replace(/\b\d{1,2}:\d{2}\s*(AM|PM)?\b/gi, " ")
          .replace(/PD ?#:?\s*\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/gi, " ")
          .replace(/\b(Today|Yesterday|Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)\b/gi, " ")
          .replace(/\s+/g, " ").trim();
        out.replyText = before.slice(-500) || "(seller replied — see REI chat)";
      }

      out.ok = true;
      return out;
    } catch (err) {
      out.error = err.message;
      out.deliveryStatus = "Needs Recheck";
      return out;
    }
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
    // Make sure the Chat tab is active (reading history / other tabs may have
    // switched away), then give the message box time to render.
    for (const sel of [
      "[role='tab']:has-text('Chat')",
      "button:has-text('Chat')",
      "a:has-text('Chat')",
      c.openButton,
      "text=Chat",
    ]) {
      if (await this.clickIfVisible(sel, 1500)) break;
    }
    await this.page.waitForTimeout(1500);

    // Find the message box — searching the main page AND any embedded panels
    // (REI renders the chat widget in an iframe on some layouts).
    const field = await this.findVisibleAcrossFrames(c.messageInput, 9000);
    if (!field) {
      const diag = await this.dumpInputCandidates();
      return { sent: false, review: true, reason: "Could not open the Chat/Text box (no message field found). FIELDS SEEN: " + diag };
    }
    // The reply box is a TinyMCE rich-text editor. Type with REAL keystrokes so
    // the app registers the input and ENABLES its Send button (setting text
    // directly leaves the button disabled). Focus, clear, then type.
    await field.click().catch(() => {});
    await field.fill("").catch(() => {});
    try {
      await field.pressSequentially(message, { delay: 12 });
    } catch {
      await this.page.keyboard.type(message, { delay: 12 });
    }
    await this.page.waitForTimeout(500);

    const composed =
      (await field.innerText().catch(async () => (await field.inputValue().catch(() => "")))) || "";
    if (composed.replace(/\s+/g, " ").trim() !== message.replace(/\s+/g, " ").trim()) {
      return { sent: false, review: true, reason: `Composed text did not match the approved message (saw: "${composed.slice(0, 60)}").` };
    }

    const sendBtn = await this.findVisibleAcrossFrames(c.sendButton, 5000);
    if (!sendBtn) {
      return { sent: false, review: true, reason: "Could not find the Send button on the contact." };
    }
    // Wait for the Send button to become ENABLED (it's disabled until the app
    // sees the typed text). If it never enables, REI is refusing to send —
    // usually because the contact is opted out. Report that as a block, not an
    // error, so the row is marked Opted Out.
    for (let i = 0; i < 30; i++) {
      if (!(await sendBtn.isDisabled().catch(() => false))) break;
      await this.page.waitForTimeout(200);
    }
    if (await sendBtn.isDisabled().catch(() => false)) {
      const reason = await this.detectSendBlockReason();
      return { sent: false, blocked: true, reason };
    }

    await sendBtn.click({ timeout: 6000 });
    await this.page.waitForTimeout(500); // start checking quickly (opt-out toast is brief)

    // Confirm the send ONLY by the message actually appearing in the
    // conversation thread. (An empty reply box is NOT proof — REI clears the
    // box for opted-out numbers without sending.) While waiting, also watch for
    // an opt-out / undelivered notice so we can mark Opted Out instead.
    const norm = (s) => String(s || "").replace(/\s+/g, " ").trim().toLowerCase();
    // Confirm the send by finding a distinctive chunk of the EXACT text we just
    // sent in the conversation (main page, not the reply-box iframe). We derive
    // it from `message` after dropping the first sentence (which carries the
    // contact's name + company), so whichever rotating template was picked is
    // confirmed correctly — and an older message already in the thread can't
    // falsely confirm this send.
    const afterFirst = String(message).split(/[.?!]\s+/).slice(1).join(" ");
    const derived = norm(afterFirst).slice(0, 45);
    const needles = derived.length >= 15 ? [derived] : [norm(message).slice(-45)];
    // Only send-rejection toast phrases (e.g. "This number is opted out.") —
    // deliberately narrow so an OLD "reply STOP to opt out" or an old
    // "Undelivered" message in the history doesn't trigger a false block.
    const optOutRe = /number is opted out|is opted out|has opted out|opted out\.|unable to send|cannot be sent|could not be sent|not allowed to text/;
    const confirmMs = Number(process.env.SEND_CONFIRM_MS || 25000);
    const deadline = Date.now() + confirmMs;
    let appeared = false;
    let optedOut = false;
    while (!appeared && !optedOut && Date.now() < deadline) {
      const pageText = norm(await this.page.locator("body").innerText().catch(() => ""));
      // Send-rejection toast?
      if (optOutRe.test(pageText)) { optedOut = true; break; }
      // Our message now in the conversation (main page, not the reply box)?
      if (needles.some((n) => pageText.includes(n))) { appeared = true; break; }
      await this.page.waitForTimeout(500);
    }
    if (appeared) {
      return { sent: true, timestamp: new Date().toISOString() };
    }
    if (optedOut) {
      return { sent: false, blocked: true, reason: "Opted out / message not delivered (REI did not send)." };
    }
    return { sent: false, review: true, reason: "Message never appeared in the conversation — not confirmed sent." };
  }

  // When the Send button won't enable, figure out why. Look for opt-out / do-
  // not-text signals near the chat; default to a generic "opted out" note since
  // REI most commonly disables sending for opted-out contacts.
  async detectSendBlockReason() {
    const body = ((await this.page.locator("body").innerText().catch(() => "")) || "").toLowerCase();
    if (/opt(ed)?[\s-]*out|unsubscrib|do not text|do not contact|dnc\b|has opted/.test(body)) {
      return "Opted out — REI is blocking texts to this contact.";
    }
    return "REI would not enable sending for this contact (appears opted out / not textable).";
  }

  // Diagnostic: list the input-like fields actually present (across frames), so
  // the real "Write Your Reply" element can be identified from the logs.
  async dumpInputCandidates() {
    const parts = [];
    // Where are we + is the reply box text present at all?
    let head = "";
    try {
      const url = this.page.url();
      const body = (await this.page.locator("body").innerText().catch(() => "")) || "";
      head = `URL=${url.replace(/^https?:\/\/[^/]+/, "")} replyText=${/write your reply/i.test(body) ? "YES" : "no"} :: `;
    } catch { /* ignore */ }
    parts.push(head);
    for (const frame of this.page.frames()) {
      try {
        const items = await frame.evaluate(() => {
          const els = Array.from(
            document.querySelectorAll("textarea, input, [contenteditable], [role='textbox']")
          );
          return els.slice(0, 12).map((e) => {
            const tag = e.tagName.toLowerCase();
            const ph = e.getAttribute("placeholder") || "";
            const al = e.getAttribute("aria-label") || "";
            const role = e.getAttribute("role") || "";
            const ce = e.getAttribute("contenteditable");
            const vis = !!e.offsetParent;
            return (
              tag +
              (ph ? `[ph="${ph.slice(0, 22)}"]` : "") +
              (al ? `[al="${al.slice(0, 18)}"]` : "") +
              (role ? `[role=${role}]` : "") +
              (ce !== null ? `[ce=${ce || "true"}]` : "") +
              (vis ? "(vis)" : "(hidden)")
            );
          });
        });
        if (items.length) parts.push(items.join(" | "));
      } catch {
        /* skip frame */
      }
    }
    return (parts.join(" || ") || "none").slice(0, 700);
  }

  // Find the first visible element matching `selector` across the main page and
  // all embedded frames (iframes). Returns a Locator or null. Retries until the
  // timeout so late-rendering widgets are caught.
  async findVisibleAcrossFrames(selector, timeoutMs = 6000) {
    const deadline = Date.now() + timeoutMs;
    do {
      for (const frame of this.page.frames()) {
        try {
          const loc = frame.locator(selector).first();
          if ((await loc.count()) > 0 && (await loc.isVisible().catch(() => false))) return loc;
        } catch {
          /* frame detached / bad selector in this frame — skip */
        }
      }
      await this.page.waitForTimeout(300);
    } while (Date.now() < deadline);
    return null;
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
  // Best-effort read of the contact's display name so pulled-from-REI leads
  // show a name in the table. Tries common name headings, then the page title.
  async readContactName() {
    const bad = /rei\s*blackbook|dashboard|contacts?|home|tag\(s\)|activities|notes|about/i;
    const tries = [
      "[class*='contact-name']", "[class*='ContactName']", "[class*='profile-name']",
      "[data-testid*='name']", "header h1", "h1", "h2",
    ];
    for (const sel of tries) {
      try {
        const el = this.page.locator(sel).first();
        if ((await el.count().catch(() => 0)) && (await el.isVisible().catch(() => false))) {
          const t = ((await el.innerText().catch(() => "")) || "").trim().replace(/\s+/g, " ");
          if (t && t.length >= 2 && t.length <= 60 && /[a-z]/i.test(t) && !bad.test(t)) return t;
        }
      } catch { /* try next */ }
    }
    try {
      const title = ((await this.page.title().catch(() => "")) || "")
        .replace(/\s*[-|].*$/i, "")
        .trim();
      if (title && title.length <= 60 && !bad.test(title)) return title;
    } catch { /* ignore */ }
    return "";
  }

  // Best-effort read of an email address anywhere on the contact page.
  async readEmailAddress() {
    try {
      const mailto = await this.page.evaluate(() => {
        const a = document.querySelector("a[href^='mailto:']");
        return a ? (a.getAttribute("href") || "").replace(/^mailto:/i, "").trim() : "";
      }).catch(() => "");
      if (mailto && /@/.test(mailto)) return mailto;
      const text = (await this.page.locator("body").innerText().catch(() => "")) || "";
      const m = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
      return m ? m[0] : "";
    } catch { return ""; }
  }

  // Best-effort read of a US property address from the contact page text, split
  // into address / city / state / zip. Grabs the first "123 St, City, ST 12345".
  async readAddressParts() {
    try {
      const text = ((await this.page.locator("body").innerText().catch(() => "")) || "").replace(/ /g, " ");
      // Match a US address ending in "... ST 12345" whether state and ZIP are
      // together ("CA 94590") or split by a comma ("CA, 94590"), and tolerate
      // extra/empty comma fields in between (e.g. a blank address line 2).
      const m = text.match(/\d{1,6}\s+[^\n]{2,80}?\b[A-Z]{2}\b[\s,]+\d{5}(?:-\d{4})?/);
      if (!m) return {};
      const full = m[0].replace(/\s+/g, " ").trim();
      // State = the 2-letter token right before the ZIP; ZIP = the 5 digits.
      const stZip = full.match(/\b([A-Z]{2})\b[\s,]+(\d{5})(?:-\d{4})?\s*$/);
      const stateTok = stZip ? stZip[1] : "";
      // City = the last non-empty comma field before the state (skip blanks).
      const parts = full.split(",").map((s) => s.trim()).filter(Boolean);
      let city = "";
      for (let i = parts.length - 1; i >= 1; i--) {
        const p = parts[i].replace(/\b[A-Z]{2}\b[\s,]+\d{5}(?:-\d{4})?\s*$/, "").trim();
        if (p && !/^\d/.test(p) && p.toUpperCase() !== stateTok) { city = p; break; }
      }
      return {
        propertyAddress: full,
        street: parts[0] || "",
        city,
        state: stateTok,
        zip: stZip ? stZip[2] : "",
      };
    } catch { return {}; }
  }

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

// Parse a REI chat conversation from the flattened page text using REI's own
// per-message labels, so it works WITHOUT the (unconfirmed) message-bubble DOM
// selectors. Each message is followed by a metadata block like:
//   "... PD #: (650) 431-3006 Sent to: (530) 391-6369 3:14 PM"      (our outbound)
//   "... PD #: (650) 431-3006 Received from: (530) 391-6369 3:37 PM" (seller reply)
// The message TEXT is whatever precedes that block (back to the previous block).
// Returns an ordered [{ dir: "in"|"out", text, time }].
export function parseConversationByLabels(bodyText) {
  const text = String(bodyText || "").replace(/\s+/g, " ");
  // A metadata block: optional leading time, an OPTIONAL "PD #: <phone>", then
  // the direction label, then an OPTIONAL phone, then optional trailing time.
  // Everything except the direction label is optional so small format
  // differences in REI's chat (missing PD#, different phone/time spacing) can't
  // break reply detection.
  const phone = "\\(?\\d{3}\\)?[-.\\s]?\\d{3}[-.\\s]?\\d{4}";
  const time = "\\d{1,2}:\\d{2}\\s*(?:AM|PM)?";
  const blockRe = new RegExp(
    `(?:${time}\\s*)?(?:PD ?#:?\\s*${phone}\\s*)?(Sent to:?|Received from:?)\\s*(?:${phone})?\\s*(${time})?`,
    "gi"
  );
  const msgs = [];
  let lastEnd = 0;
  let m;
  while ((m = blockRe.exec(text)) !== null) {
    const dir = /received/i.test(m[1]) ? "in" : "out";
    const timeStr = (m[2] || "").trim();
    // Message text = everything since the previous block, minus date/time chrome.
    let seg = text.slice(lastEnd, m.index)
      .replace(/\b(Today|Yesterday|Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)\b/gi, " ")
      .replace(new RegExp(time, "gi"), " ")
      .replace(/\s+/g, " ")
      .trim();
    if (seg) msgs.push({ dir, text: seg, time: timeStr });
    lastEnd = blockRe.lastIndex;
  }
  return msgs;
}

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

// Best-effort: find the MOST RECENT date mentioned in a contact's history text
// (chat/activity). Handles "Jul 9, 2026", "July 9 2026", "7/9/2026", "7/9/26",
// and relative "Today"/"Yesterday". Returns a Date or null if none found.
function parseLatestDate(text) {
  const t = String(text || "");
  const now = new Date();
  const found = [];
  const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
  let m;
  const reMonth = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})\b/gi;
  while ((m = reMonth.exec(t))) {
    const mo = MONTHS[m[1].toLowerCase().slice(0, 3)];
    const d = new Date(Number(m[3]), mo, Number(m[2]));
    if (!isNaN(d.getTime())) found.push(d);
  }
  const reNum = /\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/g;
  while ((m = reNum.exec(t))) {
    let y = Number(m[3]);
    if (y < 100) y += 2000;
    const d = new Date(y, Number(m[1]) - 1, Number(m[2]));
    if (!isNaN(d.getTime())) found.push(d);
  }
  if (/\btoday\b/i.test(t)) found.push(new Date(now.getFullYear(), now.getMonth(), now.getDate()));
  if (/\byesterday\b/i.test(t)) { const d = new Date(now); d.setDate(d.getDate() - 1); found.push(d); }
  // Ignore obviously-future dates (parse noise); keep the newest sane one.
  const sane = found.filter((d) => d.getTime() <= now.getTime() + 86400000);
  if (!sane.length) return null;
  return new Date(Math.max(...sane.map((d) => d.getTime())));
}

// Find the date closest to a phrase in chat text (chat bubbles show the message
// and its timestamp near each other). Scans a window around every occurrence of
// the phrase and returns the most recent sane date found, or null.
function nearestDateToPhrase(text, phrase) {
  const t = String(text || "");
  const p = String(phrase || "").toLowerCase();
  if (!p) return null;
  const lower = t.toLowerCase();
  const WIN = 400; // chars on each side of the phrase to search for a date
  const dates = [];
  let idx = lower.indexOf(p);
  while (idx !== -1) {
    const from = Math.max(0, idx - WIN);
    const to = Math.min(t.length, idx + p.length + WIN);
    const d = parseLatestDate(t.slice(from, to));
    if (d) dates.push(d);
    idx = lower.indexOf(p, idx + p.length);
  }
  if (!dates.length) return null;
  return new Date(Math.max(...dates.map((d) => d.getTime())));
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
    revivalSentAt: "",
    revivalSentThisMonth: false,
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
    revivalSentAt: "",
    revivalSentThisMonth: false,
    companySource: "",
    uncertain: false,
    uncertainReason: "",
  };
}
