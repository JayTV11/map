import assert from "node:assert/strict";
import { test } from "node:test";
import { computeArcGeometry } from "../src/arcGeometry";
import { hitTest } from "../src/hitTest";
import { TrafficEvent } from "../src/types";

function ev(id: string, o: Partial<TrafficEvent> = {}): TrafficEvent {
  return { id, src_lat: 50, src_lon: 30, dst_lat: 36, dst_lon: -84, severity: "critical", ...o } as TrafficEvent;
}
const W = 1200, H = 600;
const NOW = 1_000_000;

test("a click on the landing ring picks that arc", () => {
  const e = ev("a");
  const g = computeArcGeometry(e, W, H);
  assert.equal(hitTest([{ event: e, at: NOW - 1000 }], g.x2 + 6, g.y2 - 4, W, H, NOW), e);
  assert.equal(hitTest([{ event: e, at: NOW - 1000 }], g.x1 - 5, g.y1 + 5, W, H, NOW), e); // and the source end
});

test("a click on the curve itself works, in the middle of the arc", () => {
  const e = ev("a");
  const g = computeArcGeometry(e, W, H);
  const mx = 0.25 * g.x1 + 0.5 * g.cx + 0.25 * g.x2; // curve midpoint at t = 0.5
  const my = 0.25 * g.y1 + 0.5 * g.cy + 0.25 * g.y2;
  assert.equal(hitTest([{ event: e, at: NOW }], mx + 3, my + 3, W, H, NOW), e);
});

test("a click far from everything picks nothing", () => {
  assert.equal(hitTest([{ event: ev("a"), at: NOW }], 5, 5, W, H, NOW), null);
});

test("old arcs are not clickable", () => {
  const e = ev("a");
  const g = computeArcGeometry(e, W, H);
  assert.equal(hitTest([{ event: e, at: NOW - 21_000 }], g.x2, g.y2, W, H, NOW), null);
  assert.equal(hitTest([{ event: e, at: NOW - 19_000 }], g.x2, g.y2, W, H, NOW), e);
});

test("an end point beats a curve passing nearby, and newer beats older on a tie", () => {
  const target = ev("target", { dst_lat: 36, dst_lon: -84, src_lat: 50, src_lon: 30 });
  const gt = computeArcGeometry(target, W, H);
  // an arc whose destination is elsewhere but whose curve passes through the clicked point
  const passing = ev("passing", { src_lat: 36, src_lon: -150, dst_lat: 36, dst_lon: 30 });
  const picked = hitTest([{ event: passing, at: NOW - 100 }, { event: target, at: NOW - 5000 }], gt.x2, gt.y2, W, H, NOW);
  assert.equal(picked?.id, "target");

  const older = ev("older"), newer = ev("newer"); // identical geometry
  const g = computeArcGeometry(older, W, H);
  assert.equal(hitTest([{ event: older, at: NOW - 3000 }, { event: newer, at: NOW - 1000 }], g.x2, g.y2, W, H, NOW)?.id, "newer");
});

test("follows the current map size, not the size at draw time", () => {
  const e = ev("a");
  const small = computeArcGeometry(e, 600, 300);
  assert.equal(hitTest([{ event: e, at: NOW }], small.x2, small.y2, 600, 300, NOW), e);
  assert.equal(hitTest([{ event: e, at: NOW }], small.x2, small.y2, 1200, 600, NOW), null); // that spot is empty on the bigger map
});
