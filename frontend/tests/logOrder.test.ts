import test from "node:test";
import assert from "node:assert/strict";
import { LogItem, groupItems, sortItems } from "../src/logOrder";

const item = (id: number, o: Partial<LogItem> = {}): LogItem => ({
  id, rank: 1, anomaly: 0, count: 1, country: "Russia", target: "Web", signature: "S", ...o,
});

test("newest puts the highest id first", () => {
  assert.deepEqual(sortItems([item(1), item(3), item(2)], "newest").map((i) => i.id), [3, 2, 1]);
});

test("severity sorts by rank, then unusualness, then newest", () => {
  const out = sortItems([item(1, { rank: 2 }), item(2, { rank: 4 }), item(3, { rank: 2, anomaly: 80 }), item(4, { rank: 2 })], "severity");
  assert.deepEqual(out.map((i) => i.id), [2, 3, 4, 1]);
});

test("unusual sorts by score first", () => {
  const out = sortItems([item(1, { anomaly: 10, rank: 4 }), item(2, { anomaly: 90, rank: 1 })], "unusual");
  assert.deepEqual(out.map((i) => i.id), [2, 1]);
});

test("repeats sorts by count", () => {
  const out = sortItems([item(1, { count: 5 }), item(2, { count: 500 }), item(3, { count: 5 })], "repeats");
  assert.deepEqual(out.map((i) => i.id), [2, 3, 1]);
});

test("sorting does not change the input", () => {
  const input = [item(1), item(2)];
  sortItems(input, "newest");
  assert.deepEqual(input.map((i) => i.id), [1, 2]);
});

test("no grouping gives one unlabeled section", () => {
  const s = groupItems([item(2), item(1)], "none");
  assert.equal(s.length, 1);
  assert.equal(s[0].label, null);
});

test("groups come in order of their best row and keep sorted order inside", () => {
  const sorted = sortItems([
    item(1, { rank: 1, country: "France" }),
    item(2, { rank: 4, country: "Russia" }),
    item(3, { rank: 3, country: "France" }),
    item(4, { rank: 2, country: "Russia" }),
  ], "severity");
  const s = groupItems(sorted, "country");
  assert.deepEqual(s.map((x) => x.label), ["Russia", "France"]);
  assert.deepEqual(s[0].items.map((i) => i.id), [2, 4]);
  assert.deepEqual(s[1].items.map((i) => i.id), [3, 1]);
});

test("an empty label becomes Unknown", () => {
  const s = groupItems([item(1, { signature: "" })], "signature");
  assert.equal(s[0].label, "Unknown");
});
