import { test } from "node:test";
import assert from "node:assert/strict";
import { clampHeight, isDefaultLayout, mergeOrder, moveStep, parseLayout } from "../src/layoutState";

test("parseLayout drops anything malformed", () => {
  assert.deepEqual(parseLayout(null), { order: [], collapsed: {}, heights: {} });
  assert.deepEqual(parseLayout("junk"), { order: [], collapsed: {}, heights: {} });
  const s = parseLayout({ order: ["a", 5, "b"], collapsed: { a: true, b: "yes" }, heights: { a: 10, b: "x", c: 9999, d: 200 } });
  assert.deepEqual(s.order, ["a", "b"]);
  assert.deepEqual(s.collapsed, { a: true });
  assert.deepEqual(s.heights, { a: 56, c: 1400, d: 200 });
});

test("clampHeight keeps panels usable", () => {
  assert.equal(clampHeight(3), 56);
  assert.equal(clampHeight(300.4), 300);
  assert.equal(clampHeight(99999), 1400);
});

test("mergeOrder follows the saved order, ignores gone panels, keeps new ones in place", () => {
  assert.deepEqual(mergeOrder(["a", "b", "c"], ["c", "a", "b"]), ["c", "a", "b"]);
  assert.deepEqual(mergeOrder(["a", "b", "c"], ["c", "gone", "a"]), ["c", "b", "a"]);
  assert.deepEqual(mergeOrder(["a", "new", "b"], ["b", "a"]), ["b", "new", "a"]);
  assert.deepEqual(mergeOrder(["a", "b"], ["b", "b", "a"]), ["b", "a"]);
  assert.deepEqual(mergeOrder(["a", "b"], []), ["a", "b"]);
});

test("moveStep hops over hidden panels and stops at the ends", () => {
  const all = () => true;
  assert.deepEqual(moveStep(["a", "b", "c"], "a", 1, all), ["b", "a", "c"]);
  assert.deepEqual(moveStep(["a", "b", "c"], "c", -1, all), ["a", "c", "b"]);
  assert.deepEqual(moveStep(["a", "b", "c"], "a", -1, all), ["a", "b", "c"]);
  assert.deepEqual(moveStep(["a", "b", "c"], "c", 1, all), ["a", "b", "c"]);
  const hideB = (id: string) => id !== "b";
  assert.deepEqual(moveStep(["a", "b", "c"], "a", 1, hideB), ["b", "c", "a"]);
  assert.deepEqual(moveStep(["a", "b", "c"], "zzz", 1, all), ["a", "b", "c"]);
});

test("isDefaultLayout", () => {
  const def = ["a", "b"];
  const col = (id: string) => id === "b";
  assert.equal(isDefaultLayout({ order: [], collapsed: {}, heights: {} }, def, col), true);
  assert.equal(isDefaultLayout({ order: ["a", "b"], collapsed: { b: true }, heights: {} }, def, col), true);
  assert.equal(isDefaultLayout({ order: ["b", "a"], collapsed: {}, heights: {} }, def, col), false);
  assert.equal(isDefaultLayout({ order: [], collapsed: { a: true }, heights: {} }, def, col), false);
  assert.equal(isDefaultLayout({ order: [], collapsed: {}, heights: { a: 100 } }, def, col), false);
});
