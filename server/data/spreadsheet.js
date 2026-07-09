// Spreadsheet parsing (CSV / XLSX) and export (SOP steps 1 and 9).

import XLSX from "xlsx";
import { REQUIRED_COLUMNS, EXPORT_COLUMNS, DISPOSITION, ELIGIBILITY, MATCH_STATUS } from "../automation/constants.js";

/**
 * Parse an uploaded CSV or XLSX buffer into normalized lead rows.
 * Validates that all required columns are present.
 *
 * @param {Buffer} buffer
 * @param {string} originalName  Used only to detect extension for messaging.
 * @returns {{rows: Array<Object>, headers: string[]}}
 */
export function parseSpreadsheet(buffer) {
  const workbook = XLSX.read(buffer, { type: "buffer", cellDates: true });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new Error("The uploaded file has no sheets.");
  const sheet = workbook.Sheets[sheetName];
  const raw = XLSX.utils.sheet_to_json(sheet, { defval: "", raw: false });

  if (raw.length === 0) {
    throw new Error("The uploaded file has no data rows.");
  }

  const headers = Object.keys(raw[0]);
  const normalizedHeaders = headers.map((h) => h.trim().toLowerCase());
  const missing = REQUIRED_COLUMNS.filter(
    (col) => !normalizedHeaders.includes(col.toLowerCase())
  );
  if (missing.length > 0) {
    throw new Error(
      `Uploaded spreadsheet is missing required column(s): ${missing.join(", ")}. ` +
        `Required columns are: ${REQUIRED_COLUMNS.join(", ")}.`
    );
  }

  // Build a case-insensitive header lookup so we tolerate minor casing/spacing.
  const headerMap = {};
  headers.forEach((h) => {
    headerMap[h.trim().toLowerCase()] = h;
  });
  const get = (row, col) => String(row[headerMap[col.toLowerCase()]] ?? "").trim();

  const rows = raw.map((row, i) => ({
    rowNumber: i + 1,
    ownerName: get(row, "Owner Name"),
    propertyAddress: get(row, "Property Address"),
    city: get(row, "City"),
    state: get(row, "State"),
    zip: get(row, "ZIP Code"),
    // Existing disposition/notes are preserved so resume can skip processed rows.
    disposition: get(row, "Disposition") || DISPOSITION.PENDING,
    notes: get(row, "Notes"),
    // Enrichment fields (may already exist from a prior export being re-uploaded).
    reiMatchStatus: get(row, "REI Match Status") || MATCH_STATUS.UNSEARCHED,
    lastContactDate: get(row, "Last Contact Date"),
    optOutStatus: get(row, "Opt-Out Status"),
    propertyStatus: get(row, "Property Status"),
    eligibilityStatus: get(row, "Eligibility Status") || ELIGIBILITY.PENDING,
    textSentTimestamp: get(row, "Text Sent Timestamp"),
    errorLog: get(row, "Error Log"),
  }));

  return { rows, headers };
}

/**
 * Build an XLSX buffer of the enriched rows (SOP step 9).
 * @param {Array<Object>} rows  Internal row objects from the job store.
 * @returns {Buffer}
 */
export function exportToXlsx(rows) {
  const data = rows.map((r) => rowToExportRecord(r));
  const worksheet = XLSX.utils.json_to_sheet(data, { header: EXPORT_COLUMNS });
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "Leads");
  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
}

/**
 * Build a CSV string of the enriched rows.
 * @param {Array<Object>} rows
 * @returns {string}
 */
export function exportToCsv(rows) {
  const data = rows.map((r) => rowToExportRecord(r));
  const worksheet = XLSX.utils.json_to_sheet(data, { header: EXPORT_COLUMNS });
  return XLSX.utils.sheet_to_csv(worksheet);
}

function rowToExportRecord(r) {
  return {
    "Owner Name": r.ownerName,
    "Property Address": r.propertyAddress,
    City: r.city,
    State: r.state,
    "ZIP Code": r.zip,
    Disposition: r.disposition,
    Notes: r.notes,
    "REI Match Status": r.reiMatchStatus,
    "Last Contact Date": r.lastContactDate,
    "Opt-Out Status": r.optOutStatus,
    "Property Status": r.propertyStatus,
    "Eligibility Status": r.eligibilityStatus,
    "Text Sent Timestamp": r.textSentTimestamp,
    "Error Log": r.errorLog,
  };
}
