import { WORLD_LAND_PATH } from "./world-path";
import { WORLD_BORDERS_PATH } from "./world-borders";
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

/** Country name labels. Tiered by land area (see mapgen/gen-labels.js and
 *  map-theme.css's .ctier-N rules): the ~30 biggest countries always show,
 *  smaller ones appear as the user zooms in, so the world view isn't a
 *  pile of overlapping names in Europe and Central America. Labels near
 *  the left/right edge anchor inward so they aren't cut off by the map
 *  boundary (Samoa, Tonga, Fiji, ...). */
function countryLabelMarkup(name: string, lat: number, lon: number, tier: 1 | 2 | 3 | 4): string {
  const [x, y] = toSvgCoords(lat, lon);
  const anchor = x < 30 ? "start" : x > 970 ? "end" : "middle";
  return `<text class="label-country ctier-${tier}" x="${x}" y="${y}" style="text-anchor:${anchor}">${escapeXml(name)}</text>`;
}

/** Faint lat/lon grid every 30 degrees -- no data, just gives the flat
 *  world some structure and a sense of scale. */
function graticulePath(): string {
  const d: string[] = [];
  for (let lon = -150; lon <= 150; lon += 30) {
    const [x] = toSvgCoords(0, lon);
    d.push(`M${x} 0V${SVG_H}`);
  }
  for (let lat = -60; lat <= 60; lat += 30) {
    const [, y] = toSvgCoords(lat, 0);
    d.push(`M0 ${y}H${SVG_W}`);
  }
  return d.join("");
}

/** City labels, revealed progressively by tier as the user zooms in (see
 *  mapZoom.ts's zoom-tier-N classes and style.css's .label-city rules).
 *  Tiers come from mapgen/gen-labels.js, which collision-checks every label
 *  at the zoom level it appears at, so labels don't print on top of each
 *  other. */
function cityLabelMarkup(name: string, lat: number, lon: number, tier: 1 | 2 | 3 | 4): string {
  const [x, y] = toSvgCoords(lat, lon);
  // The text is placed exactly at the dot; map-theme.css offsets it by a
  // constant on-screen distance (translate in px / zoom), so the gap between
  // dot and name doesn't stretch as the map is zoomed.
  return `<g class="label-city tier-${tier}"><circle cx="${x}" cy="${y}" r="0.9"/><text x="${x.toFixed(2)}" y="${y.toFixed(2)}">${escapeXml(name)}</text></g>`;
}

export function renderWorldMap(container: HTMLElement): void {
  // "meet" (scale-to-fit, letterboxed) -- not "slice" -- so the whole
  // globe is always visible. "slice" (crop-to-fill) sounds nicer but on
  // most normal window shapes crops a large chunk of longitude off the
  // edges to fill the box, which is wrong for a "where in the world" map.
  // The land shape is defined once and <use>d for the soft coastal glow
  // (a few progressively wider, fainter strokes underneath the land fill),
  // so the big path string isn't duplicated in the DOM. Fills/strokes come
  // from map-theme.css.
  container.innerHTML = `<svg viewBox="0 0 1000 500" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="land-grad" x1="0" y1="0" x2="0" y2="1">
        <stop class="land-stop-a" offset="0"/>
        <stop class="land-stop-b" offset="1"/>
      </linearGradient>
      <path id="land-shape" d="${WORLD_LAND_PATH}"/>
    </defs>
    <path class="graticule" d="${graticulePath()}"/>
    <use href="#land-shape" class="halo halo-3"/>
    <use href="#land-shape" class="halo halo-2"/>
    <use href="#land-shape" class="halo halo-1"/>
    <use href="#land-shape" class="land"/>
    <path class="borders" d="${WORLD_BORDERS_PATH}"/>
    ${POINTS_OF_INTEREST.map(poiMarker).join("")}
    ${COUNTRY_LABELS.map((c) => countryLabelMarkup(c.name, c.lat, c.lon, c.tier)).join("")}
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
