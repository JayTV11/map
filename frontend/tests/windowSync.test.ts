import assert from "node:assert/strict";
import test from "node:test";
import { parseSyncMessage, viewMode, WindowSync } from "../src/windowSync";
import { isColorBlind, setColorBlind, severityColor, severityShape, setSeverityLevels } from "../src/types";

test("view mode comes from ?view=", () => {
  assert.equal(viewMode("?view=console"), "console");
  assert.equal(viewMode("?x=1&view=map"), "map");
  assert.equal(viewMode("?view=other"), "full");
  assert.equal(viewMode(""), "full");
});

const ev = { severity: "critical", src_lat: 1, src_lon: 2, dst_lat: 3, dst_lon: 4, src_ip: "1.1.1.1", dst_ip: null, signature: "x" };

test("only well-formed sync messages are accepted", () => {
  assert.deepEqual(parseSyncMessage({ type: "unpin" }), { type: "unpin" });
  assert.ok(parseSyncMessage({ type: "pin", event: ev }));
  for (const bad of [null, "x", 5, {}, { type: "pin" }, { type: "pin", event: {} }, { type: "pin", event: { ...ev, src_lat: "1" } },
    { type: "pin", event: { ...ev, src_ip: 5 } }, { type: "boom" }]) assert.equal(parseSyncMessage(bad), null);
});

test("two windows exchange messages and ignore garbage", () => {
  const listeners: ((e: { data: unknown }) => void)[] = [];
  const make = () => ({ postMessage: (m: unknown) => listeners.forEach((l) => l({ data: m })), addEventListener: (_t: "message", fn: (e: { data: unknown }) => void) => { listeners.push(fn); }, close: () => {} });
  const got: unknown[] = [];
  const a = new WindowSync((m) => got.push(m), make);
  a.post({ type: "unpin" });
  listeners.forEach((l) => l({ data: { type: "nope" } }));
  assert.deepEqual(got, [{ type: "unpin" }]);
  assert.equal(new WindowSync(() => {}, null).available, false);
});

test("colour-blind palette swaps colours and adds shapes; unknown stays blue and round", () => {
  setSeverityLevels([{ id: "critical", label: "C", color: "#f00" }, { id: "major", label: "M", color: "#0f0" }, { id: "high", label: "H", color: "#00f" }]);
  assert.equal(severityColor("critical"), "#f00");
  assert.equal(severityShape("critical"), "circle");
  setColorBlind(true);
  assert.ok(isColorBlind());
  const colors = ["critical", "major", "high"].map(severityColor);
  assert.equal(new Set(colors).size, 3);
  const shapes = ["critical", "major", "high"].map(severityShape);
  assert.equal(new Set(shapes).size, 3);
  assert.equal(severityColor("unknown"), "#4f8cff");
  assert.equal(severityShape("unknown"), "circle");
  setColorBlind(false);
});
