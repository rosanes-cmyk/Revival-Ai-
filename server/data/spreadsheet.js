// Spreadsheet parsing (CSV / XLSX) and export.

import XLSX from "xlsx";
import { REQUIRED_COLUMNS, EXPORT_COLUMNS, DISPOSITION, ELIGIBILITY, MATCH_STATUS } from "../automation/constants.js";

/**
 * Parse an uploaded CSV or XLSX buffer into normalized lead rows.
 * Validates that all required columns are present.
 * @param {Buffer} buffer
 * @returns {{rows: Array<Object>, headers: string[]}}
 */
export function parseSpreadsheet(buffer) {
  const workbook = XLSX.read(buffer, { type: "buffer", cellDates: true });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new Error("The uploaded file has no sheets.");
  const raw = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: "", raw: false });
  if (raw.length === 0) throw new Error("The uploaded file has no data rows.");

  const headers = Object.keys(raw[0]);
  const normalized = headers.map((h) => h.trim().toLowerCase());
  const missing = REQUIRED_COLUMNS.filter((c) => !normalized.includes(c.toLowerCase()));
  if (missing.length > 0) {
    throw new Error(
      `Uploaded spreadsheet is missing required column(s): ${missing.join(", ")}. ` +
        `Required columns are: ${REQUIRED_COLUMNS.join(", ")}.`
    );
  }

  const headerMap = {};
  headers.forEach((h) => (headerMap[h.trim().toLowerCase()] = h));
  const get = (row, col) => String(row[headerMap[col.toLowerCase()]] ?? "").trim();

  const rows = raw.map((row, i) => ({
    rowNumber: i + 1,
    ownerName: get(row, "Owner Name"),
    propertyAddress: get(row, "Property Address"),
    city: get(row, "City"),
    state: get(row, "State"),
    zip: get(row, "ZIP Code"),
    companySource: get(row, "Company Source"),
    phone: get(row, "Phone"),
    email: get(row, "Email"),
    disposition: get(row, "Disposition") || DISPOSITION.PENDING,
    notes: get(row, "Notes"),
    reiMatchStatus: get(row, "REI Match Status") || MATCH_STATUS.UNSEARCHED,
    searchMethod: get(row, "Search Method Used"),
    propertyStatus: get(row, "Property Status"),
    safetyStatus: get(row, "Opt-Out / Safety"),
    eligibilityStatus: get(row, "Eligibility Status") || ELIGIBILITY.PENDING,
    reiTagApplied: get(row, "REI Tag Applied"),
    textSentTimestamp: get(row, "Text Sent Timestamp"),
    errorLog: get(row, "Error Log"),
  }));

  return { rows, headers };
}

/** Build an XLSX buffer of the enriched rows. */
export function exportToXlsx(rows) {
  const data = rows.map(rowToExportRecord);
  const ws = XLSX.utils.json_to_sheet(data, { header: EXPORT_COLUMNS });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Leads");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}

/** Build a CSV string of the enriched rows. */
export function exportToCsv(rows) {
  const data = rows.map(rowToExportRecord);
  const ws = XLSX.utils.json_to_sheet(data, { header: EXPORT_COLUMNS });
  return XLSX.utils.sheet_to_csv(ws);
}

function rowToExportRecord(r) {
  return {
    "Owner Name": r.ownerName,
    "Property Address": r.propertyAddress,
    City: r.city,
    State: r.state,
    "ZIP Code": r.zip,
    "Company Source": r.companySource,
    Phone: r.phone,
    Email: r.email,
    Disposition: r.disposition,
    Notes: r.notes,
    "REI Match Status": r.reiMatchStatus,
    "Search Method Used": r.searchMethod,
    "Property Status": r.propertyStatus,
    "Opt-Out / Safety": r.safetyStatus,
    "Eligibility Status": r.eligibilityStatus,
    "REI Tag Applied": r.reiTagApplied,
    "Text Sent Timestamp": r.textSentTimestamp,
    "Error Log": r.errorLog,
  };
}
