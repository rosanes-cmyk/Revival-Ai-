// Dashboard frontend: upload, controls, live table/cards via SSE, logs, export.

const $ = (id) => document.getElementById(id);

const els = {
  chooseBtn: $("chooseBtn"), fileInput: $("fileInput"), fileName: $("fileName"), uploadStatus: $("uploadStatus"),
  startBtn: $("startBtn"), pauseBtn: $("pauseBtn"), resumeBtn: $("resumeBtn"), stopBtn: $("stopBtn"),
  exportXlsxBtn: $("exportXlsxBtn"), exportCsvBtn: $("exportCsvBtn"), logsBtn: $("logsBtn"),
  closeLogsBtn: $("closeLogsBtn"), logsDrawer: $("logsDrawer"), logsBody: $("logsBody"),
  tableBody: $("leadTableBody"), statusLabel: $("statusLabel"), liveFlag: $("liveFlag"),
  approvedTHB: $("approvedTHB"), approvedETI: $("approvedETI"), batchLimit: $("batchLimit"),
  liveSendBtn: $("liveSendBtn"), reverifyBtn: $("reverifyBtn"), pullReiBtn: $("pullReiBtn"),
  autoContinue: $("autoContinue"), reportBtn: $("reportBtn"),
  shareBar: $("shareBar"), shareUrl: $("shareUrl"), copyShareBtn: $("copyShareBtn"),
  buildTag: $("buildTag"),
  schedEnabled: $("schedEnabled"), schedTime: $("schedTime"), schedNote: $("schedNote"),
  progressWrap: $("progressWrap"), progressFill: $("progressFill"), progressText: $("progressText"),
  finalSummary: $("finalSummary"), finalSummaryBody: $("finalSummaryBody"), toast: $("toast"),
  filterNote: $("filterNote"),
};

let hasJob = false;
const COLSPAN = 16;

// Client-side copy of all rows + the active card filter, so cards can filter
// the table (click a card to show only those leads; click again to clear).
let allRows = [];
let filterKey = null;

const FILTERS = {
  all: null,
  textSent: (d) => d === "Text Sent",
  soldListed: (d) => d === "Property Sold" || d === "Listed",
  notIntOpt: (d) => d === "Not Interested" || d === "Opted Out",
  toDelete: (d) => ["Wrong Number", "Failed Number", "Lead NOT Found", "Bad Lead"].includes(d),
  outOfState: (d) => d === "Out of State",
};
const FILTER_LABEL = {
  textSent: "Text Sent", soldListed: "Property Sold / Listed",
  notIntOpt: "Not Interested / Opt Out", toDelete: "To Delete / Bad Leads",
  outOfState: "Out of State",
};

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

