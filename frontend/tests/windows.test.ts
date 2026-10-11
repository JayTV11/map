import assert from "node:assert/strict";
import test from "node:test";
import { partialNote, TalkerStats } from "../src/talkers";
import { TrendStats } from "../src/trend";
import { TrafficEvent } from "../src/types";

const ev = (ip: string, sig = "S"): TrafficEvent => ({ id: "x", timestamp: "", src_lat: 0, src_lon: 0, dst_lat: 0, dst_lon: 0, severity: "high", count: 1,
  src_ip: ip, dst_ip: "10.0.0.1", signature: sig, signature_id: null, category: null, protocol: null, src_port: null, dst_port: null, action: null, alert_time: null,
  kibana_url: null, src_asset: null, dst_asset: null, direction: null, extra: {}, geo_note: null, source: "csv", is_replay: false });

const T0 = 1_000_000_000_000;

test("top talkers: a longer window sees older events, a shorter one does not", () => {
  const s = new TalkerStats(300, 3600, T0);
  s.record(ev("1.1.1.1"), T0);                      // 20 minutes before "now"
  s.record(ev("2.2.2.2"), T0 + 19.5 * 60_000);      // 30 seconds before "now"
  const now = T0 + 20 * 60_000;
  assert.deepEqual(s.top("src", 5, now, 60).map((t) => t.name), ["2.2.2.2"]);
  assert.deepEqual(s.top("src", 5, now, 300).map((t) => t.name), ["2.2.2.2"]);
  assert.deepEqual(s.top("src", 5, now, 3600).map((t) => t.name).sort(), ["1.1.1.1", "2.2.2.2"]);
});

test("the default window (what the wall headline reads) does not change when longer ones are kept", () => {
  const s = new TalkerStats(300, 3600, T0);
  s.record(ev("1.1.1.1"), T0);
  const now = T0 + 20 * 60_000;
  assert.equal(s.severityTotals(now).total, 0, "5 minute default ignores the 20-minute-old event");
  assert.equal(s.severityTotals(now, 3600).total, 1);
  assert.equal(s.keyAssetHits(now), 0);
});

test("nothing is kept past the maximum, and old behaviour is unchanged when no maximum is given", () => {
  const s = new TalkerStats(300, 3600, T0);
  s.record(ev("1.1.1.1"), T0);
  assert.equal(s.top("src", 5, T0 + 2 * 3600_000, 7200).length, 0, "an event older than the hour is gone");
  const legacy = new TalkerStats(300);
  legacy.record(ev("1.1.1.1"), T0);
  assert.equal(legacy.top("src", 5, T0 + 600_000, 3600).length, 0, "no longer window than it was built to keep");
});

test("trend: spans choose how many minutes come back, and are capped at what is kept", () => {
  const t = new TrendStats(60, 360, T0);
  t.record(ev("1.1.1.1"), T0 - 100 * 60_000);
  assert.equal(t.series(T0, 15).length, 15);
  assert.equal(t.series(T0, 60).reduce((n, p) => n + p.total, 0), 0, "100 minutes ago is outside 1 hour");
  assert.equal(t.series(T0, 180).reduce((n, p) => n + p.total, 0), 1);
  assert.equal(t.series(T0, 9999).length, 360);
  assert.equal(new TrendStats(10).series(T0).length, 10, "default constructor behaves as before");
});

test("the 'still filling' note appears only while the page is younger than the window", () => {
  assert.equal(partialNote(T0, T0 + 10 * 60_000, 3600_000), "Counting for 10 min so far");
  assert.equal(partialNote(T0, T0 + 120 * 60_000, 3600_000), "");
  assert.equal(partialNote(T0, T0 + 5_000, 3600_000), "Counting for 1 min so far");
  assert.equal(partialNote(T0, T0 + 100 * 60_000, 6 * 3600_000), "Counting for 2 h so far");
});
