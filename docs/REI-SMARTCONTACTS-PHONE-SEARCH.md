# REI BlackBook — Search Smart Contacts by Phone Number (for automation)

Self-contained guide for driving REI BlackBook via Playwright to find a contact
by **phone number** in the **Smart Contacts** area and open the record.

Source of truth for selectors: `config/reibb.selectors.json` (app build the
selectors were taken from is noted in the app's build tag).

**Status key:** `CONFIRMED` = matches a label seen in the live account.
`VERIFY` = tolerant best-guess; confirm against the live DOM before relying on
it. `NEEDS-DOM` = must be captured live (no stable text/label).

---

## 0. Base facts

- Login URL: `https://my.reiblackbook.com/services/account/login`
- Contact record URL shape: `https://my.reiblackbook.com/contacts/<id>` (numeric id)
- Smart Contacts holds ~7,800 records; many are named **"Unknown"**, so name
  search is unreliable. Phone/address are better keys.
- The reply/chat box is a **TinyMCE** editor, sometimes inside an **iframe**.

---

## 1. Selectors used for Smart Contacts search

```jsonc
// config/reibb.selectors.json  ->  "smartContacts" and "nav"
nav.contactsLink        : "text=Contacts"                 // VERIFY (top menu)
nav.smartContactsLink   : "text=Smart Contacts"           // VERIFY

smartContacts.searchInput :
  "input[placeholder*='Search' i], input[type='search'], input[aria-label*='search' i], input[name*='search' i], .search input"   // VERIFY
smartContacts.resultRow :
  "table tbody tr, .list-row, [role='row']"               // VERIFY
smartContacts.resultRowLink :
  "table tbody tr td a, .list-row a, [role='row'] a"      // VERIFY
smartContacts.noResultsMarker :
  "text=/no result/i, text=/did not match/i, text=/no records/i"  // VERIFY
```

---

## 2. Step-by-step (phone-number search)

1. **Ensure logged in.** After login, `text=Contacts` is visible and the URL is
   no longer `/login`.

2. **Go to Smart Contacts / Contacts.** Navigate straight to the contacts URL if
   you have it, else click the menu:
   - Click `text=Contacts` (or `text=Smart Contacts`).

3. **Type the phone number into the search box and submit.**
   - Fill `smartContacts.searchInput` with `""` first (clear), then the number.
   - Press `Enter`.
   - Feed **digits only** for reliability, e.g. `5109163995`. REI's search is
     tolerant of `(510) 916-3995` etc., but digits-only avoids format mismatches.

4. **Wait for results to filter** (~1.4s).

5. **Check for "no results".** If `smartContacts.noResultsMarker` is visible →
   no match; stop (or try another key like address/name).

6. **Open the first matching result** via `smartContacts.resultRowLink` (or the
   Name link in `smartContacts.resultRow`).

7. **Fallback — open by direct URL if the click didn't navigate.** REI sometimes
   keeps you on the list. If the URL doesn't match `/contacts/<digits>`, grab the
   first `/contacts/<id>` link on the page and `goto` it directly. This
   guarantees the full record (incl. the Chat/TinyMCE box) loads.

---

## 3. Phone number formats accepted

The app's phone regex accepts all of these; normalize to digits when searching:

```
(+1) 510-916-3995   |   (510) 916-3995   |   510.916.3995   |   5109163995
regex: /(\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/
normalize: String(phone).replace(/\D/g, "")   // -> "5109163995"
```

---

## 4. Minimal Playwright snippet

```js
const SEARCH =
  "input[placeholder*='Search' i], input[type='search'], input[aria-label*='search' i], input[name*='search' i], .search input";
const NO_RESULTS = "text=/no result/i, text=/did not match/i, text=/no records/i";

// 1) go to Contacts
await page.goto("https://my.reiblackbook.com/contacts", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(1200);

// 2) search by phone (digits only)
const phone = "5109163995";
await page.fill(SEARCH, "");
await page.fill(SEARCH, phone);
await page.keyboard.press("Enter");
await page.waitForTimeout(1400);

// 3) no match?
if (await page.locator(NO_RESULTS).first().isVisible().catch(() => false)) {
  return null; // not found by phone
}

// 4) open the first contact result (direct-URL fallback if needed)
let opened = false;
if (!/\/contacts\/\d+/i.test(page.url())) {
  const href = await page.evaluate(() =>
    Array.from(document.querySelectorAll("a[href*='/contacts/']"))
      .map(a => a.href).find(h => /\/contacts\/\d+/i.test(h)) || "");
  if (href) { await page.goto(href, { waitUntil: "domcontentloaded" }); opened = true; }
}
await page.waitForTimeout(1000);
// page.url() should now be https://my.reiblackbook.com/contacts/<id>
```

---

## 5. Reading the contact after it opens (facts)

```jsonc
contactRecord.phone :
  "a[href^='tel:'], text=Phone (Mobile) >> xpath=following::a[1]"   // VERIFY
contactRecord.tags.sectionHeader : "text=Tag(s)"                    // CONFIRMED
contactRecord.tags.chip :
  ".tag-item, .tag, [class*='tag-'], [class*='Tag'] .badge, .badge, .chip, .label, .pill, [class*='chip'], [class*='pill'], [class*='badge']"  // CONFIRMED
contactRecord.history.chatTab : "text=Chat"                         // CONFIRMED
```
- Name / address have **no dedicated selector** yet (`NEEDS-DOM`) — read from the
  record layout or capture live.

---

## 6. Caveats

- Search-box + result-row selectors are **VERIFY** (tolerant guesses). If phone
  search misbehaves, capture the real DOM.
- In the app's normal flow, **phone is a last-resort key** (order: address →
  Property Pipeline → owner name → **phone** → email), because address matches
  far more reliably given the many "Unknown" contacts.

### Capture exact selectors live
```
npx playwright codegen "https://my.reiblackbook.com/contacts"
```
Type a phone → open the result. Paste the generated lines back to lock in the
confirmed `searchInput` and `resultRowLink`.