function esc(v) {
  return String(v ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
function badgeClass(disp) { return "badge " + String(disp).replace(/[^A-Za-z]/g, ""); }

function renderSummary(s) {
  if (!s) return;
  const view = {
    total: s.total ?? 0,
    textSent: s.textSent ?? 0,
    soldListed: (s.propertySold ?? 0) + (s.listed ?? 0),
    notIntOpt: (s.notInterested ?? 0) + (s.optedOut ?? 0),
    toDelete: (s.wrongNumber ?? 0) + (s.failedNumber ?? 0) + (s.leadNotFound ?? 0) + (s.badLead ?? 0),
    outOfState: s.outOfState ?? 0,
  };
  document.querySelectorAll(".stat").forEach((el) => {
    const k = el.dataset.k;
    if (k in view) el.querySelector(".stat-num").textContent = view[k];
  });
}

// REI Match Status cell: if we captured the live contact URL, show the status
// as a clickable link that opens the REI contact page in a new tab for a quick
// manual check. Otherwise plain text.
function reiMatchCell(r) {
  const status = esc(r.reiMatchStatus);
  const url = r.reiContactUrl;
  if (url && /^https?:\/\//i.test(url)) {
    return `<a class="rei-link" href="${esc(url)}" target="_blank" rel="noopener" title="Open this contact in REI BlackBook">${status || "View in REI"} 🔗</a>`;
  }
  return status;
}

// Property Status cell: if we captured a property-check URL (e.g. Redfin),
// show the status as a clickable link that opens the property page in a new
// tab so Sold/Listed can be validated. Otherwise plain text.
function propertyStatusCell(r) {
  const status = esc(r.propertyStatus);
  const url = r.propertyStatusUrl;
  if (url && /^https?:\/\//i.test(url)) {
    const label = /redfin\.com/i.test(url) ? "Redfin" : "property";
    return `<a class="rei-link" href="${esc(url)}" target="_blank" rel="noopener" title="Open this property to validate its status">${status || "View"} 🔗<span class="link-src"> (${label})</span></a>`;
  }
  return status;
}

// Property Address cell: links to the exact Redfin property page the automation
// checked (so one click shows Listed / Off Market / Sold + history). Only links
// when Redfin actually opened the property; otherwise plain text.
function addressCell(r) {
  const addr = esc(r.propertyAddress);
  if (!addr) return addr;
  const redfin = r.propertyStatusUrl;
  if (redfin && /redfin\.com/i.test(redfin)) {
    return `<a class="rei-link" href="${esc(redfin)}" target="_blank" rel="noopener" title="Open this address on Redfin (Listed / Off Market / Sold)">${addr} 🔗</a>`;
  }
  return addr;
}

function rowHtml(r) {
  return `
    <tr id="row-${r.rowNumber}">
      <td>${r.rowNumber}</td>
      <td>${esc(r.ownerName) || '<span class="dash">Unknown</span>'}</td>
      <td>${addressCell(r)}</td>
      <td>${esc(r.city)}</td>
      <td>${esc(r.state)}</td>
      <td>${esc(r.zip)}</td>
      <td>${esc(r.phone)}</td>
      <td>${reiMatchCell(r)}</td>
      <td>${esc(r.searchMethod)}</td>
      <td>${propertyStatusCell(r)}</td>
      <td>${esc(r.safetyStatus)}</td>
      <td>${esc(r.eligibilityStatus)}</td>
      <td><span class="${badgeClass(r.disposition)}">${esc(r.disposition)}</span></td>
      <td class="notes">${esc(r.notes)}</td>
      <td>${esc(r.textSentTimestamp)}</td>
      <td class="error">${esc(r.errorLog)}</td>
    </tr>`;
}

function renderRows(rows) {
  allRows = rows || [];
  renderTable();
}

function renderTable() {
  if (!allRows.length) {
    els.tableBody.innerHTML = `<tr class="empty-row"><td colspan="${COLSPAN}">Upload a spreadsheet to begin.</td></tr>`;
    updateFilterNote(0);
    return;
  }
  const pred = filterKey ? FILTERS[filterKey] : null;
  const list = pred ? allRows.filter((r) => pred(r.disposition)) : allRows;
  els.tableBody.innerHTML = list.length
    ? list.map(rowHtml).join("")
    : `<tr class="empty-row"><td colspan="${COLSPAN}">No leads in this category yet.</td></tr>`;
  updateFilterNote(list.length);
}

function updateFilterNote(shown) {
  document.querySelectorAll(".stat").forEach((el) =>
    el.classList.toggle("active", (el.dataset.filter || "") === (filterKey || "all") && filterKey)
  );
  if (filterKey && FILTER_LABEL[filterKey]) {
    els.filterNote.innerHTML = `Showing <b>${shown}</b> lead(s) in <b>${FILTER_LABEL[filterKey]}</b>. <a id="clearFilter">Show all</a>`;
    const c = $("clearFilter");
    if (c) c.onclick = () => setFilter(null);
  } else {
    els.filterNote.textContent = allRows.length ? "Tip: click a card above to show only those leads." : "";
  }
}

function setFilter(key) {
  filterKey = key && FILTERS[key] ? key : null;
  renderTable();
}

function updateRow(r) {
  const idx = allRows.findIndex((x) => x.rowNumber === r.rowNumber);
  if (idx >= 0) allRows[idx] = r;
  if (filterKey) {
    renderTable(); // a row may have entered/left the filtered category
  } else {
    const tr = $(`row-${r.rowNumber}`);
    if (tr) tr.outerHTML = rowHtml(r); // fast path: keep scroll position
  }
}

function setStatus(status) {
  els.statusLabel.textContent = cap(status);
  const running = status === "running", paused = status === "paused";
  els.startBtn.disabled = !hasJob || running || paused;
  els.pauseBtn.disabled = !running;
  els.resumeBtn.disabled = !(paused || status === "stopped");
  els.stopBtn.disabled = !(running || paused);
  els.exportXlsxBtn.disabled = !hasJob;
  els.exportCsvBtn.disabled = !hasJob;
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
  const avg = d.avgMs ? (d.avgMs / 1000).toFixed(1) : "—";
  const parts = [`${d.done} / ${d.total} processed`];
  if (d.avgMs) parts.push(`~${avg}s per lead`);
  if (d.remaining > 0 && d.avgMs) parts.push(`${d.remaining} left · ETA ~${fmtDuration(d.etaMs)}`);
  els.progressText.textContent = parts.join("  ·  ");
}

function renderFinal(d) {
  if (!d) return;
  const s = d.summary || {};
  const li = (arr) => (arr && arr.length ? "<ul>" + arr.map((x) => `<li>${esc(x)}</li>`).join("") + "</ul>" : '<p class="muted">None.</p>');
  els.finalSummaryBody.innerHTML = `
    <div class="summary-block">
      <h4>Counts</h4>
      <div class="big">
        Total processed: <b>${s.total ?? 0}</b><br/>
        Text Sent: <b>${s.textSent ?? 0}</b><br/>
        Lead NOT Found: ${s.leadNotFound ?? 0} · Sold: ${s.propertySold ?? 0} · Listed: ${s.listed ?? 0}<br/>
        Opted Out: ${s.optedOut ?? 0} · Not Interested: ${s.notInterested ?? 0} · Wrong #: ${s.wrongNumber ?? 0}<br/>
        Failed #: ${s.failedNumber ?? 0} · Already Contacted: ${s.alreadyContacted ?? 0}<br/>
        Needs Review: ${s.needsReview ?? 0} · Errors: ${s.errors ?? 0}
      </div>
    </div>
    <div class="summary-block"><h4>Leads Texted (${(d.texted || []).length})</h4>${li(d.texted)}</div>
    <div class="summary-block"><h4>Send Failures / Review (${(d.failures || []).length})</h4>${li(d.failures)}</div>`;
  els.finalSummary.hidden = false;
}

// --- config + initial state ------------------------------------------------
async function init() {
  try {
    const cfg = await api("/api/config");
    const m = cfg.approvedMessages || {};
    const entries = Object.entries(m);
    if (els.approvedTHB && entries[0]) els.approvedTHB.textContent = `${entries[0][0]}: “${entries[0][1]}”`;
    if (els.approvedETI && entries[1]) els.approvedETI.textContent = `${entries[1][0]}: “${entries[1][1]}”`;
    els.liveFlag.className = "live-flag " + (cfg.allowLiveSend ? "on" : "off");
    if (els.batchLimit && cfg.maxSendsPerRun !== undefined) {
      const v = String(cfg.maxSendsPerRun);
      if ([...els.batchLimit.options].some((o) => o.value === v)) els.batchLimit.value = v;
    }
    if (cfg.schedule && els.schedEnabled) {
      els.schedEnabled.checked = !!cfg.schedule.enabled;
      if (cfg.schedule.time) els.schedTime.value = cfg.schedule.time;
      renderSchedNote();
    }
    if (els.autoContinue && typeof cfg.autoContinue === "boolean") {
      els.autoContinue.checked = cfg.autoContinue;
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

  // Clickable summary cards -> filter the table (click active card to clear).
  document.querySelectorAll(".stat").forEach((el) => {
    el.onclick = () => {
      const f = el.dataset.filter;
      if (!f || f === "all") return setFilter(null);
      setFilter(filterKey === f ? null : f);
    };
  });
}

async function refreshState() {
  try {
    const st = await api("/api/state");
    if (st.job) {
      hasJob = true;
      renderSummary(st.job.summary);
      renderRows(st.job.rows);
      setStatus(st.engineStatus || st.job.status);
      setProgress(st.job.cursor, st.job.summary.total);
      els.fileName.textContent = st.job.sourceFileName || "(restored job)";
    } else setStatus("idle");
  } catch (e) { setStatus("idle"); }
}

function connectSSE() {
  const es = new EventSource("/api/events");
  es.addEventListener("state", (e) => {
    const d = JSON.parse(e.data);
    if (d.status) setStatus(d.status);
    if (typeof d.total === "number") setProgress(d.cursor, d.total);
    if (d.message) toast(d.message);
    // When a REI pull finishes, load the new job's rows into the table.
    if (d.message && /Pulled \d+ REI contacts/i.test(d.message)) refreshState();
  });
  es.addEventListener("summary", (e) => renderSummary(JSON.parse(e.data)));
  es.addEventListener("progress", (e) => renderEta(JSON.parse(e.data)));
  es.addEventListener("row", (e) => { const d = JSON.parse(e.data); if (d.row) updateRow(d.row); });
  es.addEventListener("final", (e) => renderFinal(JSON.parse(e.data)));
  es.onerror = () => {};
}

// --- events ----------------------------------------------------------------
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
    renderSummary(res.snapshot.summary);
    renderRows(res.snapshot.rows);
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
    await api("/api/schedule", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: els.schedEnabled.checked, time: els.schedTime.value }),
    });
    renderSchedNote();
    toast(els.schedEnabled.checked ? `Scheduled daily at ${to12h(els.schedTime.value)}.` : "Schedule turned off.", "ok");
  } catch (err) {
    toast(err.message, "error");
  }
}
if (els.schedEnabled) {
  els.schedEnabled.onchange = saveSchedule;
  els.schedTime.onchange = () => { if (els.schedEnabled.checked) saveSchedule(); else renderSchedNote(); };
}

