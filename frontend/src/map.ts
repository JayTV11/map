import { WORLD_LAND_PATH } from "./world-path";

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

export function renderWorldMap(container: HTMLElement): void {
  // "meet" (scale-to-fit, letterboxed) -- not "slice" -- so the whole
  // globe is always visible. "slice" (crop-to-fill) sounds nicer but on
  // most normal window shapes crops a large chunk of longitude off the
  // edges to fill the box, which is wrong for a "where in the world" map.
  container.innerHTML = `<svg viewBox="0 0 1000 500" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg">
    <path class="land" d="${WORLD_LAND_PATH}"/>
    ${POINTS_OF_INTEREST.map(poiMarker).join("")}
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