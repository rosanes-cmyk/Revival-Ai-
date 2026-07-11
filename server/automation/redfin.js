// Redfin property-status adapter (Playwright) — OPTIONAL, no login required.
//
// Used when PROPERTY_SOURCE=redfin. Looks a property up on the public Redfin
// website and reports whether it is currently Listed (for sale / pending) or
// recently Sold, to strengthen the SOP's "never text a sold/listed home" rule.
//
// Redfin is a free public site, so — unlike PropertyRadar — there is no login
// step. We just open the site, search the address, land on the property page,
// and read its status.
//
// SAFETY: this step can only ADD a sold/listed block, never enable a text. If
// Redfin can't be read confidently, it returns { uncertain:true } and the
// engine simply falls back to REI BlackBook's status. Nothing is ever texted
// because Redfin was unsure.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SELECTORS_PATH = path.join(__dirname, "..", "..", "config", "redfin.selectors.json");

export class RedfinAdapter {
  constructor(opts = {}) {
    this.selectors = JSON.parse(fs.readFileSync(SELECTORS_PATH, "utf8"));
    this.baseUrl = opts.baseUrl || process.env.REDFIN_BASE_URL || "https://www.redfin.com";
    this.headless = opts.headless ?? String(process.env.HEADLESS).toLowerCase() === "true";
    this.slowMo = opts.slowMo ?? Number(process.env.SLOWMO_MS || 0);
    this.actionTimeout = opts.actionTimeout ?? Number(process.env.ACTION_TIMEOUT_MS || 15000);
    // A home sold within this many months is treated as sold (owner likely
    // changed). Older sales are the current owner and remain textable.
    this.soldWindowMonths = opts.soldWindowMonths ?? Number(process.env.REDFIN_SOLD_WINDOW_MONTHS || 24);
    this.browser = null;
    this.context = null;
    this.page = null;
  }

  // Friendly name used in dashboard notes / logs.
  get sourceName() {
    return "Redfin";
  }