if (els.batchLimit) {
  els.batchLimit.onchange = async () => {
    try {
      const r = await api("/api/batch-limit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: Number(els.batchLimit.value) }),
      });
      toast(r.maxSendsPerRun ? `Set to ${r.maxSendsPerRun} texts per run.` : "No per-run limit.", "ok");
    } catch (err) {
      toast(err.message, "error");
    }
  };
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
    if (turningOn) {
      const ok = window.confirm(
        "Turn ON live sending?\n\nThis will send REAL text messages to the phones of every clean, eligible lead when you run the automation.\n\nOnly turn this on when you're ready to actually text people. Click OK to enable, or Cancel to stay in safe mode."
      );
      if (!ok) return;
    }
    try {
      const r = await api("/api/live-send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: turningOn }),
      });
      renderLiveSend(!!r.allowLiveSend);
      if (els.liveFlag) els.liveFlag.className = "live-flag " + (r.allowLiveSend ? "on" : "off");
      toast(r.allowLiveSend ? "Live sending is now ON — real texts will be sent." : "Live sending is OFF — safe mode.", r.allowLiveSend ? "ok" : "ok");
    } catch (err) {
      toast(err.message, "error");
    }
  };
}

if (els.reverifyBtn) {
  els.reverifyBtn.onclick = async () => {
    const ok = window.confirm(
      "Re-verify all leads marked 'Text Sent'?\n\nThe automation will open each one in REI and check whether the approved message is really in the chat. Ones that didn't actually send (e.g. opted-out numbers) are reset so you can re-check them. Nothing is sent during re-verify.\n\nMake sure the automation is stopped first."
    );
    if (!ok) return;
    try {
      await api("/api/reverify", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      toast("Re-verify started — watch the table update.", "ok");
    } catch (err) {
      toast(err.message, "error");
    }
  };
}

if (els.pullReiBtn) {
  els.pullReiBtn.onclick = async () => {
    const ok = window.confirm(
      "Pull ALL contacts from REI?\n\nThis opens REI and lists every contact (can take a while for thousands). Each still goes through all safety checks, and nothing sends unless Live Sending is ON. Make sure the automation is stopped first."
    );
    if (!ok) return;
    try {
      await api("/api/pull-rei", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      toast("Pulling contacts from REI — log in if the window prompts. This can take a while.", "ok");
    } catch (err) {
      toast(err.message, "error");
    }
  };
}

if (els.autoContinue) {
  els.autoContinue.onchange = async () => {
    try {
      await api("/api/auto-continue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: els.autoContinue.checked }),
      });
      toast(
        els.autoContinue.checked
          ? "Auto-continue ON — it will keep sending batch after batch until you press Stop."
          : "Auto-continue off — it stops after one batch.",
        "ok"
      );
    } catch (err) {
      toast(err.message, "error");
    }
  };
}

if (els.copyShareBtn)
  els.copyShareBtn.onclick = () => {
    const url = els.shareUrl.textContent || "";
    if (navigator.clipboard && url) {
      navigator.clipboard.writeText(url).then(() => toast("Share address copied.", "ok")).catch(() => {});
    }
  };

if (els.reportBtn)
  els.reportBtn.onclick = () => {
    // Show the report INSIDE the app in an overlay. Opening a new tab/window is
    // unreliable in the desktop app (Electron can swallow it), so we load the
    // report straight into an in-app iframe by URL, which always works.
    let overlay = $("reportOverlay");
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.id = "reportOverlay";
      overlay.style.cssText =
        "position:fixed;inset:0;z-index:9999;background:rgba(15,23,42,.55);" +
        "flex-direction:column;padding:24px;box-sizing:border-box;";
      overlay.innerHTML =
        '<div style="display:flex;justify-content:space-between;align-items:center;' +
        'gap:12px;max-width:1100px;margin:0 auto 12px;width:100%;">' +
        '<span style="color:#fff;font-weight:700;font-size:18px;">📊 Daily Report</span>' +
        '<span style="display:flex;gap:8px;">' +
        '<button id="saveToday" class="btn">💾 Save Today</button>' +
        '<button id="saveMonth" class="btn">💾 Save This Month</button>' +
        '<button id="reportClose" class="btn btn-stop">✕ Close</button>' +
        "</span></div>" +
        '<iframe id="reportFrame" style="flex:1;width:100%;max-width:1100px;margin:0 auto;' +
        'border:0;border-radius:12px;background:#fff;box-shadow:0 20px 60px rgba(0,0,0,.4);"></iframe>';
      document.body.appendChild(overlay);
      // Show/hide by toggling display directly (NOT the hidden attribute — an
      // inline display value would override it and the panel could never close).
      const hide = () => { overlay.style.display = "none"; };
      $("reportClose").onclick = hide;
      overlay.addEventListener("click", (e) => { if (e.target === overlay) hide(); });
      document.addEventListener("keydown", (e) => { if (e.key === "Escape") hide(); });
      // Save just Today or just This Month: download a real PDF file directly
      // (rendered server-side by Chromium) — no printer dialog.
      const savePdf = (scope) => {
        toast("Preparing PDF…");
        const a = document.createElement("a");
        a.href = "/api/report.pdf?scope=" + scope + "&t=" + new Date().getTime();
        a.download = "";
        document.body.appendChild(a);
        a.click();
        a.remove();
      };
      $("saveToday").onclick = () => savePdf("today");
      $("saveMonth").onclick = () => savePdf("month");
    }
    overlay.style.display = "flex";
    // Load fresh each time (cache-buster) straight into the iframe.
    const frame = $("reportFrame");
    frame.src = "/api/report?t=" + new Date().getTime();
  };

