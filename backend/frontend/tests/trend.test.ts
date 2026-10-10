import assert from "node:assert/strict";
import { test } from "node:test";
import { TrendStats } from "../src/trend";
import { TrafficEvent } from "../src/types";

const ev = (severity: string): TrafficEvent => ({ severity } as TrafficEvent);
const MIN = 60_000;
const T0 = 2_000_000 * MIN;

test("series covers the span, oldest first, ending at the current minute", () => {
  const t = new TrendStats(60);
  t.record(ev("critical"), T0 + 5_000);
  t.record(ev("critical"), T0 + 6_000);
  t.record(ev("major"), T0 + 7_000);
  t.record(ev("major"), T0 + 2 * MIN);
  const s = t.series(T0 + 2 * MIN + 10_000);
  assert.equal(s.length, 60);
  assert.equal(s[59].total, 1);               // current minute
  assert.equal(s[58].total, 0);               // an empty minute is a zero, not a gap
  assert.equal(s[57].total, 3);
  assert.deepEqual(s[57].counts, { critical: 2, major: 1 });
  assert.ok(s[0].t < s[59].t && s[59].t - s[58].t === MIN);
});

test("old minutes fall out of the window", () => {
  const t = new TrendStats(10);
  t.record(ev("high"), T0);
  assert.equal(t.series(T0).at(-1)!.total, 1);
  assert.equal(t.series(T0 + 11 * MIN).reduce((n, p) => n + p.total, 0), 0);
  t.record(ev("high"), T0 + 20 * MIN); // recording again prunes the old bucket
  assert.equal(t.series(T0 + 20 * MIN).reduce((n, p) => n + p.total, 0), 1);
});
