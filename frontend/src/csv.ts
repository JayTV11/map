import { sourceCountry } from "./countries";
import { severityLabel, TrafficEvent } from "./types";

/** CSV export of recent events, built entirely in the browser.
 *
 *  Cells are quoted per RFC 4180, and any cell that a spreadsheet could read as a
 *  formula (starting with = + - @, tab or CR) gets a leading apostrophe. Alert
 *  text such as a signature or hostname comes from the network, so an
 *  attacker can choose it; without this, opening the export in Excel could run
 *  their formula. */

export interface BufferedEvent {
  event: TrafficEvent;
  /** When this screen received it, ms since epoch. */
  at: number;
}

const COLUMNS: { header: string; get: (b: BufferedEvent) => string | number | null }[] = [
  { header: "received_at", get: (b) => new Date(b.at).toISOString() },
  { header: "alert_time", get: (b) => b.event.alert_time ?? b.event.timestamp },
  { header: "severity", get: (b) => severityLabel(b.event.severity) },
  { header: "signature", get: (b) => b.event.signature },
  { header: "signature_id", get: (b) => b.event.signature_id },
  { header: "category", get: (b) => b.event.category },
  { header: "src_ip", get: (b) => b.event.src_ip },
  { header: "src_port", get: (b) => b.event.src_port },
  { header: "src_country", get: (b) => sourceCountry(b.event) },
  { header: "src_system", get: (b) => b.event.src_asset?.name ?? null },
  { header: "dst_ip", get: (b) => b.event.dst_ip },
  { header: "dst_port", get: (b) => b.event.dst_port },
  { header: "dst_system", get: (b) => b.event.dst_asset?.name ?? null },
  { header: "direction", get: (b) => b.event.direction },
  { header: "protocol", get: (b) => b.event.protocol },
  { header: "action", get: (b) => b.event.action },
  { header: "feed", get: (b) => b.event.source },
];

export function csvCell(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return "";
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function eventsToCsv(items: readonly BufferedEvent[]): string {
  const rows = [COLUMNS.map((c) => c.header).join(",")];
  for (const b of items) rows.push(COLUMNS.map((c) => csvCell(c.get(b))).join(","));
  return rows.join("\r\n") + "\r\n";
}

/** Starts a download of `csv` in the browser. */
export function downloadCsv(filename: string, csv: string): void {
  // The BOM makes Excel read the file as UTF-8 (otherwise accented names turn to mojibake).
  const blob = new Blob(["﻿", csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
