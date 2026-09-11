import { WORLD_LAND_PATH } from "./world-path";

export function renderWorldMap(container: HTMLElement): void {
  container.innerHTML = `<svg viewBox="0 0 1000 500" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg">
    <path class="land" d="${WORLD_LAND_PATH}"/>
  </svg>`;
}

/** Same equirectangular projection used to bake world-path.ts (see
 * mapgen/gen.js in the repo root) -- keep these in sync or arcs will
 * land in the wrong place relative to the coastlines. */
export function project(lat: number, lon: number, width: number, height: number): [number, number] {
  const x = ((lon + 180) / 360) * width;
  const y = ((90 - lat) / 180) * height;
  return [x, y];
}
