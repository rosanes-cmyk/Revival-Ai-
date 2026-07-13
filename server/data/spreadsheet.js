// Spreadsheet parsing (CSV / XLSX) and export.
//
// The importer is intentionally forgiving: it maps common column-name variants
// to the fields the automation needs (e.g. "Remarks" -> Disposition, "Address"
// -> Property Address, "Zip" -> ZIP Code), keeps every original column, and on
// export writes the results back into your own columns so the file tallies with
// what you uploaded.

import XLSX from "xlsx";
import { EXPORT_COLUMNS, DISPOSITION } from "../automation/constants.js";

// Accepted header names per internal field (compared case/space-insensitively).
const ALIASES = {
  ownerName: ["owner name", "owner", "name", "owner/seller", "seller name", "seller", "contact name"],
  propertyAddress: ["property address", "address", "property", "site address", "property street address", "full address"],
  street: ["street", "street address", "site street", "property street"],
  city: ["city", "property city"],
  state: ["state", "st", "property state", "state/province", "province"],
  zip: ["zip code", "zip", "zipcode", "postal code", "property zip", "zip/postal", "postal"],
  companySource: ["company source", "company", "source company", "brand", "account", "company name"],
  phone: ["phone", "phone number", "mobile", "cell", "phone (mobile)", "primary phone", "cell phone"],
  email: ["email", "email address", "e-mail"],
  disposition: ["disposition", "remarks", "status", "result", "outcome", "lead status", "remark"],
  notes: ["notes", "note", "comments", "comment"],
};

// Automation columns appended to the export (in addition to your originals).
const AUTOMATION_COLUMNS = [
  "REI Match Status",
  "REI Contact Link",
  "Search Method Used",
  "Property Status",
  "Property Check Link",
  "Opt-Out / Safety",
  "Eligibility Status",
  "Text Sent Timestamp",
  "Error Log",
];

const norm = (s) => String(s || "").trim().toLowerCase();

/**
 * Parse an uploaded CSV or XLSX buffer.
 * @returns {{rows:Array, originalHeaders:string[], dispositionHeader:string, notesHeader:string}}
 */
export function parseSpreadsheet(buffer) {
  const workbook = XLSX.read(buffer, { type: "buffer", cellDates: true });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new Error("The uploaded file has no sheets.");
  const raw = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: "", raw: false });
  if (raw.length === 0) throw new Error("The uploaded file has no data rows.");

  const originalHeaders = Object.keys(raw[0]);
  const headerByNorm = {};
  originalHeaders.forEach((h) => (headerByNorm[norm(h)] = h));

  // Resolve each internal field to the original header that matches an alias.
  const resolved = {};
  for (const [field, names] of Object.entries(ALIASES)) {
    const hit = names.map(norm).find((n) => n in headerByNorm);
    resolved[field] = hit ? headerByNorm[hit] : null;
  }

  // We just need something to identify a lead: an address or an owner name.
  if (!resolved.propertyAddress && !resolved.ownerName) {
    throw new Error(
      "Could not find a Property Address or Owner Name column. Your sheet needs at least one of those " +
        "(any of: Property Address / Address / Street Address, or Owner Name / Owner / Name)."
    );
  }

  const dispositionHeader = resolved.disposition || "Disposition";
  const notesHeader = resolved.notes || "Notes";

  const val = (row, field) => (resolved[field] ? String(row[resolved[field]] ?? "").trim() : "");

  const rows = raw.map((row, i) => ({
    rowNumber: i + 1,
    original: { ...row }, // keep every column exactly as uploaded
    ownerName: val(row, "ownerName"),
    propertyAddress: val(row, "propertyAddress"),
    street: val(row, "street"),
    city: val(row, "city"),
    state: val(row, "state"),
    zip: val(row, "zip"),
    companySource: val(row, "companySource"),
    phone: val(row, "phone"),
    email: val(row, "email"),
    disposition: normalizeDisposition(val(row, "disposition")),
    notes: val(row, "notes"),
    reiMatchStatus: "",
    reiContactUrl: "",
    searchMethod: "",
    propertyStatus: "",
    propertyStatusUrl: "",
    safetyStatus: "",
    eligibilityStatus: "",
    reiTagApplied: "",
    textSentTimestamp: "",
    errorLog: "",
  }));

  return { rows, originalHeaders, dispositionHeader, notesHeader };
}

