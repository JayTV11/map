import { WORLD_LAND_PATH } from "./world-path";
import { COUNTRY_LABELS } from "./country-labels";
import { CITY_LABELS } from "./city-labels";

/** Static markers baked into the base map SVG -- unlike ArcEngine's canvas
 *  layer these don't move, fade, or get cleared per-frame. Add more pins
 *  here as needed. */
interface PointOfInterest {
  label: string;
  lat: number;
  lon: number;
}

const POINTS_OF_INTEREST: PointOfInterest[] = [
  { label: "Oak Ridge, TN", lat: 36.0104, lon: -84.2696 },
];

// The SVG's own coordinate space -- must match the 1000x500 used to bake
// world-path.ts (see mapgen/gen.js).
const SVG_W = 1000;
const SVG_H = 500;

/** Plain equirectangular lon/lat -> the SVG's own 1000x500 coordinate
 *  space. Shared by the static POI markers below and by project() (which
 *  layers the container's scale-to-fit/center on top of this). */
function toSvgCoords(lat: number, lon: number): [number, number] {
  return [((lon + 180) / 360) * SVG_W, ((90 - lat) / 180) * SVG_H];
}

// Five-pointed star centered at (0,0), outer radius 10 / inner radius 4 --
// each marker scales it down via its own <g transform>.
const STAR_PATH =
  "M 0,-10 L 2.351,-3.236 L 9.511,-3.090 L 3.804,1.236 L 5.878,8.090 " +
  "L 0,4 L -5.878,8.090 L -3.804,1.236 L -9.511,-3.090 L -2.351,-3.236 Z";

function poiMarker(poi: PointOfInterest): string {
  const [x, y] = toSvgCoords(poi.lat, poi.lon);
  return `<g class="poi-star" transform="translate(${x},${y}) scale(0.6)"><title>${poi.label}</title><path d="${STAR_PATH}"/></g>`;
}

/** Minimal escaping for text pulled from the baked country/city datasets --
 *  we don't control that data's exact contents (it's generated from
 *  third-party npm packages, see mapgen/gen-labels.js), so it's not safe
 *  to interpolate directly into the SVG string. */
function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Country name labels -- always visible, at every zoom level (they fade
 *  out somewhat at deeper zoom tiers via CSS -- see style.css -- so they
 *  don't dominate the view once the user has zoomed in on a city). */
function countryLabelMarkup(name: string, lat: number, lon: number): string {
  const [x, y] = toSvgCoords(lat, lon);
  return `<text class="label-country" x="${x}" y="${y}">${escapeXml(name)}</text>`;
}

/** City labels, revealed progressively by tier as the user zooms in (see
 *  mapZoom.ts's zoom-tier-N classes and style.css's .label-city rules) --
 *  tier 1 is the ~40 largest world cities, tier 3 the least prominent of
 *  the top 500. This is a population-ranked approximation of Google
 *  Maps-style label decluttering, not true collision detection -- dense
 *  regions (e.g. Europe) can still show some overlap once tier 3 is on. */
function cityLabelMarkup(name: string, lat: number, lon: number, tier: 1 | 2 | 3): string {
  const [x, y] = toSvgCoords(lat, lon);
  const tx = (x + 1.6).toFixed(2);
  const ty = (y + 1.1).toFixed(2);
  return `<g class="label-city tier-${tier}"><circle cx="${x}" cy="${y}" r="0.9"/><text x="${tx}" y="${ty}">${escapeXml(name)}</text></g>`;
}

export function renderWorldMap(container: HTMLElement): void {
  // "meet" (scale-to-fit, letterboxed) -- not "slice" -- so the whole
  // globe is always visible. "slice" (crop-to-fill) sounds nicer but on
  // most normal window shapes crops a large chunk of longitude off the
  // edges to fill the box, which is wrong for a "where in the world" map.
  container.innerHTML = `<svg viewBox="0 0 1000 500" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg">
    <path class="land" d="${WORLD_LAND_PATH}"/>
    ${POINTS_OF_INTEREST.map(poiMarker).join("")}
    ${COUNTRY_LABELS.map((c) => countryLabelMarkup(c.name, c.lat, c.lon)).join("")}
    ${CITY_LABELS.map((c) => cityLabelMarkup(c.name, c.lat, c.lon, c.tier)).join("")}
  </svg>`;
}

/** Projects lat/lon into the *rendered* map's pixel space.
 *
 * This has to do two things, not one: convert lon/lat to the SVG's own
 * 1000x500 coordinate space (plain equirectangular), and then replicate
 * exactly how the browser positions that viewBox inside the actual
 * container -- which, because the SVG uses preserveAspectRatio="xMidYMid
 * meet", is a uniform scale-to-fit plus a centering offset, NOT a simple
 * per-axis stretch to width/height. Skipping that second step is what
 * caused arcs to land off the visible coastline: it only lines up when
 * the container happens to be exactly 2:1.
 */
export function project(lat: number, lon: number, width: number, height: number): [number, number] {
  const [svgX, svgY] = toSvgCoords(lat, lon);

  // "meet" = scale to FIT inside the container (like CSS background-size:
  // contain), then center -- so scale is the SMALLER of the two ratios
  // (must match the meet/slice choice in renderWorldMap above exactly).
  const scale = Math.min(width / SVG_W, height / SVG_H);
  const offsetX = (width - SVG_W * scale) / 2;
  const offsetY = (height - SVG_H * scale) / 2;

  return [offsetX + svgX * scale, offsetY + svgY * scale];
}
