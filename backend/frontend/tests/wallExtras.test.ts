import assert from "node:assert/strict";
import { test } from "node:test";
import { formatClock } from "../src/wallExtras";

test("clock text: local time, long date, and UTC", () => {
  const d = new Date("2026-10-10T15:05:09Z");
  const c = formatClock(d, "en-US");
  assert.match(c.time, /\d{1,2}:\d{2}:\d{2}/);
  assert.match(c.date, /^\w+day, October \d+$/);
  assert.equal(c.utc, "15:05 UTC");
  assert.equal(formatClock(new Date("2026-01-02T03:04:05Z"), "en-US").utc, "03:04 UTC"); // zero-padded
});
