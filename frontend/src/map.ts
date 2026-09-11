import { WORLD_LAND_PATH } from "./world-path";

export function renderWorldMap(container: HTMLElement): void {
  // "meet" (scale-to-fit, letterboxed) -- not "slice" -- so the whole
  // globe is always visible. "slice" (crop-to-fill) sounds nicer but on
  // most normal window shapes crops a large chunk of longitude off the
  // edges to fill the box, which is wrong for a "where in the world" map.
  container.innerHTML = `<svg viewBox="0 0 1000 500" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg">
    <path class="land" d="${WORLD_LAND_PATH}"/>
  </svg>`;
}

// The SVG's own coordinate space -- must match the 1000x500 used to bake
// world-path.ts (see mapgen/gen.js).
const SVG_W = 1000;
const SVG_H = 500;

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
  const svgX = ((lon + 180) / 360) * SVG_W;
  const svgY = ((90 - lat) / 180) * SVG_H;

  // "meet" = scale to FIT inside the container (like CSS background-size:
  // contain), then center -- so scale is the SMALLER of the two ratios
  // (must match the meet/slice choice in renderWorldMap above exactly).
  const scale = Math.min(width / SVG_W, height / SVG_H);
  const offsetX = (width - SVG_W * scale) / 2;
  const offsetY = (height - SVG_H * scale) / 2;

  return [offsetX + svgX * scale, offsetY + svgY * scale];
}