// Map any casing/wording of an existing remark to our canonical disposition so
// summary counts and resume-skip work regardless of how the sheet spells them.
export function normalizeDisposition(rawValue) {
  const v = norm(rawValue).replace(/\s+/g, " "); // collapse "Text  Sent" -> "text sent"
  if (!v) return DISPOSITION.PENDING;
  if (v.includes("text sent") || v === "sent" || v === "texted") return DISPOSITION.TEXT_SENT;
  if (v.includes("not found") || v.includes("no match")) return DISPOSITION.LEAD_NOT_FOUND;
  if (v.includes("sold")) return DISPOSITION.PROPERTY_SOLD;
  if (v.includes("listed") || v.includes("listing")) return DISPOSITION.LISTED;
  if (v.includes("not interested") || v.includes("no longer interested")) return DISPOSITION.NOT_INTERESTED;
  if (v.includes("opt")) return DISPOSITION.OPTED_OUT; // opted out / opt out / opt-out
  if (v.includes("wrong number")) return DISPOSITION.WRONG_NUMBER;
  if (v.includes("failed") || v.includes("undelivered")) return DISPOSITION.FAILED_NUMBER;
  if (v.includes("already")) return DISPOSITION.ALREADY_CONTACTED;
  if (v.includes("ready")) return DISPOSITION.READY_TO_TEXT;
  if (v.includes("review")) return DISPOSITION.NEEDS_REVIEW;
  if (v.includes("error")) return DISPOSITION.ERROR;
  if (v.includes("pending") || v.includes("new")) return DISPOSITION.PENDING;
  return DISPOSITION.PENDING; // unknown remark -> treat as not-yet-processed
}

/** Build the export column order: your original columns + the automation ones. */
function exportColumns(job) {
  const originals = job.originalHeaders && job.originalHeaders.length ? [...job.originalHeaders] : [...EXPORT_COLUMNS];
  const dispH = job.dispositionHeader || "Disposition";
  const notesH = job.notesHeader || "Notes";
  const cols = [...originals];
  const ensure = (h) => { if (!cols.includes(h)) cols.push(h); };
  ensure(dispH);
  ensure(notesH);
  AUTOMATION_COLUMNS.forEach(ensure);
  return { cols, dispH, notesH };
}

/** Turn one internal row into an export record keyed by the final columns. */
function toRecord(job, r) {
  const { dispH, notesH } = exportColumns(job);
  const rec = { ...(r.original || {}) }; // preserve uploaded columns/values
  rec[dispH] = r.disposition;
  rec[notesH] = r.notes;
  rec["REI Match Status"] = r.reiMatchStatus;
  rec["REI Contact Link"] = r.reiContactUrl || "";
  rec["Search Method Used"] = r.searchMethod;
  rec["Property Status"] = r.propertyStatus;
  rec["Property Check Link"] = r.propertyStatusUrl || "";
  rec["Opt-Out / Safety"] = r.safetyStatus;
  rec["Eligibility Status"] = r.eligibilityStatus;
  rec["Text Sent Timestamp"] = r.textSentTimestamp;
  rec["Error Log"] = r.errorLog;
  return rec;
}

// End-of-day report: total leads worked and a breakdown by outcome.
function summaryRecords(job) {
  const counts = {};
  for (const r of job.rows) {
    const d = r.disposition || DISPOSITION.PENDING;
    counts[d] = (counts[d] || 0) + 1;
  }
  const order = [
    DISPOSITION.TEXT_SENT,
    DISPOSITION.PROPERTY_SOLD,
    DISPOSITION.LISTED,
    DISPOSITION.OPTED_OUT,
    DISPOSITION.NOT_INTERESTED,
    DISPOSITION.WRONG_NUMBER,
    DISPOSITION.FAILED_NUMBER,
    DISPOSITION.ALREADY_CONTACTED,
    DISPOSITION.BAD_LEAD,
    DISPOSITION.LEAD_NOT_FOUND,
    DISPOSITION.NEEDS_REVIEW,
    DISPOSITION.READY_TO_TEXT,
    DISPOSITION.ERROR,
    DISPOSITION.PENDING,
  ];
  const worked = job.rows.filter((r) => r.disposition && r.disposition !== DISPOSITION.PENDING).length;
  const recs = [];
  recs.push({ Metric: "Report generated", Count: new Date().toLocaleString() });
  recs.push({ Metric: "Total leads", Count: job.rows.length });
  recs.push({ Metric: "Leads worked (processed)", Count: worked });
  recs.push({ Metric: "", Count: "" });
  for (const d of order) if (counts[d]) recs.push({ Metric: d, Count: counts[d] });
  for (const [d, c] of Object.entries(counts)) if (!order.includes(d)) recs.push({ Metric: d, Count: c });
  return recs;
}

export function exportToXlsx(job) {
  const { cols } = exportColumns(job);
  const data = job.rows.map((r) => toRecord(job, r));
  const ws = XLSX.utils.json_to_sheet(data, { header: cols });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Leads");
  // Second sheet: the end-of-day totals report.
  const wsSummary = XLSX.utils.json_to_sheet(summaryRecords(job), { header: ["Metric", "Count"] });
  XLSX.utils.book_append_sheet(wb, wsSummary, "Summary");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}

export function exportToCsv(job) {
  const { cols } = exportColumns(job);
  const data = job.rows.map((r) => toRecord(job, r));
  const ws = XLSX.utils.json_to_sheet(data, { header: cols });
  const leadsCsv = XLSX.utils.sheet_to_csv(ws);
  // Append the totals report at the bottom (CSV has no separate tabs).
  const sumWs = XLSX.utils.json_to_sheet(summaryRecords(job), { header: ["Metric", "Count"] });
  const sumCsv = XLSX.utils.sheet_to_csv(sumWs);
  return `${leadsCsv}\n\n===== SUMMARY REPORT =====\n${sumCsv}`;
}
