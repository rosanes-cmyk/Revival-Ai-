// Dashboard frontend: upload, controls, live tabs/table/cards via SSE, recheck,
// percentage report, logs, and per-tab downloads.

const $ = (id) => document.getElementById(id);

const els = {
  chooseBtn: $("chooseBtn"), fileInput: $("fileInput"), fileName: $("fileName"), uploadStatus: $("uploadStatus"),
  startBtn: $("startBtn"), pauseBtn: $("pauseBtn"), resumeBtn: $("resumeBtn"), stopBtn: $("stopBtn"),
  logsBtn: $("logsBtn"), closeLogsBtn: $("closeLogsBtn"), logsDrawer: $("logsDrawer"), logsBody: $("logsBody"),
  tableCard: $("tableCard"), tableHead: $("leadTableHead"), tableBody: $("leadTableBody"),
  statusLabel: $("statusLabel"), liveFlag: $("liveFlag"),
  approvedTHB: $("approvedTHB"), approvedETI: $("approvedETI"),
  liveSendBtn: $("liveSendBtn"), reverifyBtn: $("reverifyBtn"), pullReiBtn: $("pullReiBtn"),
  selfTestBtn: $("selfTestBtn"), selfTestPanel: $("selfTestPanel"), debugChatBtn: $("debugChatBtn"),
  reportBtn: $("reportBtn"),
  shareBar: $("shareBar"), shareUrl: $("shareUrl"), copyShareBtn: $("copyShareBtn"),
  buildTag: $("buildTag"), resetBtn: $("resetBtn"),
  schedEnabled: $("schedEnabled"), schedTime: $("schedTime"), schedNote: $("schedNote"),
  progressWrap: $("progressWrap"), progressFill: $("progressFill"), progressText: $("progressText"),
  finalSummary: $("finalSummary"), finalSummaryBody: $("finalSummaryBody"), toast: $("toast"),
  tabBar: $("tabBar"), tabToolbar: $("tabToolbar"), recheckPanel: $("recheckPanel"),
  percentageCard: $("percentageCard"),
  searchBar: $("searchBar"), leadSearch: $("leadSearch"), searchCount: $("searchCount"),
};

let searchQuery = "";
function matchesSearch(r) {
  if (!searchQuery) return true;
  const hay = [r.ownerName, r.propertyAddress, r.city, r.state, r.zip, r.phone, r.email, r.notes]
    .map((v) => String(v || "").toLowerCase()).join(" ");
  return searchQuery.split(/\s+/).every((term) => hay.includes(term));
}

let hasJob = false;
let allRows = [];
let currentTab = "all";
let recheckRunning = false;
let recheckHasState = false; // a recheck produced progress/results to show

// --- Tabs -------------------------------------------------------------------
const TABS = [
  { key: "all", label: "All Leads" },
  { key: "available-to-text", label: "Available to Text" },
  { key: "text-sent", label: "Text Sent" },
  { key: "property-sold", label: "Property Sold" },
  { key: "not-interested", label: "Not Interested / To Delete" },
  { key: "bad-leads", label: "Bad Leads" },
  { key: "out-of-state", label: "Out of State" },
  { key: "active-deal", label: "Active Deal" },
  { key: "needs-review", label: "Needs Review" },
  { key: "percentage", label: "Percentage Report" },
];

// Mirror of server/data/store.js categorizeRow(): the single result tab a row
// belongs to (besides "all"), or null. Keep in sync with the backend.
function rowTab(r) {
  const d = r.disposition;
  if (r.needsManualReview || d === "Needs Review" || d === "Error") return "needs-review";
  if (r.activeDeal || d === "Recent Contact") return "active-deal";
  if (d === "Text Sent") return "text-sent";
  if (d === "Ready To Text") return "available-to-text";
  if (d === "Not Interested" || d === "Opted Out" || d === "Wrong Number") return "not-interested";
  if (d === "Property Sold" || d === "Listed") return "property-sold";
  if (d === "Out of State") return "out-of-state";
  if (d === "Bad Lead" || d === "Failed Number" || d === "Lead NOT Found") return "bad-leads";
  return null;
}
function rowsForTab(tab) {
  if (tab === "all") return allRows;
  return allRows.filter((r) => rowTab(r) === tab);
}
function tabCounts() {
  const c = { all: allRows.length };
  TABS.forEach((t) => { if (t.key !== "all" && t.key !== "percentage") c[t.key] = 0; });
  for (const r of allRows) { const t = rowTab(r); if (t && t in c) c[t]++; }
  return c;
}

function renderTabs() {
  const counts = tabCounts();
  els.tabBar.innerHTML = TABS.map((t) => {
    const n = t.key === "percentage" ? "" : `<span class="tab-count">${counts[t.key] ?? 0}</span>`;
    return `<button class="tab ${t.key === currentTab ? "active" : ""}" data-tab="${t.key}">${t.label}${n}</button>`;
  }).join("");
  els.tabBar.querySelectorAll(".tab").forEach((b) => (b.onclick = () => setTab(b.dataset.tab)));
}

function setTab(key) {
  currentTab = key;
  renderTabs();
  renderTabToolbar();
  // The search bar applies to the table tabs only — hide it on Percentage.
  if (els.searchBar) els.searchBar.hidden = key === "percentage";
  if (key === "percentage") {
    els.tableCard.hidden = true;
    els.recheckPanel.hidden = true;
    els.percentageCard.hidden = false;
    loadPercentage();
  } else {
    els.percentageCard.hidden = true;
    els.tableCard.hidden = false;
    // Show the recheck panel on the Text Sent tab whenever a recheck is running
    // or has left results to show (so switching away and back restores it).
    els.recheckPanel.hidden = !(key === "text-sent" && (recheckRunning || recheckHasState));
    renderTable();
  }
}

