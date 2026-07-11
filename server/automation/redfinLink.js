// Resolve the EXACT Redfin property-page URL for an address — fast, no browser.
//
// Uses Redfin's public location-autocomplete endpoint (a lightweight JSON GET,
// the same one the Redfin search box calls). This lets the dashboard link each
// address straight to its Redfin page ("check on Redfin"), whether or not the
// full Redfin status automation is enabled.
//
// Fails safe: returns "" on any error/timeout so it never blocks a lead.

const AUTOCOMPLETE = "https://www.redfin.com/stingray/do/location-autocomplete";

export async function resolveRedfinUrl(query, { timeoutMs = 6000 } = {}) {
  const q = String(query || "").trim();
  if (!q || typeof fetch !== "function") return "";
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const url = `${AUTOCOMPLETE}?location=${encodeURIComponent(q)}&v=2`;
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        Accept: "application/json,text/plain,*/*",
        "Accept-Language": "en-US,en;q=0.9",
        Referer: "https://www.redfin.com/",
        "X-Requested-With": "XMLHttpRequest",
      },
    });
    if (!res.ok) return "";
    // Redfin prefixes the JSON with "{}&&" (anti-hijack) and escapes slashes as
    // \/. Unescape first, then regex for a property path — robust to shape
    // changes.
    const text = (await res.text()).replace(/\\\//g, "/");
    const m =
      text.match(/"url":"(\/[^"]*?\/home\/\d+)"/i) || // a specific home page
      text.match(/"(\/[A-Z]{2}\/[^"]+?\/home\/\d+)"/i);
    if (!m) return "";
    const path = m[1];
    return path.startsWith("http") ? path : `https://www.redfin.com${path}`;
  } catch {
    return "";
  } finally {
    clearTimeout(timer);
  }
}
