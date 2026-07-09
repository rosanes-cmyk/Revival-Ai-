// Dashboard frontend: upload, controls, live table/cards via SSE, logs, export.

const $ = (id) => document.getElementById(id);

const els = {
  chooseBtn: $("chooseBtn"), fileInput: $("fileInput"), fileName: $("fileName"), uploadStatus: $("uploadStatus"),
  startBtn: $("startBtn"), pauseBtn: $("pauseBtn"), resumeBtn: $("resumeBtn"), stopBtn: $("stopBtn"),
  exportXlsxBtn: $("exportXlsxBtn"), exportCsvBtn: $("exportCsvBtn"), logsBtn: $("logsBtn"),
  closeLogsBtn: $("closeLogsBtn"), logsDrawer: $("logsDrawer"), logsBody: $("logsBody"),
  tableBody: $("leadTableBody"), statusLabel: $("statusLabel"), liveFlag: $("liveFlag"),
  approvedTHB: $("approvedTHB"), approvedETI: $("approvedETI"),
  progressWrap: $("progressWrap"), progressFill: $("progressFill"), progressText: $("progressText"),
  finalSummary: $("finalSummary"), finalSummaryBody: $("finalSummaryBody"), toast: $("toast"),
};

let hasJob = false;
const COLSPAN = 18;

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
  document.querySelectorAll(".stat").forEach((el) => {
    const k = el.dataset.k;
    if (k in s) el.querySelector(".stat-num").textContent = s[k] ?? 0;
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
  if (!rows || rows.length === 0) {
    els.tableBody.innerHTML = `<tr class="empty-row"><td colspan="${COLSPAN}">Upload a spreadsheet to begin.</td></tr>`;
    return;
  }
  els.tableBody.innerHTML = rows.map(rowHtml).join("");
}
function updateRow(r) {
  const tr = $(`row-${r.rowNumber}`);
  if (tr) tr.outerHTML = rowHtml(r);
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
    if (entries.length) {
      els.approvedTHB.textContent = entries[0] ? `${entries[0][0]}: “${entries[0][1]}”` : "";
      els.approvedETI.textContent = entries[1] ? `${entries[1][0]}: “${entries[1][1]}”` : "";
    }
    els.liveFlag.className = "live-flag " + (cfg.allowLiveSend ? "on" : "off");
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
