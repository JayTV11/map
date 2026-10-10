import { COUNTRY_GEO } from "./country-geo";
import { TrafficEvent } from "./types";

/** Names the country a lat/lon falls in, offline: a point-in-polygon test
 *  against the Natural Earth outlines baked into country-geo.ts. No network
 *  call, and nothing about an address leaves the browser.
 *
 *  Accuracy is country level, from 110m outlines rounded to ~11 km. Tiny
 *  states and islands that the 110m data omits (Singapore, Malta, ...) fall
 *  to the nearest outline within a few degrees, so they may be reported as a
 *  neighbour; open ocean returns null. Good enough for a "top source
 *  countries" ranking, not for anything legal. */

interface Country {
  name: string;
  rings: number[][];
  minX: number; maxX: number; minY: number; maxY: number;
  area: number;
}

const COUNTRIES: Country[] = COUNTRY_GEO.map(([name, rings]) => {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const r of rings) {
    for (let i = 0; i < r.length; i += 2) {
      if (r[i] < minX) minX = r[i];
      if (r[i] > maxX) maxX = r[i];
      if (r[i + 1] < minY) minY = r[i + 1];
      if (r[i + 1] > maxY) maxY = r[i + 1];
    }
  }
  return { name, rings, minX, maxX, minY, maxY, area: (maxX - minX) * (maxY - minY) };
// Smallest first, so a country enclosed by another (Lesotho inside South
// Africa's outline) is found before the one around it.
}).sort((a, b) => a.area - b.area);

function inRing(ring: number[], x: number, y: number): boolean {
  let inside = false;
  const n = ring.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[i * 2], yi = ring[i * 2 + 1], xj = ring[j * 2], yj = ring[j * 2 + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Squared distance in tenths-of-degree units from (x, y) to a ring's nearest vertex. */
function nearestVertexSq(ring: number[], x: number, y: number): number {
  let best = Infinity;
  for (let i = 0; i < ring.length; i += 2) {
    const dx = ring[i] - x, dy = ring[i + 1] - y;
    const d = dx * dx + dy * dy;
    if (d < best) best = d;
  }
  return best;
}

const NEAR_LIMIT = 30; // 3 degrees, in tenths
const cache = new Map<string, string | null>();
const MAX_CACHE = 20_000;

function lookup(lat: number, lon: number): string | null {
  const x = Math.round(lon * 10), y = Math.round(lat * 10);
  for (const c of COUNTRIES) {
    if (x < c.minX || x > c.maxX || y < c.minY || y > c.maxY) continue;
    for (const r of c.rings) if (inRing(r, x, y)) return c.name;
  }
  // Not inside any outline: a coastal point, or a small island the 110m data leaves out.
  let best: string | null = null;
  let bestD = NEAR_LIMIT * NEAR_LIMIT;
  for (const c of COUNTRIES) {
    if (x < c.minX - NEAR_LIMIT || x > c.maxX + NEAR_LIMIT || y < c.minY - NEAR_LIMIT || y > c.maxY + NEAR_LIMIT) continue;
    for (const r of c.rings) {
      const d = nearestVertexSq(r, x, y);
      if (d < bestD) { bestD = d; best = c.name; }
    }
  }
  return best;
}

/** Country name for a coordinate, or null for open ocean / invalid input. (0, 0) is treated as "no location". */
export function countryAt(lat: number, lon: number): string | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  if (lat === 0 && lon === 0) return null;
  const key = `${Math.round(lat * 4)},${Math.round(lon * 4)}`; // quarter-degree cells
  let hit = cache.get(key);
  if (hit === undefined) {
    if (cache.size >= MAX_CACHE) cache.clear();
    hit = lookup(lat, lon);
    cache.set(key, hit);
  }
  return hit;
}

/** The country an event's SOURCE is in, or null when it can't be told.
 *  A source location the backend filled in from the home site (because the
 *  data had none) is not a real location, so it isn't counted: otherwise
 *  every such event would be credited to your own country. */
export function sourceCountry(e: TrafficEvent): string | null {
  if (e.geo_note?.includes("source location assumed")) return null;
  return countryAt(e.src_lat, e.src_lon);
}