  async launch() {
    this.browser = await chromium.launch({ headless: this.headless, slowMo: this.slowMo });
    this.context = await this.browser.newContext({
      viewport: { width: 1440, height: 900 },
      // A realistic UA reduces the chance of the bot-wall interstitial.
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    });
    this.context.setDefaultTimeout(this.actionTimeout);
    this.page = await this.context.newPage();
    // Warm up the homepage; no login needed.
    await this.page.goto(this.baseUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
  }

  async close() {
    try {
      if (this.browser) await this.browser.close();
    } catch {
      /* ignore */
    }
  }

  /**
   * Look up a property's sold/listed status on Redfin.
   * @returns {{checked:boolean, found:boolean, sold:boolean, soldDate:string,
   *            listed:boolean, listingNote:string, uncertain:boolean, reason:string}}
   */
  async lookupStatus(lead) {
    const out = { checked: true, found: false, sold: false, soldDate: "", listed: false, listingNote: "", propertyUrl: "", uncertain: false, reason: "" };
    const full = [lead.propertyAddress, lead.city, lead.state, lead.zip].filter(Boolean).join(", ");
    if (!full) return { ...out, uncertain: true, reason: "no address to search" };

    try {
      const opened = await this.searchAndOpen(full);
      if (!opened) return { ...out, uncertain: true, reason: "could not open the Redfin property page" };

      // The live Redfin property URL (for the dashboard "View on Redfin" link).
      const u = this.page.url();
      if (/redfin\.com\/.+\/home\/\d+/i.test(u)) out.propertyUrl = u;

      // Read the status text (a small header pill) plus the whole page body as
      // a fallback, then classify from keywords. Keyword-based so it survives
      // Redfin's frequent class-name changes.
      const st = this.selectors.status;
      const statusText = (await this.textOf(st.statusPill)) || "";
      const bodyText = (await this.page.locator("body").innerText().catch(() => "")) || "";
      const hay = `${statusText}\n${bodyText}`.toLowerCase();

      // A page that never resolved to a single property (search results / map)
      // is not a confident read.
      if (await this.isVisible(st.noResultsMarker, 800)) return { ...out, found: false };

      out.found = true;

      // LISTED / active-market states (for sale, pending, contingent, etc.).
      const listedHit = (this.selectors.listedKeywords || []).find((k) => hay.includes(k.toLowerCase()));
      if (listedHit) {
        out.listed = true;
        out.listingNote = `Redfin status: ${listedHit}`;
      }

      // SOLD: find a "sold on <date>" and check it is within the window.
      const soldDate = extractSoldDate(hay);
      if (soldDate.date) {
        const months = monthsBetween(soldDate.date, new Date());
        if (months >= 0 && months <= this.soldWindowMonths) {
          out.sold = true;
          out.soldDate = soldDate.text;
          out.listed = false; // an actual recent sale outranks a stale listing note
          out.listingNote = "";
        }
      }

      return out;
    } catch (err) {
      return { ...out, uncertain: true, reason: err.message };
    }
  }

  // Type the address into Redfin's search box, take the first suggestion, and
  // wait until a single property page has loaded. Returns true on success.
  async searchAndOpen(fullAddress) {
    const se = this.selectors.search;
    await this.page.goto(this.baseUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
    await this.page.waitForTimeout(600);

    const box = this.page.locator(se.searchInput).first();
    if ((await box.count()) === 0) return false;
    await box.click().catch(() => {});
    await box.fill("");
    await box.type(fullAddress, { delay: 25 });
    await this.page.waitForTimeout(1200); // let autocomplete populate

    // Prefer clicking the first real suggestion; fall back to Enter.
    const option = this.page.locator(se.autocompleteOption).first();
    if ((await option.count()) > 0 && (await option.isVisible().catch(() => false))) {
      await option.click().catch(() => {});
    } else {
      await this.page.keyboard.press("Enter").catch(() => {});
    }
    await this.page.waitForLoadState("domcontentloaded").catch(() => {});
    await this.page.waitForTimeout(1500);

    // Confirm we're on a property detail page (URL contains /home/ or an
    // address-detail marker is visible). Otherwise this was a bad search.
    const url = this.page.url();
    if (/\/home\/\d+/.test(url) || /\/[A-Z]{2}\/.+\/home\//i.test(url)) return true;
    return await this.isVisible(this.selectors.status.detailMarker, 2500);
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

// Pull the most relevant "sold on <date>" out of the page text.
// Returns { date: Date|null, text: string }.
function extractSoldDate(hay) {
  const patterns = [
    /sold\s+on\s+([A-Za-z]{3,9}\s+\d{1,2},\s+\d{4})/i,
    /sold\s+on\s+(\d{1,2}\/\d{1,2}\/\d{4})/i,
    /last\s+sold\s+(?:on\s+)?([A-Za-z]{3,9}\s+\d{1,2},\s+\d{4})/i,
    /last\s+sold\s+(?:on\s+)?(\d{1,2}\/\d{1,2}\/\d{4})/i,
  ];
  for (const re of patterns) {
    const m = hay.match(re);
    if (m) {
      const d = parseDateSafe(m[1]);
      if (d) return { date: d, text: m[1] };
    }
  }
  return { date: null, text: "" };
}

// Parse "Jul 08, 2024", "07/08/2024", "Jul 2024", ISO. Returns Date|null.
function parseDateSafe(text) {
  if (!text) return null;
  const cleaned = String(text).trim();
  const t = Date.parse(cleaned);
  if (!Number.isNaN(t)) return new Date(t);
  const m = cleaned.match(/([A-Za-z]{3,9})\s+(\d{4})/);
  if (m) {
    const t2 = Date.parse(`${m[1]} 1, ${m[2]}`);
    if (!Number.isNaN(t2)) return new Date(t2);
  }
  return null;
}

function monthsBetween(earlier, later) {
  return (later.getFullYear() - earlier.getFullYear()) * 12 + (later.getMonth() - earlier.getMonth());
}
