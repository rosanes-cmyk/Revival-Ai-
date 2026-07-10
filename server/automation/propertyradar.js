// PropertyRadar browser-automation adapter (Playwright) — OPTIONAL.
//
// Used only when CHECK_PROPERTYRADAR=true. Looks a property up in PropertyRadar
// and reports whether it is Sold or Listed, to strengthen the SOP's "never text
// a sold/listed home" rule (PropertyRadar's status data is often more reliable
// than REI BlackBook's).
//
// SAFETY: this step can only ADD a sold/listed block, never enable a text. If
// PropertyRadar can't be read confidently, it returns { uncertain:true } and
// the engine simply falls back to the REI BlackBook status.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SELECTORS_PATH = path.join(__dirname, "..", "..", "config", "propertyradar.selectors.json");
const AUTH_STATE_PATH = path.join(__dirname, "..", "..", ".propertyradar-auth.json");

export class PropertyRadarAdapter {
  constructor(opts = {}) {
    this.selectors = JSON.parse(fs.readFileSync(SELECTORS_PATH, "utf8"));
    this.loginUrl = opts.loginUrl || process.env.PROPERTYRADAR_LOGIN_URL || this.selectors.login.loginUrl;
    this.email = opts.email || process.env.PROPERTYRADAR_EMAIL;
    this.password = opts.password || process.env.PROPERTYRADAR_PASSWORD;
    this.headless = opts.headless ?? String(process.env.HEADLESS).toLowerCase() === "true";
    this.slowMo = opts.slowMo ?? Number(process.env.SLOWMO_MS || 0);
    this.actionTimeout = opts.actionTimeout ?? Number(process.env.ACTION_TIMEOUT_MS || 15000);
    // A property whose owner changed within this many months is treated as sold.
    this.soldWindowMonths = opts.soldWindowMonths ?? Number(process.env.PR_SOLD_WINDOW_MONTHS || 18);
    this.browser = null;
    this.context = null;
    this.page = null;
  }

  // Friendly name used in dashboard notes / logs.
  get sourceName() {
    return "PropertyRadar";
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
      throw new Error("PropertyRadar credentials not set (PROPERTYRADAR_EMAIL / PROPERTYRADAR_PASSWORD).");
    }
    await this.page.fill(s.emailInput, this.email);
    await this.page.fill(s.passwordInput, this.password);
    await this.page.click(s.submitButton);
    await this.page.waitForSelector(s.loggedInMarker, { timeout: this.actionTimeout }).catch(() => {
      throw new Error("PropertyRadar login did not reach the expected page. Check credentials/selectors.");
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

  /**
   * Look up a property's sold/listed status.
   * @returns {{checked:boolean, found:boolean, sold:boolean, soldDate:string,
   *            listed:boolean, listingNote:string, uncertain:boolean, reason:string}}
   */
  async lookupStatus(lead) {
    const out = { checked: true, found: false, sold: false, soldDate: "", listed: false, listingNote: "", uncertain: false, reason: "" };
    const full = [lead.propertyAddress, lead.city, lead.state, lead.zip].filter(Boolean).join(", ");
    if (!full) return { ...out, uncertain: true, reason: "no address to search" };
    try {
      const se = this.selectors.search;
      if (await this.isVisible(se.fullAddressTab, 1500)) await this.click(se.fullAddressTab).catch(() => {});
      await this.page.fill(se.addressInput, "");
      await this.page.fill(se.addressInput, full);
      await this.page.waitForTimeout(1000); // let the autocomplete populate

      // Click the autocomplete suggestion to open the property.
      const option = this.page.locator(se.autocompleteOption).first();
      if ((await option.count()) > 0) {
        await option.click();
      } else {
        await this.page.keyboard.press("Enter");
      }
      await this.page.waitForTimeout(1200);
      if (await this.isVisible(se.noResultsMarker, 1000)) return out; // not found -> no override

      const st = this.selectors.status;

      // SOLD: read "Owned Since" and compare to the window.
      const ownedSince = await this.textOf(st.ownedSinceValue);
      const d = parseDateSafe(ownedSince);
      if (d) {
        out.found = true;
        const months = monthsBetween(d, new Date());
        if (months >= 0 && months <= this.soldWindowMonths) {
          out.sold = true;
          out.soldDate = ownedSince;
        }
      }

      // LISTED: open the Listings tab and look for an active listing.
      if (await this.isVisible(st.listingsTab, 1200)) {
        await this.click(st.listingsTab).catch(() => {});
        await this.page.waitForTimeout(700);
        if (await this.isVisible(st.listingActiveMarker, 1000)) {
          out.listed = true;
          out.listingNote = "Active listing (PropertyRadar)";
        }
      }
      return out;
    } catch (err) {
      return { ...out, uncertain: true, reason: err.message };
    }
  }

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

// Parse dates like "Jul 1994", "Jul 08, 2026", "07/1994", ISO. Returns Date|null.
function parseDateSafe(text) {
  if (!text) return null;
  const cleaned = String(text).trim();
  const t = Date.parse(cleaned);
  if (!Number.isNaN(t)) return new Date(t);
  const m = cleaned.match(/([A-Za-z]{3,9})\s+(\d{4})/); // "Jul 1994"
  if (m) {
    const t2 = Date.parse(`${m[1]} 1, ${m[2]}`);
    if (!Number.isNaN(t2)) return new Date(t2);
  }
  const mm = cleaned.match(/(\d{1,2})[/\-](\d{4})/); // "06/2025"
  if (mm) return new Date(Number(mm[2]), Number(mm[1]) - 1, 1);
  return null;
}

function monthsBetween(earlier, later) {
  return (later.getFullYear() - earlier.getFullYear()) * 12 + (later.getMonth() - earlier.getMonth());
}
