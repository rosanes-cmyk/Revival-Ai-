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
const DATA_ROOT = process.env.REVIVAL_DATA_DIR || path.join(__dirname, "..", "..");
const PROFILE_DIR = path.join(DATA_ROOT, ".redfin-profile");

// Text that means Redfin is showing its "are you human?" / bot wall.
const HUMAN_CHECK_MARKERS = [
  "press & hold",
  "press and hold",
  "verify you are human",
  "verify you're human",
  "are you a human",
  "additional verification",
  "confirm you are a human",
  "hold to confirm",
  "before we continue",
  "unusual activity",
];

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
    // Persistent, VISIBLE browser profile (like the REI login). Redfin shows an
    // "are you human?" check to automated visits; with a remembered profile the
    // user solves it ONCE in the visible window and it sticks for next time.
    this.context = await chromium.launchPersistentContext(PROFILE_DIR, {
      headless: this.headless, // default false, so the human-check is solvable
      viewport: { width: 1440, height: 900 },
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      slowMo: this.slowMo,
    });
    this.browser = null;
    this.context.setDefaultTimeout(this.actionTimeout);
    this.page = this.context.pages()[0] || (await this.context.newPage());
    // Warm up the homepage and, if the human-check appears, wait for the user
    // to clear it (up to a couple of minutes the first time).
    await this.page.goto(this.baseUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
    await this.passHumanCheck(120000);
  }

  async close() {
    try {
      if (this.context) await this.context.close();
    } catch {
      /* ignore */
    }
  }

  // If Redfin's bot wall is showing, wait for it to clear (the user solves the
  // "press & hold" in the visible window). Returns true once clear, false on
  // timeout. Never throws.
  async passHumanCheck(maxMs = 60000) {
    const deadline = Date.now() + maxMs;
    let warned = false;
    for (;;) {
      const body = (await this.page.locator("body").innerText().catch(() => "")) || "";
      const hay = body.toLowerCase();
      const blocked = HUMAN_CHECK_MARKERS.some((m) => hay.includes(m));
      if (!blocked) return true;
      if (!warned) {
        // Surfaced to server logs; the user just needs to complete it once.
        console.log("[Redfin] Human verification shown — please complete it in the Redfin window. Waiting…");
        warned = true;
      }
      if (Date.now() > deadline) return false;
      await this.page.waitForTimeout(1500);
    }
  }

  /**
   * Look up a property's sold/listed status on Redfin.
   * @returns {{checked:boolean, found:boolean, sold:boolean, soldDate:string,
   *            listed:boolean, listingNote:string, uncertain:boolean, reason:string}}
   */
  async lookupStatus(lead) {
    const out = { checked: true, found: false, sold: false, soldDate: "", soldDateISO: "", listed: false, listingNote: "", offMarket: false, statusLabel: "", propertyUrl: "", uncertain: false, reason: "" };
    // Build accurate search terms. Street-only matches the wrong city (e.g.
    // "Country Club Dr" exists in many towns), so we use street + city + state
    // + ZIP. We de-duplicate parts so a full-address column plus separate
    // city/state/zip columns don't produce "…CA 95682, CAMERON PARK, CA, 95682".
    const street = streetLine(lead.propertyAddress) || String(lead.street || "").trim();
    const clean = (s) => String(s || "").replace(/\s+/g, " ").replace(/\s*,\s*/g, ", ").replace(/(, )+/g, ", ").replace(/^,\s*|,\s*$/g, "").trim();
    const composed = clean([street, lead.city, [lead.state, lead.zip].filter(Boolean).join(" ")].filter(Boolean).join(", "));
    const terms = [];
    const add = (t) => { const v = clean(t); if (v && !terms.some((x) => x.toLowerCase() === v.toLowerCase())) terms.push(v); };
    add(composed);                 // "3240 COUNTRY CLUB DR, CAMERON PARK, CA 95682"
    add(lead.propertyAddress);     // whatever the sheet had, in case it's cleaner
    add([street, lead.zip].filter(Boolean).join(" ")); // street + ZIP fallback
    if (!terms.length) return { ...out, uncertain: true, reason: "no address to search" };

    try {
      let opened = false;
      for (const term of terms) {
        if (await this.searchAndOpen(term)) { opened = true; break; }
      }
      if (!opened) return { ...out, uncertain: true, reason: "could not open the Redfin property page (search or human-check)" };

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
        out.statusLabel = /pending|contingent|under contract|backup/i.test(listedHit) ? "Pending" : "For Sale";
      }

      // SOLD: find a "sold on <date>". Always expose the date (so callers can
      // compare it against our last contact date), and flag `sold` when it is
      // within the recent window.
      const soldDate = extractSoldDate(hay);
      if (soldDate.date) {
        out.soldDate = soldDate.text;
        out.soldDateISO = soldDate.date.toISOString();
        const months = monthsBetween(soldDate.date, new Date());
        if (months >= 0 && months <= this.soldWindowMonths) {
          out.sold = true;
          out.listed = false; // an actual recent sale outranks a stale listing note
          out.listingNote = "";
          out.statusLabel = "Sold";
        }
      }

      // OFF MARKET: not for sale and not recently sold. Redfin labels these
      // "OFF MARKET". This does NOT block a text (the owner still owns it) — we
      // just surface it as the property's status.
      if (!out.sold && !out.listed && /off\s*-?\s*market/i.test(hay)) {
        out.offMarket = true;
        out.statusLabel = "Off Market";
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
    // Clear the human-check if it appears before we can search.
    if (!(await this.passHumanCheck(60000))) return false;

    const box = this.page.locator(se.searchInput).first();
    if ((await box.count()) === 0) return false;
    await box.click().catch(() => {});
    await box.fill("");
    await box.type(fullAddress, { delay: 30 });
    await this.page.waitForTimeout(1500); // let autocomplete populate

    // Click the first real suggestion. Do NOT press Enter on a term with no
    // suggestion — that triggers Redfin's "Oops! An error occurred" page. If no
    // suggestion appears, this term didn't match; the caller tries the next one.
    const option = this.page.locator(se.autocompleteOption).first();
    if ((await option.count()) === 0 || !(await option.isVisible().catch(() => false))) {
      return false;
    }
    await option.click().catch(() => {});
    await this.page.waitForLoadState("domcontentloaded").catch(() => {});
    await this.page.waitForTimeout(1500);
    // A human-check can appear after opening a property too.
    await this.passHumanCheck(60000);

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

// The street portion of a full address: "3240 COUNTRY CLUB DR, CAMERON PARK,
// CA 95682" -> "3240 COUNTRY CLUB DR".
function streetLine(address) {
  return String(address || "").split(",")[0].trim();
}
