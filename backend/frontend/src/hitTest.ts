import { computeArcGeometry } from "./arcGeometry";
import { TrafficEvent } from "./types";

/** Click-to-pin on the map: which recently drawn arc is the click on?
 *
 *  Arcs are short-lived, so this looks at what was drawn in the last few
 *  seconds (`maxAgeMs`) and picks the one whose end points -- or, less
 *  strictly, whose curve -- pass within `radius` pixels of the click. The end
 *  points are the easy target (the rings where an arc lands), so they win ties.
 *  Pure geometry; no DOM. */

export interface DrawnArc {
  event: TrafficEvent;
  /** When it was drawn, ms since epoch. */
  at: number;
}

export interface HitOptions {
  maxAgeMs: number;
  radius: number;
}

export const DEFAULT_HIT_OPTIONS: HitOptions = { maxAgeMs: 20_000, radius: 14 };

export function hitTest(
  arcs: readonly DrawnArc[], x: number, y: number, w: number, h: number, now: number,
  opts: HitOptions = DEFAULT_HIT_OPTIONS,
): TrafficEvent | null {
  let best: TrafficEvent | null = null;
  let bestScore = Infinity;

  for (let i = arcs.length - 1; i >= 0; i--) { // newest first, so ties go to the newest
    const a = arcs[i];
    if (now - a.at > opts.maxAgeMs) continue;
    const g = computeArcGeometry(a.event, w, h);

    const dEnd = Math.min(Math.hypot(x - g.x1, y - g.y1), Math.hypot(x - g.x2, y - g.y2));
    let score = dEnd <= opts.radius ? dEnd : Infinity;

    if (score === Infinity) {
      // Along the curve; counted as a weaker hit (scaled up) so an end point near the click wins.
      let dCurve = Infinity;
      for (let k = 1; k < 24; k++) {
        const t = k / 24, mt = 1 - t;
        const px = mt * mt * g.x1 + 2 * mt * t * g.cx + t * t * g.x2;
        const py = mt * mt * g.y1 + 2 * mt * t * g.cy + t * t * g.y2;
        const d = Math.hypot(x - px, y - py);
        if (d < dCurve) dCurve = d;
      }
      if (dCurve <= opts.radius * 0.6) score = dCurve + opts.radius; // always behind any end-point hit
    }

    if (score < bestScore) { bestScore = score; best = a.event; }
  }
  return best;
}
