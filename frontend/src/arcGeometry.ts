import { project } from "./map";
import { TrafficEvent } from "./types";

export interface ArcGeometry {
  x1: number; y1: number; x2: number; y2: number; cx: number; cy: number;
}

/** Same src/dst -> quadratic-curve-control-point math used for every live
 *  arc. Pulled out so the pinned "missile" (see ArcEngine.pin) and the
 *  click-to-pin hit test (hitTest.ts) can recompute geometry from the event's
 *  lat/lon for the CURRENT map size, rather than caching stale pixel
 *  coordinates that would drift out of sync on window resize. */
export function computeArcGeometry(event: TrafficEvent, w: number, h: number): ArcGeometry {
  const [x1, y1] = project(event.src_lat, event.src_lon, w, h);
  const [x2, y2] = project(event.dst_lat, event.dst_lon, w, h);
  const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
  const dx = x2 - x1, dy = y2 - y1;
  const dist = Math.hypot(dx, dy) || 1;
  const bow = Math.min(dist * 0.28, 140);
  const nx = -dy / dist, ny = dx / dist;
  return { x1, y1, x2, y2, cx: mx + nx * bow, cy: my + ny * bow };
}
