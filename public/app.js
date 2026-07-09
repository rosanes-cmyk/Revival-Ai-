// Dashboard frontend: upload, controls, live table/cards via SSE, logs, export.

const $ = (id) => document.getElementById(id);

const els = {
  chooseBtn: $("chooseBtn"), fileInput: $("fileInput"), fileName: $("fileName"), uploadStatus: $("uploadStatus"),
  startBtn: $("startBtn"), pauseBtn: $("pauseBtn"), resumeBtn: $("resumeBtn"), stopBtn: $("stopBtn"),
  exportXlsxBtn: $("exportXlsxBtn"), exportCsvBtn: $("exportCsvBtn"), logsBtn: $("logsBtn"),
  closeLogsBtn: $("closeLogsBtn"), logsDrawer: $("logsDrawer"), logsBody: $("logsBody"),
  tableBody: $("leadTableBody"), statusLabel: $("statusLabel"), liveFlag: $("liveFlag"),
  approvedTHB: $("approvedTHB"), approvedETI: $("approvedETI"), batchLimit: $("batchLimit"),
  companySelect: $("companySelect"),
  schedEnabled: $("schedEnabled"), schedTime: $("schedTime"), schedNote: $("schedNote"),
  progressWrap: $("progressWrap"), progressFill: $("progressFill"), progressText: $("progressText"),
  finalSummary: $("finalSummary"), finalSummaryBody: $("finalSummaryBody"), toast: $("toast"),
  filterNote: $("filterNote"),
};

let hasJob = false;
const COLSPAN = 18;

// Client-side copy of all rows + the active card filter, so cards can filter
// the table (click a card to show only those leads; click again to clear).
let allRows = [];
let filterKey = null;

const FILTERS = {
  all: null,
  textSent: (d) => d === "Text Sent",
  soldListed: (d) => d === "Property Sold" || d === "Listed",
  notIntOpt: (d) => d === "Not Interested" || d === "Opted Out",
  toDelete: (d) => ["Wrong Number", "Failed Number", "Lead NOT Found"].includes(d),
};
const FILTER_LABEL = {
  textSent: "Text Sent", soldListed: "Property Sold / Listed",
  notIntOpt: "Not Interested / Opt Out", toDelete: "To Delete / Bad Leads",
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
    toDelete: (s.wrongNumber ?? 0) + (s.failedNumber ?? 0) + (s.leadNotFound ?? 0),
  };
  document.querySelectorAll(".stat").forEach((el) => {
    const k = el.dataset.k;
    if (k in view) el.querySelector(".stat-num").textContent = view[k];
  });
}

function rowHtml(r) {
  return `
    <tr id="row-${r.rowNumber}">
      <td>${r.rowNumber}</td>
      <td>${esc(r.ownerName) || '<span class="dash">Unknown</span>'}</td>
      <td>${esc(r.propertyAddress)}</td>
      <td>${esc(r.city)}</td>
      <td>${esc(r.state)}</td>
      <td>${esc(r.zip)}</td>
      <td>${esc(r.companySource)}</td>
      <td>${esc(r.phone)}</td>
      <td>${esc(r.reiMatchStatus)}</td>
      <td>${esc(r.searchMethod)}</td>
      <td>${esc(r.propertyStatus)}</td>
      <td>${esc(r.safetyStatus)}</td>
      <td>${esc(r.eligibilityStatus)}</td>
      <td><span class="${badgeClass(r.disposition)}">${esc(r.disposition)}</span></td>
      <td>${esc(r.reiTagApplied)}</td>
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
    <div class="summary-block"><h4>Tags Added (${(d.tagsAdded || []).length})</h4>${li(d.tagsAdded)}</div>
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
    if (els.companySelect && cfg.defaultCompany) {
      if ([...els.companySelect.options].some((o) => o.value === cfg.defaultCompany)) {
        els.companySelect.value = cfg.defaultCompany;
      }
    }
    if (els.batchLimit && cfg.maxSendsPerRun !== undefined) {
      const v = String(cfg.maxSendsPerRun);
      if ([...els.batchLimit.options].some((o) => o.value === v)) els.batchLimit.value = v;
    }
    if (cfg.schedule && els.schedEnabled) {
      els.schedEnabled.checked = !!cfg.schedule.enabled;
      if (cfg.schedule.time) els.schedTime.value = cfg.schedule.time;
      renderSchedNote();
    }
    els.liveFlag.title = cfg.allowLiveSend ? "Live send ENABLED" : "Live send DISABLED (ALLOW_LIVE_SEND is off)";
  } catch (e) { /* ignore */ }

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

function connectSSE() {
  const es = new EventSource("/api/events");
  es.addEventListener("state", (e) => {
    const d = JSON.parse(e.data);
    if (d.status) setStatus(d.status);
    if (typeof d.total === "number") setProgress(d.cursor, d.total);
    if (d.message) toast(d.message);
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

if (els.companySelect) {
  els.companySelect.onchange = async () => {
    try {
      const r = await api("/api/company", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ company: els.companySelect.value }),
      });
      toast(`Default company set to ${r.defaultCompany}.`, "ok");
    } catch (err) {
      toast(err.message, "error");
    }
  };
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