// --- Per-tab toolbar (downloads + Recheck) ----------------------------------
function renderTabToolbar() {
  if (currentTab === "percentage") {
    els.tabToolbar.innerHTML = `
      <div class="toolbar-left" id="pctFilters"></div>
      <div class="toolbar-right">
        <button class="btn btn-small" id="dlPctXlsx">⬇ XLSX</button>
        <button class="btn btn-small" id="dlPctCsv">⬇ CSV</button>
        <button class="btn btn-small" id="dlPctPdf">⬇ PDF</button>
      </div>`;
    $("dlPctXlsx").onclick = () => (window.location = "/api/percentage.xlsx" + pctQuery());
    $("dlPctCsv").onclick = () => (window.location = "/api/percentage.csv" + pctQuery());
    $("dlPctPdf").onclick = () => (window.location = "/api/percentage.pdf" + pctQuery());
    renderPctFilters();
    return;
  }
  let left = "";
  if (currentTab === "text-sent")
    left = `<button class="btn btn-small" id="recheckBtn">🔎 Recheck Text Sent</button>
            <button class="btn btn-small btn-stop" id="recheckStopBtn" hidden>⏹ Stop Recheck</button>`;
  else if (currentTab === "available-to-text")
    left = `<button class="btn btn-small" id="scanBtn">🔄 Build / Refresh (recheck all — no texts sent)</button>`;
  else if (currentTab === "needs-review")
    left = `<button class="btn btn-small" id="recheckNRBtn">🔁 Recheck Needs Review (re-run just these)</button>`;
  els.tabToolbar.innerHTML = `
    <div class="toolbar-left">${left}</div>
    <div class="toolbar-right">
      <span class="dl-lbl">Download this tab:</span>
      <button class="btn btn-small" id="dlXlsx">⬇ XLSX</button>
      <button class="btn btn-small" id="dlCsv">⬇ CSV</button>
    </div>`;
  $("dlXlsx").onclick = () => (window.location = `/api/export?format=xlsx&tab=${currentTab}`);
  $("dlCsv").onclick = () => (window.location = `/api/export?format=csv&tab=${currentTab}`);
  if (currentTab === "text-sent") {
    $("recheckBtn").onclick = startRecheck;
    $("recheckStopBtn").onclick = stopRecheck;
    reflectRecheckButtons();
  }
  if (currentTab === "available-to-text") $("scanBtn").onclick = startScan;
  if (currentTab === "needs-review") $("recheckNRBtn").onclick = startRecheckNeedsReview;
}