els.exportXlsxBtn.onclick = () => (window.location = "/api/export?format=xlsx");
els.exportCsvBtn.onclick = () => (window.location = "/api/export?format=csv");

els.logsBtn.onclick = async () => {
  els.logsDrawer.hidden = false;
  try {
    const { logs } = await api("/api/logs?limit=300");
    els.logsBody.innerHTML = logs.length
      ? logs.slice().reverse().map((l) => `<div class="log-entry ${l.error ? "err" : ""}">
          <div class="ts">${esc(l.ts)} · row ${esc(l.row)} · ${esc(l.company || "")}</div>
          <div>search: ${esc(l.searchMethod || "-")}</div>
          <div>match: ${l.matchFound ? "yes" : "no"} · ${esc(l.matchStatus || "-")}</div>
          <div>compliance: ${esc(l.complianceResult || "-")} · safety: ${esc(l.safety || "-")}</div>
          <div>property: ${esc(l.propertyStatus || "-")}</div>
          <div>eligibility: ${esc(l.eligibility || "-")} · text sent: ${l.textSent ? "YES" : "no"}</div>
          <div>disposition: <b>${esc(l.disposition)}</b> · tag: ${esc(l.reiTag || "-")}</div>
          ${l.notes ? `<div>notes: ${esc(l.notes)}</div>` : ""}
          ${l.error ? `<div>error: ${esc(l.error)}</div>` : ""}
        </div>`).join("")
      : `<p class="muted">No logs yet.</p>`;
  } catch (err) { els.logsBody.innerHTML = `<p class="muted">${esc(err.message)}</p>`; }
};
els.closeLogsBtn.onclick = () => (els.logsDrawer.hidden = true);

init();
