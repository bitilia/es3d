// CSV output for the LAN benchmark: RFC 4180 quoting, a UTF-8 byte order mark
// so spreadsheet programs read non-ASCII device names correctly, and a guard
// against spreadsheet formula injection (device strings come from the network).

import fs from 'node:fs';

/** One CSV field. Numbers keep at most three decimals; missing values are empty. */
export function csvCell(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(Math.round(value * 1000) / 1000) : '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  let s = String(value);
  // a text cell starting with = + - @ (or a tab / carriage return) would be
  // evaluated as a formula by Excel, Sheets and LibreOffice
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const csvLine = (values) => values.map(csvCell).join(',') + '\r\n';

/** A CSV file with a fixed column list that rows are appended to as they arrive. */
export class CsvFile {
  /**
   * @param {string} file
   * @param {string[]} columns
   */
  constructor(file, columns) {
    this.file = file;
    this.columns = columns;
    this.rows = 0;
    fs.writeFileSync(file, '﻿' + csvLine(columns));
  }

  /** @param {Record<string, unknown>} row values by column name; other keys are ignored */
  append(row) {
    fs.appendFileSync(this.file, csvLine(this.columns.map((c) => row[c])));
    this.rows++;
  }

  /** Rewrite the whole file (used for tables whose rows change, such as devices). */
  rewrite(rows) {
    fs.writeFileSync(this.file, '﻿' + csvLine(this.columns) + rows.map((r) => csvLine(this.columns.map((c) => r[c]))).join(''));
    this.rows = rows.length;
  }
}