// --- Columns (tab-aware) ----------------------------------------------------
function esc(v) {
  return String(v ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
function badgeClass(disp) { return "badge " + String(disp).replace(/[^A-Za-z]/g, ""); }
function reiLink(r, label) {
  const url = r.reiContactUrl;
  if (url && /^https?:\/\//i.test(url)) return `<a class="rei-link" href="${esc(url)}" target="_blank" rel="noopener">${esc(label || "REI")} 🔗</a>`;
  return esc(label || "");
}
function addressCell(r) {
  const addr = esc(r.propertyAddress);
  if (addr && r.propertyStatusUrl && /redfin\.com/i.test(r.propertyStatusUrl))
    return `<a class="rei-link" href="${esc(r.propertyStatusUrl)}" target="_blank" rel="noopener">${addr} 🔗</a>`;
  return addr;
}
function deliveryBadge(r) {
  const s = r.messageDeliveryStatus || "";
  if (!s) return "";
  return `<span class="dstat ${s.replace(/[^A-Za-z]/g, "")}">${esc(s)}</span>`;
}
function replyCell(r) {
  if (!r.replyReceived) return '<span class="dash">No</span>';
  const cls = r.replyClassification ? `<span class="rcls ${esc(r.replyClassification)}">${esc(r.replyClassification.replace(/_/g, " "))}</span>` : "";
  return `${cls}`;
}
// The single clearest "why this lead is where it is" cell — built from the
// actual evidence the backend recorded (safety hit, property status, or the
// full note). Never a guess.
function reasonCell(r) {
  const bits = [];
  if (r.safetyStatus && r.safetyStatus !== "None") bits.push(r.safetyStatus);
  if (r.propertyStatus && /sold|listed|off market/i.test(r.propertyStatus)) bits.push(r.propertyStatus);
  const why = bits.join(" · ") || r.notes || "";
  return `<span class="notes">${esc(why)}</span>`;
}

const COLS_STANDARD = [
  { h: "#", c: (r) => r.rowNumber },
  { h: "Owner", c: (r) => esc(r.ownerName) || '<span class="dash">Unknown</span>' },
  { h: "Property Address", c: addressCell },
  { h: "City", c: (r) => esc(r.city) },
  { h: "State", c: (r) => esc(r.state) },
  { h: "ZIP", c: (r) => esc(r.zip) },
  { h: "Phone", c: (r) => esc(r.phone) },
  { h: "REI", c: (r) => reiLink(r, "View") },
  { h: "Property Status", c: (r) => esc(r.propertyStatus) },
  { h: "Opt-Out / Safety", c: (r) => esc(r.safetyStatus) },
  { h: "Disposition", c: (r) => `<span class="${badgeClass(r.disposition)}">${esc(r.disposition)}</span>` },
  { h: "Why / Reason", c: reasonCell },
  { h: "Reply", c: replyCell },
  { h: "Reply Text", c: (r) => `<span class="notes">${esc(r.replyText)}</span>` },
  { h: "Notes", c: (r) => `<span class="notes">${esc(r.notes)}</span>` },
];

const COLS_TEXT_SENT = [
  { h: "#", c: (r) => r.rowNumber },
  { h: "Owner", c: (r) => esc(r.ownerName) || '<span class="dash">Unknown</span>' },
  { h: "Property Address", c: addressCell },
  { h: "City", c: (r) => esc(r.city) },
  { h: "State", c: (r) => esc(r.state) },
  { h: "ZIP", c: (r) => esc(r.zip) },
  { h: "Phone", c: (r) => esc(r.phone) },
  { h: "REI", c: (r) => reiLink(r, "View") },
  { h: "Message Sent", c: (r) => `<span class="notes">${esc(r.sentMessageBody)}</span>` },
  { h: "Sent At", c: (r) => esc(r.textSentTimestamp) },
  { h: "Delivery", c: deliveryBadge },
  { h: "Evidence", c: (r) => `<span class="notes">${esc(r.deliveryStatusEvidence)}</span>` },
  { h: "Reply?", c: replyCell },
  { h: "Reply Text", c: (r) => `<span class="notes">${esc(r.replyText)}</span>` },
  { h: "Reply At", c: (r) => esc(r.replyReceivedAt) },
  { h: "Reply Class", c: (r) => esc((r.replyClassification || "").replace(/_/g, " ")) },
  { h: "Last Checked", c: (r) => esc(r.messageStatusLastCheckedAt) },
  { h: "Recheck Error", c: (r) => `<span class="error">${esc(r.recheckError)}</span>` },
];

const COLS_ACTIVE = [
  { h: "#", c: (r) => r.rowNumber },
  { h: "Seller", c: (r) => esc(r.ownerName) || '<span class="dash">Unknown</span>' },
  { h: "Property Address", c: addressCell },
  { h: "Phone", c: (r) => esc(r.phone) },
  { h: "REI", c: (r) => reiLink(r, "View") },
  { h: "Seller Reply", c: (r) => `<span class="notes">${esc(r.replyText)}</span>` },
  { h: "Reply At", c: (r) => esc(r.replyReceivedAt) },
  { h: "Why Active Deal", c: (r) => `<span class="notes">${esc(r.activeDealReason || r.notes)}</span>` },
  { h: "REI Stage", c: (r) => esc(r.reiTagApplied || r.eligibilityStatus) },
  { h: "Disposition", c: (r) => `<span class="${badgeClass(r.disposition)}">${esc(r.disposition)}</span>` },
];

function columnsFor(tab) {
  if (tab === "text-sent") return COLS_TEXT_SENT;
  if (tab === "active-deal") return COLS_ACTIVE;
  return COLS_STANDARD;
}

function renderTable() {
  const cols = columnsFor(currentTab);
  els.tableHead.innerHTML = cols.map((c) => `<th>${c.h}</th>`).join("");
  const tabRows = rowsForTab(currentTab);
  const list = tabRows.filter(matchesSearch);
  // Search result count.
  if (els.searchCount) {
    els.searchCount.textContent = searchQuery
      ? `${list.length} of ${tabRows.length} match "${searchQuery}"`
      : "";
  }
  if (!list.length) {
    const msg = searchQuery
      ? `No leads in this tab match "${esc(searchQuery)}".`
      : (allRows.length ? "No leads in this tab yet." : "Upload a spreadsheet or pull from REI to begin.");
    els.tableBody.innerHTML = `<tr class="empty-row"><td colspan="${cols.length}">${msg}</td></tr>`;
    return;
  }
  els.tableBody.innerHTML = list
    .map((r) => `<tr id="row-${r.rowNumber}">${cols.map((c) => `<td>${c.c(r)}</td>`).join("")}</tr>`)
    .join("");
}

// --- Summary cards (Phase 11) ----------------------------------------------
function isTextSent(r) { return !!(r.textSentTimestamp || r.sentMessageBody || r.disposition === "Text Sent"); }
function computeCards() {
  const proc = allRows.filter((r) => r.disposition && r.disposition !== "Pending").length;
  const texted = allRows.filter(isTextSent);
  const delivered = texted.filter((r) => (r.messageDeliveryStatus || "").trim().toLowerCase() === "delivered").length;
  const replies = texted.filter((r) => r.replyReceived).length;
  // Match the server's Percentage Report: an interested lead must have replied.
  const interested = allRows.filter((r) => r.replyReceived && (r.replyClassification || "").trim().toLowerCase() === "interested").length;
  const notInt = allRows.filter((r) => rowTab(r) === "not-interested").length;
  const active = allRows.filter((r) => rowTab(r) === "active-deal").length;
  const bad = allRows.filter((r) => rowTab(r) === "bad-leads").length;
  const needs = allRows.filter((r) => rowTab(r) === "needs-review").length;
  return { leadsProcessed: proc, textsSent: texted.length, delivered, totalReplies: replies,
    interested, notInterested: notInt, activeDeals: active, badLeads: bad, needsReview: needs };
}
function renderCards() {
  const v = computeCards();
  document.querySelectorAll(".stat").forEach((el) => {
    const k = el.dataset.k;
    if (k in v) el.querySelector(".stat-num").textContent = v[k];
  });
}

// --- Data in ----------------------------------------------------------------
function setRows(rows) {
  allRows = rows || [];
  renderTabs();
  renderCards();
  if (currentTab === "percentage") loadPercentage();
  else renderTable();
}
function updateRow(r) {
  const idx = allRows.findIndex((x) => x.rowNumber === r.rowNumber);
  if (idx >= 0) allRows[idx] = r; else allRows.push(r);
  renderTabs();
  renderCards();
  if (currentTab === "percentage") schedulePctReload();
  else renderTable();
}

function toast(msg, kind = "") {
  els.toast.textContent = msg;
  els.toast.className = "toast " + kind;
  els.toast.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (els.toast.hidden = true), 4200);
}
async function api(path, opts) {
  const res = await fetch(path, opts);
  const ct = res.headers.get("content-type") || "";
  const body = ct.includes("json") ? await res.json() : await res.text();
  if (!res.ok) throw new Error((body && body.error) || `Request failed (${res.status})`);
  return body;
}

// --- Percentage Report tab --------------------------------------------------
let pctFilters = { company: "", state: "", deliveryStatus: "", replyClassification: "", sentDate: "", recheckDate: "" };
let _pctTimer = null;
function schedulePctReload() { clearTimeout(_pctTimer); _pctTimer = setTimeout(loadPercentage, 600); }
function pctQuery() {
  const q = Object.entries(pctFilters).filter(([, v]) => v).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
  return q ? "?" + q : "";
}
function renderPctFilters() {
  const box = $("pctFilters");
  if (!box) return;
  const companies = [...new Set(allRows.map((r) => r.companySource).filter(Boolean))];
  const states = [...new Set(allRows.map((r) => r.state).filter(Boolean))];
  const sel = (id, label, opts, val) =>
    `<label class="flt">${label}<select id="${id}"><option value="">All</option>${opts.map((o) => `<option ${o === val ? "selected" : ""}>${esc(o)}</option>`).join("")}</select></label>`;
  box.innerHTML =
    sel("fltCompany", "Company", companies, pctFilters.company) +
    sel("fltState", "State", states, pctFilters.state) +
    sel("fltDelivery", "Delivery", ["Sent", "Delivered", "Failed", "Undelivered", "Unknown", "Needs Recheck"], pctFilters.deliveryStatus) +
    sel("fltReply", "Reply", ["interested", "not_interested", "needs_review"], pctFilters.replyClassification);
  const bind = (id, key) => { const e = $(id); if (e) e.onchange = () => { pctFilters[key] = e.value; loadPercentage(); }; };
  bind("fltCompany", "company"); bind("fltState", "state"); bind("fltDelivery", "deliveryStatus"); bind("fltReply", "replyClassification");
}
async function loadPercentage() {
  if (currentTab !== "percentage") return;
  try {
    const { report } = await api("/api/percentage" + pctQuery());
    renderPercentage(report);
  } catch (e) {
    els.percentageCard.innerHTML = `<p class="muted">Could not load report: ${esc(e.message)}</p>`;
  }
}
let _pctDetailOpen = false;
function renderPercentage(rep) {
  const t = rep.totals, r = rep.rates, rr = rep.replyRates, lr = rep.leadRates, ad = rep.activeDeal;
  const pc = (v) => Number(v || 0).toFixed(1) + "%";
  const n = (v) => Number(v || 0).toLocaleString();

  // At-a-glance headline tiles — the only numbers Juan needs to read in 5 sec.
  const tile = (label, big, sub) =>
    `<div class="kpi"><div class="kpi-num">${big}</div><div class="kpi-lbl">${label}</div>${sub ? `<div class="kpi-sub">${sub}</div>` : ""}</div>`;
  const kpis = `
    <div class="kpi-grid">
      ${tile("Texts Sent", n(t.totalTextsSent), `${pc(lr.textSentPct)} of ${n(t.totalProcessed)} processed`)}
      ${tile("Confirmed Sent", pc(r.confirmedSentRate), `${n(t.confirmedSent)} of ${n(t.totalTextsSent)} in REI`)}
      ${tile("Reply Rate", pc(r.overallReplyRate), `${n(t.totalReplies)} replied`)}
      ${tile("Interested", n(t.interested), `${pc(rr.interestedAmongReplies)} of replies`)}
    </div>`;

  // One short, plain table — result breakdown, no jargon columns.
  const row = (m, tot, p) => `<tr><td>${m}</td><td class="num">${n(tot)}</td><td class="num">${p === "" ? "" : pc(p)}</td></tr>`;
  const simpleTable = `
    <table class="pct-table">
      <thead><tr><th>Result</th><th class="num">Count</th><th class="num">%</th></tr></thead>
      <tbody>
        ${row("Texts sent", t.totalTextsSent, lr.textSentPct)}
        ${row("Confirmed sent (in REI)", t.confirmedSent, r.confirmedSentRate)}
        ${row("Replied", t.totalReplies, r.overallReplyRate)}
        ${row("Interested", t.interested, r.interestedSellerRate)}
        ${row("Not interested", t.notInterested, r.notInterestedRate)}
        ${row("No reply yet", t.noReply, r.noReplyRate)}
        ${row("Property sold / listed", t.propertySold, lr.propertySoldPct)}
        ${row("Active deals", t.activeDeals, lr.activeDealPct)}
      </tbody>
    </table>`;

  // Everything else stays available, tucked behind a toggle so the top stays clean.
  const detail = `
    <table class="pct-table">
      <thead><tr><th>Metric</th><th class="num">Total</th><th class="num">%</th><th>Based on</th></tr></thead>
      <tbody>
        <tr><td>Total leads</td><td class="num">${n(t.totalLeads)}</td><td></td><td class="based"></td></tr>
        <tr><td>Total leads processed</td><td class="num">${n(t.totalProcessed)}</td><td></td><td class="based"></td></tr>
        <tr><td>Failed</td><td class="num">${n(t.failed)}</td><td class="num">${pc(r.failedRate)}</td><td class="based">Texts Sent</td></tr>
        <tr><td>Undelivered</td><td class="num">${n(t.undelivered)}</td><td class="num">${pc(r.undeliveredRate)}</td><td class="based">Texts Sent</td></tr>
        <tr><td>Unknown status</td><td class="num">${n(t.unknownStatus)}</td><td class="num">${pc(r.unknownStatusRate)}</td><td class="based">Texts Sent</td></tr>
        <tr><td>Needs review (replies)</td><td class="num">${n(t.needsReview)}</td><td class="num">${pc(r.needsReviewRate)}</td><td class="based">Texts Sent</td></tr>
        <tr><td>Bad leads</td><td class="num">${n(t.badLeads)}</td><td class="num">${pc(lr.badLeadPct)}</td><td class="based">Leads Processed</td></tr>
        <tr><td>Out of state</td><td class="num">${n(t.outOfState)}</td><td class="num">${pc(lr.outOfStatePct)}</td><td class="based">Leads Processed</td></tr>
        <tr><td>Interested → active deal</td><td class="num">${n(t.activeDeals)}</td><td class="num">${pc(ad.interestedToActiveDeal)}</td><td class="based">Interested</td></tr>
      </tbody>
    </table>`;

  els.percentageCard.innerHTML = `
    <div class="pct-head">
      <h2>Percentage Report</h2>
      <span class="muted">Re-checked ${n(rep.recheck.recheckedCount)} of ${n(t.totalTextsSent)} sent (${pc(rep.recheck.recheckCompletePct)})</span>
    </div>
    ${kpis}
    ${simpleTable}
    <button class="btn btn-small" id="pctDetailToggle">${_pctDetailOpen ? "▲ Hide full breakdown" : "▼ Show full breakdown"}</button>
    <div id="pctDetail" ${_pctDetailOpen ? "" : "hidden"}>${detail}</div>`;
  const tgl = $("pctDetailToggle");
  if (tgl) tgl.onclick = () => {
    _pctDetailOpen = !_pctDetailOpen;
    const d = $("pctDetail"); if (d) d.hidden = !_pctDetailOpen;
    tgl.textContent = _pctDetailOpen ? "▲ Hide full breakdown" : "▼ Show full breakdown";
  };
}

// --- Recheck Text Sent ------------------------------------------------------
function reflectRecheckButtons() {
  const b = $("recheckBtn"), s = $("recheckStopBtn");
  if (!b || !s) return;
  b.textContent = recheckRunning ? "🔎 Rechecking Text Sent…" : "🔎 Recheck Text Sent";
  b.disabled = recheckRunning;
  s.hidden = !recheckRunning;
}
async function startScan() {
  if (!hasJob) { toast("Pull from REI (or upload) leads first.", "error"); return; }
  const ok = window.confirm(
    "Build the Available-to-Text list?\n\nThis rechecks EVERY loaded lead against all texting rules and lists the ones that pass and haven't been texted in the last 30 days. It does NOT send any texts."
  );
  if (!ok) return;
  try {
    const r = await api("/api/scan-available", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    if (r.status) setStatus(r.status);
    toast("Building Available-to-Text list — rechecking every lead (no texts sent).", "ok");
  } catch (err) { toast(err.message, "error"); }
}
async function startRecheckNeedsReview() {
  if (!hasJob) { toast("Pull from REI (or upload) leads first.", "error"); return; }
  const sending = liveSendOn;
  const ok = window.confirm(
    "Recheck the Needs Review leads?\n\nThis re-opens ONLY the leads held for review and runs them through every rule again (re-reads REI, re-checks the state, etc.). Leads that now pass move out of Needs Review.\n\n" +
    (sending
      ? "⚠ Live Sending is ON — leads that now qualify WILL be texted."
      : "Live Sending is OFF — qualifying leads go to Available to Text; nothing is sent.")
  );
  if (!ok) return;
  try {
    const r = await api("/api/recheck-needs-review", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    if (r.message && r.ok === true && /No leads/i.test(r.message)) { toast(r.message, "ok"); return; }
    if (r.status) setStatus(r.status);
    toast("Rechecking Needs Review leads — watch the progress.", "ok");
  } catch (err) { toast(err.message, "error"); }
}
async function startRecheck() {
  const ok = window.confirm(
    "Recheck all Text Sent leads?\n\nThis will open each REI conversation, verify the sent message, and check for seller replies. It will NOT send any new messages."
  );
  if (!ok) return;
  try {
    await api("/api/recheck", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    recheckRunning = true;
    els.recheckPanel.hidden = false;
    reflectRecheckButtons();
    toast("Recheck started — watch the progress.", "ok");
  } catch (err) { toast(err.message, "error"); }
}
async function stopRecheck() {
  try { await api("/api/recheck/stop", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }); toast("Stopping recheck…"); }
  catch (err) { toast(err.message, "error"); }
}
function renderRecheck(d) {
  if (!d) return;
  recheckRunning = !!d.running;
  recheckHasState = true;
  reflectRecheckButtons();
  if (currentTab === "text-sent") els.recheckPanel.hidden = false;
  const line = (lbl, val, cls = "") => `<div class="rk-item ${cls}"><span class="rk-num">${val ?? 0}</span><span class="rk-lbl">${lbl}</span></div>`;
  els.recheckPanel.innerHTML = `
    <div class="rk-head">
      <b>Recheck Progress</b>
      <span>${d.checked ?? 0} of ${d.total ?? 0} checked — <b>${Number(d.percent || 0).toFixed(2)}%</b></span>
      ${d.currentSeller ? `<span class="rk-cur">Now: ${esc(d.currentSeller)} · ${esc(d.currentProperty || "")}</span>` : ""}
    </div>
    <div class="rk-grid">
      ${line("Total", d.total)}
      ${line("Checked", d.checked)}
      ${line("Remaining", d.remaining)}
      ${line("Replies", d.replies)}
      ${line("Interested", d.interested, "good")}
      ${line("Not Interested", d.notInterested)}
      ${line("Failed/Undeliv.", d.failed, "bad")}
      ${line("Needs Review", d.needsReview, "warn")}
      ${line("Could not check", d.errors, "warn")}
    </div>
    ${d.done ? '<div class="rk-done">✔ Recheck complete.</div>' : d.stopped ? '<div class="rk-done">⏹ Recheck stopped — click Recheck to resume.</div>' : ""}`;
}

// --- Status / progress ------------------------------------------------------
function setStatus(status) {
  els.statusLabel.textContent = cap(status);
  const running = status === "running", paused = status === "paused";
  els.startBtn.disabled = !hasJob || running || paused;
  els.pauseBtn.disabled = !running;
  els.resumeBtn.disabled = !(paused || status === "stopped");
  els.stopBtn.disabled = !(running || paused);
}
function cap(s) { return String(s || "idle").charAt(0).toUpperCase() + String(s || "idle").slice(1); }
function setProgress(cursor, total) {
  if (!total) { els.progressWrap.hidden = true; return; }
  els.progressWrap.hidden = false;
  els.progressFill.style.width = Math.min(100, Math.round((cursor / total) * 100)) + "%";
  els.progressText.textContent = `${cursor} / ${total} rows processed`;
}
function fmtDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60), r = s % 60;
  if (m < 60) return `${m}m ${r}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}
function renderEta(d) {
  if (!d || !d.total) return;
  els.progressWrap.hidden = false;
  els.progressFill.style.width = Math.min(100, Math.round((d.done / d.total) * 100)) + "%";
  const parts = [`${d.done} / ${d.total} processed`];
  if (d.avgMs) parts.push(`~${(d.avgMs / 1000).toFixed(1)}s per lead`);
  if (d.remaining > 0 && d.avgMs) parts.push(`${d.remaining} left · ETA ~${fmtDuration(d.etaMs)}`);
  els.progressText.textContent = parts.join("  ·  ");
}
function renderFinal(d) {
  if (!d) return;
  const s = d.summary || {};
  const li = (arr) => (arr && arr.length ? "<ul>" + arr.map((x) => `<li>${esc(x)}</li>`).join("") + "</ul>" : '<p class="muted">None.</p>');
  els.finalSummaryBody.innerHTML = `
    <div class="summary-block"><h4>Counts</h4>
      <div class="big">Total processed: <b>${s.total ?? 0}</b><br/>Text Sent: <b>${s.textSent ?? 0}</b><br/>
      Sold: ${s.propertySold ?? 0} · Listed: ${s.listed ?? 0} · Opted Out: ${s.optedOut ?? 0}<br/>
      Not Interested: ${s.notInterested ?? 0} · Needs Review: ${s.needsReview ?? 0} · Errors: ${s.errors ?? 0}</div></div>
    <div class="summary-block"><h4>Leads Texted (${(d.texted || []).length})</h4>${li(d.texted)}</div>
    <div class="summary-block"><h4>Send Failures / Review (${(d.failures || []).length})</h4>${li(d.failures)}</div>`;
  els.finalSummary.hidden = false;
}

// --- config + initial state ------------------------------------------------
async function init() {
  renderTabs();
  renderTabToolbar();
  try {
    const cfg = await api("/api/config");
    const m = cfg.approvedMessages || {};
    const entries = Object.entries(m);
    if (els.approvedTHB && entries[0]) els.approvedTHB.textContent = `${entries[0][0]}: “${entries[0][1]}”`;
    if (els.approvedETI && entries[1]) els.approvedETI.textContent = `${entries[1][0]}: “${entries[1][1]}”`;
    els.liveFlag.className = "live-flag " + (cfg.allowLiveSend ? "on" : "off");
    if (cfg.schedule && els.schedEnabled) {
      els.schedEnabled.checked = !!cfg.schedule.enabled;
      if (cfg.schedule.time) els.schedTime.value = cfg.schedule.time;
      renderSchedNote();
    }
    if (els.shareBar && Array.isArray(cfg.shareUrls) && cfg.shareUrls.length) {
      els.shareUrl.textContent = cfg.shareUrls[0];
      els.shareBar.hidden = false;
    }
    if (els.buildTag && cfg.build) {
      const b = cfg.build;
      const date = (b.commitDate || b.builtAt || "").slice(0, 10);
      els.buildTag.textContent = `v ${b.commit || "?"}${date ? " · " + date : ""}`;
      els.buildTag.title = `Running code: ${b.commit || "?"}${date ? " (" + date + ")" : ""} · source: ${b.source || "?"}`;
    }
    els.liveFlag.title = cfg.allowLiveSend ? "Live send ENABLED" : "Live send DISABLED (ALLOW_LIVE_SEND is off)";
    renderLiveSend(!!cfg.allowLiveSend);
  } catch (e) { /* ignore */ }

  await refreshState();
  connectSSE();
}

async function refreshState() {
  try {
    const st = await api("/api/state");
    if (st.job) {
      hasJob = true;
      setRows(st.job.rows);
      setStatus(st.engineStatus || st.job.status);
      setProgress(st.job.cursor, st.job.summary.total);
      els.fileName.textContent = st.job.sourceFileName || "(restored job)";
    } else {
      // No job (e.g. another client hit Reset) — clear this client's view too.
      hasJob = false;
      setRows([]);
      setProgress(0, 0);
      els.fileName.textContent = "No file selected";
      setStatus("idle");
    }
  } catch (e) { setStatus("idle"); }
}

function connectSSE() {
  const es = new EventSource("/api/events");
  es.addEventListener("state", (e) => {
    const d = JSON.parse(e.data);
    if (d.status) setStatus(d.status);
    if (typeof d.total === "number") setProgress(d.cursor, d.total);
    if (d.message) toast(d.message);
    if (d.message && /Pulled \d+ REI contacts/i.test(d.message)) refreshState();
    // Recheck ended (complete / stopped / paused / error) — re-enable its button
    // even if no terminal "recheck" event arrived (e.g. REI failed to open).
    if (d.message && /recheck (complete|stopped|paused|error)/i.test(d.message)) {
      recheckRunning = false;
      reflectRecheckButtons();
    }
  });
  es.addEventListener("summary", (e) => {
    let s = null;
    try { s = JSON.parse(e.data); } catch { /* ignore */ }
    // A summary whose total no longer matches our local rows means the job set
    // changed without per-row events (upload / pull / reset) — reload the rows
    // so OTHER clients on the shared LAN URL don't render stale data.
    if (s === null || (typeof s.total === "number" && s.total !== allRows.length)) {
      refreshState();
      return;
    }
    renderCards();
    renderTabs();
    if (currentTab === "percentage") schedulePctReload();
  });
  es.addEventListener("progress", (e) => renderEta(JSON.parse(e.data)));
  es.addEventListener("row", (e) => { const d = JSON.parse(e.data); if (d.row) updateRow(d.row); });
  es.addEventListener("recheck", (e) => renderRecheck(JSON.parse(e.data)));
  es.addEventListener("selftest", (e) => renderSelfTest(JSON.parse(e.data)));
  es.addEventListener("final", (e) => renderFinal(JSON.parse(e.data)));
  es.onerror = () => {};
}

// --- events ----------------------------------------------------------------
if (els.leadSearch) {
  els.leadSearch.oninput = () => {
    searchQuery = els.leadSearch.value.trim().toLowerCase();
    if (currentTab !== "percentage") renderTable();
  };
}

els.chooseBtn.onclick = () => els.fileInput.click();
els.fileInput.onchange = async () => {
  const file = els.fileInput.files[0];
  if (!file) return;
  els.fileName.textContent = file.name;
  els.uploadStatus.textContent = "Uploading…";
  els.uploadStatus.className = "upload-status";
  els.finalSummary.hidden = true;
  const fd = new FormData();
  fd.append("file", file);
  try {
    const res = await api("/api/upload", { method: "POST", body: fd });
    hasJob = true;
    setRows(res.snapshot.rows);
    setStatus("idle");
    setProgress(0, res.snapshot.summary.total);
    els.uploadStatus.textContent = `Loaded ${res.snapshot.summary.total} leads. Ready to start.`;
    els.uploadStatus.className = "upload-status ok";
  } catch (err) {
    els.uploadStatus.textContent = err.message;
    els.uploadStatus.className = "upload-status error";
    toast(err.message, "error");
  }
};

els.startBtn.onclick = () => control("/api/start", "Starting live automation…");
els.pauseBtn.onclick = () => control("/api/pause", "Pausing…");
els.resumeBtn.onclick = () => control("/api/resume", "Resuming…");
els.stopBtn.onclick = () => control("/api/stop", "Stopping…");
async function control(path, msg) {
  try { toast(msg); const r = await api(path, { method: "POST" }); if (r.status) setStatus(r.status); }
  catch (err) { toast(err.message, "error"); }
}

function to12h(hhmm) {
  if (!hhmm) return "";
  const [h, m] = hhmm.split(":").map(Number);
  const ap = h >= 12 ? "PM" : "AM";
  const h12 = ((h + 11) % 12) + 1;
  return `${h12}:${String(m).padStart(2, "0")} ${ap}`;
}
function renderSchedNote() {
  if (!els.schedNote) return;
  els.schedNote.textContent = els.schedEnabled.checked
    ? `On — runs daily at ${to12h(els.schedTime.value)} (app must be open)`
    : "Off — you start each run manually";
}
async function saveSchedule() {
  try {
    await api("/api/schedule", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: els.schedEnabled.checked, time: els.schedTime.value }) });
    renderSchedNote();
    toast(els.schedEnabled.checked ? `Scheduled daily at ${to12h(els.schedTime.value)}.` : "Schedule turned off.", "ok");
  } catch (err) { toast(err.message, "error"); }
}
if (els.schedEnabled) {
  els.schedEnabled.onchange = saveSchedule;
  els.schedTime.onchange = () => { if (els.schedEnabled.checked) saveSchedule(); else renderSchedNote(); };
}

// --- Shared "already texted" folder (cross-PC memory) -----------------------
async function loadSharedDir() {
  const inp = document.getElementById("sharedDir");
  const note = document.getElementById("sharedDirNote");
  if (!inp) return;
  try {
    const r = await api("/api/shared-memory");
    inp.value = r.sharedDir || "";
    if (note) note.textContent = r.sharedDir ? "✓ Sharing on — all PCs pointed here won't double-text." : "Off — this PC uses its own memory only.";
  } catch { /* ignore */ }
}
async function saveSharedDir() {
  const inp = document.getElementById("sharedDir");
  const note = document.getElementById("sharedDirNote");
  if (!inp) return;
  try {
    const r = await api("/api/shared-memory", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sharedDir: inp.value.trim() }) });
    if (note) note.textContent = r.sharedDir ? "✓ Saved — point your other PC at the SAME folder." : "Cleared — using this PC's own memory.";
    toast(r.sharedDir ? "Shared memory folder saved." : "Shared memory turned off.", "ok");
  } catch (err) { toast(err.message, "error"); if (note) note.textContent = "⚠ " + err.message; }
}
{
  const btn = document.getElementById("sharedDirSave");
  if (btn) btn.onclick = saveSharedDir;
  loadSharedDir();
}

// --- Live-send toggle -------------------------------------------------------
let liveSendOn = false;
function renderLiveSend(on) {
  liveSendOn = !!on;
  if (!els.liveSendBtn) return;
  els.liveSendBtn.textContent = liveSendOn ? "🟢 Live Sending: ON" : "💤 Live Sending: OFF";
  els.liveSendBtn.classList.toggle("live-on", liveSendOn);
}
if (els.liveSendBtn) {
  els.liveSendBtn.onclick = async () => {
    const turningOn = !liveSendOn;
    if (turningOn && !window.confirm(
      "Turn ON live sending?\n\nThis will send REAL text messages to every clean, eligible lead when you run the automation.\n\nClick OK to enable, or Cancel to stay in safe mode."
    )) return;
    try {
      const r = await api("/api/live-send", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: turningOn }) });
      renderLiveSend(!!r.allowLiveSend);
      if (els.liveFlag) els.liveFlag.className = "live-flag " + (r.allowLiveSend ? "on" : "off");
      toast(r.allowLiveSend ? "Live sending is now ON — real texts will be sent." : "Live sending is OFF — safe mode.", "ok");
    } catch (err) { toast(err.message, "error"); }
  };
}

// --- Connection self-test ---------------------------------------------------
function renderSelfTest(d) {
  if (!d || !els.selfTestPanel) return;
  els.selfTestPanel.hidden = false;
  const rows = (d.steps || []).map((s) =>
    `<div class="rk-item ${s.ok ? "good" : "bad"}"><span class="rk-num">${s.ok ? "✅" : "❌"}</span><span class="rk-lbl">${esc(s.name)}${s.detail ? " — " + esc(s.detail) : ""}</span></div>`
  ).join("");
  const banner = d.done
    ? (d.pass
        ? '<div class="rk-done">✅ Connection test PASSED — REI login and reading work. Safe to run.</div>'
        : '<div class="rk-done" style="color:#e0533d">❌ Some checks failed — fix these before texting (screenshot and send to support).</div>')
    : '<div class="rk-head"><b>Testing connection…</b> opening REI (log in if the window prompts).</div>';
  els.selfTestPanel.innerHTML = `<div class="rk-head"><b>🧪 Connection Test</b></div><div class="rk-grid">${rows}</div>${banner}`;
  if (els.selfTestBtn) els.selfTestBtn.disabled = !!d.running;
}
if (els.selfTestBtn) {
  els.selfTestBtn.onclick = async () => {
    if (!window.confirm("Test the REI connection?\n\nThis opens REI, logs in (if needed), opens one contact, and checks it can read the tags and chat. It does NOT send any text.")) return;
    try {
      els.selfTestBtn.disabled = true;
      await api("/api/self-test", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      if (els.selfTestPanel) { els.selfTestPanel.hidden = false; els.selfTestPanel.innerHTML = '<div class="rk-head"><b>🧪 Connection Test</b> — starting… log in if the REI window prompts.</div>'; }
      toast("Connection test started — watch the checklist.", "ok");
    } catch (err) { els.selfTestBtn.disabled = false; toast(err.message, "error"); }
  };
}

if (els.debugChatBtn) {
  els.debugChatBtn.onclick = async () => {
    if (!window.confirm("Show the raw REI chat text for one replied lead?\n\nThis opens REI briefly and reads one conversation so we can fix reply detection. It does NOT send anything. Stop the automation first if it's running.")) return;
    const panel = els.selfTestPanel;
    try {
      els.debugChatBtn.disabled = true;
      if (panel) { panel.hidden = false; panel.innerHTML = '<div class="rk-head"><b>🔬 Reading one chat from REI…</b> (log in if the REI window prompts)</div>'; }
      const d = await api("/api/debug-chat?replied=1");
      const esc2 = (s) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
      const parsed = (d.parsedMessages || []).map((m, i) => `${i + 1}. [${m.dir}] ${esc2(m.text).slice(0, 120)}`).join("<br/>") || "(none parsed)";
      if (panel) {
        panel.hidden = false;
        panel.innerHTML =
          `<div class="rk-head"><b>🔬 Debug: ${esc2(d.owner || "lead")}</b> — screenshot this and send it</div>` +
          `<div class="rk-grid" style="font-family:monospace;font-size:12px;white-space:pre-wrap;line-height:1.5;">` +
          `reply detected: ${d.replyDetected}\n` +
          `has "Sent to:" label: ${d.hasSentToLabel}\n` +
          `has "Received from:" label: ${d.hasReceivedFromLabel}\n\n` +
          `PARSED MESSAGES:\n${parsed}\n\n` +
          `RAW TEXT (first 4000 chars):\n${esc2(d.rawTextSample || d.error || "(empty)")}` +
          `</div>`;
      }
      toast("Chat read — screenshot the panel and send it to me.", "ok");
    } catch (err) {
      if (panel) { panel.hidden = false; panel.innerHTML = `<div class="rk-head"><b>🔬 Debug failed:</b> ${err.message}</div>`; }
      toast(err.message, "error");
    } finally { els.debugChatBtn.disabled = false; }
  };
}

if (els.reverifyBtn) {
  els.reverifyBtn.onclick = async () => {
    if (!window.confirm(
      "Re-verify all leads marked 'Text Sent'?\n\nOpens each in REI and checks whether the approved message is really in the chat. Ones that didn't actually send are reset. Nothing is sent. Stop the automation first."
    )) return;
    try {
      await api("/api/reverify", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      toast("Re-verify started — watch the table update.", "ok");
    } catch (err) { toast(err.message, "error"); }
  };
}

if (els.pullReiBtn) {
  els.pullReiBtn.onclick = async () => {
    if (!window.confirm(
      "Pull ALL contacts from REI and check them?\n\nOpens REI, lists every contact, then automatically checks each one against all texting rules and sorts them into tabs (Available to Text, Property Sold, etc.). NO texts are sent. This can take a while for thousands of leads — you can Stop anytime. Stop the automation first."
    )) return;
    try {
      await api("/api/pull-rei", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      toast("Pulling from REI, then checking every lead — log in if the window prompts.", "ok");
    } catch (err) { toast(err.message, "error"); }
  };
}

if (els.resetBtn) {
  els.resetBtn.onclick = async () => {
    if (!window.confirm(
      "Clear the dashboard?\n\nRemoves the current leads and counts so you can start fresh. Your 'texted this month' memory is KEPT. Stop the automation first."
    )) return;
    try {
      await api("/api/reset", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      hasJob = false;
      setRows([]);
      setStatus("idle");
      setProgress(0, 0);
      els.finalSummary.hidden = true;
      els.fileName.textContent = "No file selected";
      els.uploadStatus.textContent = "";
      toast("Dashboard cleared.", "ok");
    } catch (err) { toast(err.message, "error"); }
  };
}

if (els.copyShareBtn)
  els.copyShareBtn.onclick = () => {
    const url = els.shareUrl.textContent || "";
    if (navigator.clipboard && url) navigator.clipboard.writeText(url).then(() => toast("Share address copied.", "ok")).catch(() => {});
  };

if (els.reportBtn)
  els.reportBtn.onclick = () => {
    let overlay = $("reportOverlay");
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.id = "reportOverlay";
      overlay.style.cssText = "position:fixed;inset:0;z-index:9999;background:rgba(15,23,42,.55);flex-direction:column;padding:24px;box-sizing:border-box;";
      overlay.innerHTML =
        '<div style="display:flex;justify-content:space-between;align-items:center;gap:12px;max-width:1100px;margin:0 auto 12px;width:100%;">' +
        '<span style="color:#fff;font-weight:700;font-size:18px;">📊 Daily Report</span>' +
        '<span style="display:flex;gap:8px;">' +
        '<button id="saveToday" class="btn">💾 Save Today</button>' +
        '<button id="saveMonth" class="btn">💾 Save This Month</button>' +
        '<button id="reportClose" class="btn btn-stop">✕ Close</button></span></div>' +
        '<iframe id="reportFrame" style="flex:1;width:100%;max-width:1100px;margin:0 auto;border:0;border-radius:12px;background:#fff;box-shadow:0 20px 60px rgba(0,0,0,.4);"></iframe>';
      document.body.appendChild(overlay);
      const hide = () => { overlay.style.display = "none"; };
      $("reportClose").onclick = hide;
      overlay.addEventListener("click", (e) => { if (e.target === overlay) hide(); });
      document.addEventListener("keydown", (e) => { if (e.key === "Escape") hide(); });
      const savePdf = (scope) => {
        toast("Preparing PDF…");
        const a = document.createElement("a");
        a.href = "/api/report.pdf?scope=" + scope + "&t=" + new Date().getTime();
        a.download = ""; document.body.appendChild(a); a.click(); a.remove();
      };
      $("saveToday").onclick = () => savePdf("today");
      $("saveMonth").onclick = () => savePdf("month");
    }
    overlay.style.display = "flex";
    $("reportFrame").src = "/api/report?t=" + new Date().getTime();
  };

els.logsBtn.onclick = async () => {
  els.logsDrawer.hidden = false;
  try {
    const { logs } = await api("/api/logs?limit=300");
    els.logsBody.innerHTML = logs.length
      ? logs.slice().reverse().map((l) => `<div class="log-entry ${l.error ? "err" : ""}">
          <div class="ts">${esc(l.ts)} · row ${esc(l.row)} · ${esc(l.company || "")}</div>
          <div>search: ${esc(l.searchMethod || "-")}</div>
          <div>match: ${l.matchFound ? "yes" : "no"} · ${esc(l.matchStatus || "-")}</div>
          <div>compliance: ${esc(l.complianceResult || "-")}</div>
          <div>disposition: <b>${esc(l.disposition)}</b></div>
          ${l.notes ? `<div>notes: ${esc(l.notes)}</div>` : ""}
          ${l.error ? `<div>error: ${esc(l.error)}</div>` : ""}
        </div>`).join("")
      : `<p class="muted">No logs yet.</p>`;
  } catch (err) { els.logsBody.innerHTML = `<p class="muted">${esc(err.message)}</p>`; }
};
els.closeLogsBtn.onclick = () => (els.logsDrawer.hidden = true);

init();
