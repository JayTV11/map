import assert from "node:assert/strict";
import test from "node:test";
import { dataNote, notesInWindow, summaryText, SummaryData } from "../src/summary";

const base = (o: Partial<SummaryData> = {}): SummaryData => ({
  source: "live", from: "2026-01-01T08:00:00Z", to: "2026-01-01T16:00:00Z", hours: 8, data_since: "2026-01-01T10:00:00Z", complete: false,
  events: 120, muted: 5, unusual: 3, key_asset_hits: 2,
  by_severity: [{ id: "critical", n: 4 }, { id: "high", n: 116 }], timeline: [],
  top: { signatures: [{ name: "ET SCAN", n: 90 }], sources: [{ name: "1.1.1.1", n: 50 }], targets: [], countries: [] },
  notable: [{ key: "k", severity: "critical", signature: "ET EXPLOIT", src_ip: "1.1.1.1", dst_ip: "10.0.0.1", target: "Web 1", country: "US", count: 2, score: 88, reasons: [], first: "2026-01-01T12:00:00Z", last: "2026-01-01T12:05:00Z" }],
  notable_total: 1, ...o,
});

test("the data-since note is honest about a partial period", () => {
  assert.match(dataNote(base()), /only started counting/);
  assert.doesNotMatch(dataNote(base({ complete: true })), /only started/);
  assert.match(dataNote(base({ source: "simulated" })), /not real traffic/);
  assert.match(dataNote(base({ data_since: null })), /Nothing has been recorded/);
});

test("text summary carries the numbers, the honest note, and the analyst's notes", () => {
  const t = summaryText(base(), (id) => id.toUpperCase(), [{ text: "called the owner", signature: "ET EXPLOIT", src: "1.1.1.1", dst: "10.0.0.1", at: 1 }]);
  assert.match(t, /last 8 hours/);
  assert.match(t, /Events: 120 \(\+ 5 muted/);
  assert.match(t, /CRITICAL 4, HIGH 116/);
  assert.match(t, /\[CRITICAL\] ET EXPLOIT: 1\.1\.1\.1 -> Web 1 x2/);
  assert.match(t, /unusual \(88\)/);
  assert.match(t, /only started counting/);
  assert.match(t, /My notes:\n {2}- ET EXPLOIT 1\.1\.1\.1 -> 10\.0\.0\.1: called the owner/);
});

test("notes in the window: newest first, empty and old ones dropped, signatures with | survive", () => {
  const n = notesInWindow([
    ["1.1.1.1|10.0.0.1|A | B", { note: "x", at: 200 }],
    ["2.2.2.2|10.0.0.2|C", { note: "y", at: 300 }],
    ["3.3.3.3|10.0.0.3|D", { note: "", at: 400 }],
    ["4.4.4.4|10.0.0.4|E", { note: "old", at: 50 }],
  ], 100);
  assert.deepEqual(n.map((x) => x.text), ["y", "x"]);
  assert.equal(n[1].signature, "A | B");
});
