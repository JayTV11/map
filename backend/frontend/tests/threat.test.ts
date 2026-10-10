import assert from "node:assert/strict";
import { test } from "node:test";
import { severityScore, ThreatMonitor } from "../src/threat";
import { TrafficEvent } from "../src/types";

const ev = (severity: string): TrafficEvent => ({ severity } as TrafficEvent);
const MIN = 60_000;
const T0 = 1_000_000 * MIN; // an arbitrary start, aligned to a minute

/** Adds `perMin` events of `sev` in each minute from start (inclusive) for `minutes` minutes. */
function feed(t: ThreatMonitor, startMin: number, minutes: number, perMin: number, sev = "major"): void {
  for (let m = 0; m < minutes; m++) for (let i = 0; i < perMin; i++) t.record(ev(sev), T0 + (startMin + m) * MIN + 1000 + i);
}

test("scores by severity position: 10 / 4 / 2 / 1", () => {
  assert.deepEqual(["critical", "major", "high", "unknown", "nonsense"].map(severityScore), [10, 4, 2, 1, 1]);
});

test("learns before it judges", () => {
  const t = new ThreatMonitor();
  feed(t, 0, 5, 10);
  const a = t.assess(T0 + 4 * MIN + 30_000);
  assert.equal(a.level, "learning");
  assert.match(a.reason, /Learning/);
  assert.equal(a.baseline, null);
});

test("steady traffic is normal once learned", () => {
  const t = new ThreatMonitor();
  feed(t, 0, 40, 10); // 40/min score
  const a = t.assess(T0 + 39 * MIN + 30_000);
  assert.equal(a.level, "normal");
  assert.ok(a.baseline !== null && Math.abs(a.baseline - 40) < 1, String(a.baseline));
});

test("a surge steps up at once: 2x elevated, 4x high", () => {
  const t = new ThreatMonitor();
  feed(t, 0, 40, 10); // baseline 40/min
  feed(t, 40, 5, 25); // 100/min = 2.5x
  assert.equal(t.assess(T0 + 44 * MIN + 30_000).level, "elevated");
  const t2 = new ThreatMonitor();
  feed(t2, 0, 40, 10);
  feed(t2, 40, 5, 50); // 200/min = 5x
  assert.equal(t2.assess(T0 + 44 * MIN + 30_000).level, "high");
});

test("a quiet network is not 'high' because of a handful of events", () => {
  const t = new ThreatMonitor();
  t.assess(T0); // the page opens, nothing happens for 40 minutes
  feed(t, 40, 5, 1, "critical"); // 10/min against a ~0 baseline: floor and minimum rate apply
  assert.equal(t.assess(T0 + 44 * MIN + 30_000).level, "normal");
});

test("steps down only after holding for a minute", () => {
  const t = new ThreatMonitor();
  feed(t, 0, 40, 10);
  feed(t, 40, 5, 50);
  assert.equal(t.assess(T0 + 44 * MIN + 30_000).level, "high");
  // five minutes of nothing: the rate falls away immediately, but the level holds first
  assert.equal(t.assess(T0 + 45 * MIN + 30_000).level, "high");
  const later = t.assess(T0 + 50 * MIN + 31_000);
  assert.notEqual(later.level, "high");
});

test("fixed thresholds skip learning and use your numbers", () => {
  const t = new ThreatMonitor({ elevated: 30, high: 100 });
  assert.ok(t.fixedThresholds);
  feed(t, 0, 5, 5); // 20/min
  assert.equal(t.assess(T0 + 4 * MIN + 30_000).level, "normal");
  feed(t, 5, 5, 10); // 40/min over the window
  assert.equal(t.assess(T0 + 9 * MIN + 30_000).level, "elevated");
  feed(t, 10, 5, 30); // 120/min
  assert.equal(t.assess(T0 + 14 * MIN + 30_000).level, "high");
  assert.match(t.assess(T0 + 14 * MIN + 30_000).reason, /your thresholds/);
});

test("old history is forgotten", () => {
  const t = new ThreatMonitor({ elevated: 30, high: 100 });
  feed(t, 0, 5, 50);
  assert.equal(t.assess(T0 + 4 * MIN + 30_000).level, "high");
  assert.equal(t.assess(T0 + 200 * MIN).rate, 0);
});
