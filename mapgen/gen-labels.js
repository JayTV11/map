/** One-time generator for frontend/src/country-labels.ts and
 *  frontend/src/city-labels.ts -- see README.md. You do not need to run
 *  this to build or run the app; its output is already committed.
 *
 * Countries: world-countries package (sovereign/independent states only).
 * Cities: all-the-cities package (GeoNames-derived), top 500 by population.
 *
 * LABEL TIERS ARE COLLISION-CHECKED. Labels keep a constant on-screen size
 * as you zoom (see frontend/src/map-theme.css), so zooming in spreads them
 * apart. Each label is given the LOWEST zoom level at which its box doesn't
 * touch any already-placed label that is visible at that zoom, processing
 * countries largest-first and cities most-populous-first. That is why Norway
 * and Sweden no longer print on top of each other, and why small countries
 * only appear once you've zoomed far enough that they have room.
 *
 * The zoom thresholds below MUST match frontend/src/mapZoom.ts:
 *   zoom-tier-1 = 2x, zoom-tier-2 = 4.5x, zoom-tier-3 = 8x, zoom-tier-4 = 12x
 */
const worldCountries = require("world-countries");
const cities = require("all-the-cities");
const fs = require("fs");

// Zoom at which each label tier becomes visible. Tier 1 = the unzoomed world view.
const COUNTRY_ZOOM = [1, 2, 4.5, 8]; // country tiers 1..4
const CITY_ZOOM = [2, 4.5, 8, 12];   // city tiers 1..4 (mapZoom's zoom-tier-1..4)

// Even if nothing collides, the unzoomed world view stays readable: only this many of the largest countries are eligible for it.
const MAX_WORLD_VIEW_COUNTRIES = 45;

// Label font sizes in SVG units at 1x zoom (== on-screen size, since they're constant-size). Keep in sync with map-theme.css.
const COUNTRY_FONT = [5, 4.2, 3.6, 3.2];
const CITY_FONT = [4.4, 3.8, 3.4, 3.2];

const COUNTRY_LETTER_SPACING = 0.9;   // matches map-theme.css
const CITY_DOT_RADIUS = 1.8, CITY_TEXT_DX = 2.2, CITY_TEXT_DY = 1.2;
const PAD = 1.0;                      // breathing room between labels, in on-screen units

const toSvg = (lat, lon) => [((lon + 180) / 360) * 1000, ((90 - lat) / 180) * 500];

/** Box in SVG units for a label at zoom z. All label dimensions are on-screen
 *  sizes, so they shrink by 1/z in map space while their anchor stays put. */
function countryBox(name, lat, lon, tier, z) {
  const F = COUNTRY_FONT[tier - 1];
  const [x, y] = toSvg(lat, lon);
  const w = name.length * 0.7 * F + (name.length - 1) * COUNTRY_LETTER_SPACING; // uppercase, bold
  return { x0: x - (w / 2 + PAD) / z, x1: x + (w / 2 + PAD) / z, y0: y - (0.75 * F + PAD) / z, y1: y + (0.2 * F + PAD) / z };
}
function cityBox(name, lat, lon, tier, z) {
  const F = CITY_FONT[tier - 1];
  const [x, y] = toSvg(lat, lon);
  const w = name.length * 0.56 * F; // mixed case
  const tx = x + CITY_TEXT_DX / z, ty = y + CITY_TEXT_DY / z;
  return { x0: x - (CITY_DOT_RADIUS + PAD) / z, x1: tx + (w + PAD) / z, y0: ty - (0.75 * F + PAD) / z, y1: ty + (0.2 * F + PAD) / z };
}
const hit = (a, b) => a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;

// ---- countries: largest first, lowest zoom at which the label fits ----
const countries = worldCountries
  .filter((c) => c.independent)
  .sort((a, b) => b.area - a.area)
  .map((c) => ({ name: c.name.common, lat: Number(c.latlng[0].toFixed(2)), lon: Number(c.latlng[1].toFixed(2)) }));

const placedCountries = [];
for (const [rank, c] of countries.entries()) {
  let tier = COUNTRY_ZOOM.length; // worst case: shows at max zoom even if still crowded
  for (let t = rank < MAX_WORLD_VIEW_COUNTRIES ? 1 : 2; t <= COUNTRY_ZOOM.length; t++) {
    const z = COUNTRY_ZOOM[t - 1];
    const box = countryBox(c.name, c.lat, c.lon, t, z);
    const clash = placedCountries.some((p) => p.tier <= t && hit(box, countryBox(p.name, p.lat, p.lon, p.tier, z)));
    if (!clash) { tier = t; break; }
  }
  c.tier = tier;
  placedCountries.push(c);
}
const countryLabels = [...countries].sort((a, b) => a.name.localeCompare(b.name));

// ---- cities: most populous first; must also clear the country labels visible at that zoom ----
const TOP_CITIES = 500;
const topCities = [...cities]
  .filter((c) => c.population > 0)
  .sort((a, b) => b.population - a.population)
  .slice(0, TOP_CITIES)
  .map((c) => ({ name: c.name, lat: Number(c.loc.coordinates[1].toFixed(2)), lon: Number(c.loc.coordinates[0].toFixed(2)) }));

const placedCities = [];
let droppedCities = 0;
for (const c of topCities) {
  let tier = 0; // 0 = never fits, even fully zoomed in: left off the map
  for (let t = 1; t <= CITY_ZOOM.length; t++) {
    const z = CITY_ZOOM[t - 1];
    const box = cityBox(c.name, c.lat, c.lon, t, z);
    const clashCity = placedCities.some((p) => p.tier <= t && hit(box, cityBox(p.name, p.lat, p.lon, p.tier, z)));
    const clashCountry = placedCountries.some((p) => COUNTRY_ZOOM[p.tier - 1] <= z && hit(box, countryBox(p.name, p.lat, p.lon, p.tier, z)));
    if (!clashCity && !clashCountry) { tier = t; break; }
  }
  if (tier === 0) { droppedCities++; continue; }
  c.tier = tier;
  placedCities.push(c);
}

// ---- report: how crowded is each zoom level after tiering? ----
function report() {
  for (const z of [1, 2, 4.5, 8, 12]) {
    const boxes = [
      ...placedCountries.filter((p) => COUNTRY_ZOOM[p.tier - 1] <= z).map((p) => countryBox(p.name, p.lat, p.lon, p.tier, z)),
      ...placedCities.filter((p) => CITY_ZOOM[p.tier - 1] <= z).map((p) => cityBox(p.name, p.lat, p.lon, p.tier, z)),
    ];
    let overlaps = 0;
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) if (hit(boxes[i], boxes[j])) overlaps++;
    console.log(`zoom ${String(z).padEnd(3)}: ${String(boxes.length).padStart(3)} labels visible, ${overlaps} overlapping pairs`);
  }
}

const header =
  "// Generated by mapgen/gen-labels.js -- do not hand-edit.\n" +
  "// Source: world-countries + all-the-cities npm packages (see mapgen/README.md).\n" +
  "// `tier` is collision-checked: the lowest zoom level at which the label fits.\n\n";

fs.writeFileSync(
  "../frontend/src/country-labels.ts",
  header +
    "export interface CountryLabel {\n  name: string;\n  lat: number;\n  lon: number;\n  tier: 1 | 2 | 3 | 4;\n}\n\n" +
    `export const COUNTRY_LABELS: CountryLabel[] = ${JSON.stringify(countryLabels)};\n`,
);

fs.writeFileSync(
  "../frontend/src/city-labels.ts",
  header +
    "export interface CityLabel {\n  name: string;\n  lat: number;\n  lon: number;\n  tier: 1 | 2 | 3 | 4;\n}\n\n" +
    `export const CITY_LABELS: CityLabel[] = ${JSON.stringify(placedCities)};\n`,
);

const count = (arr, k) => [1, 2, 3, 4].map((t) => arr.filter((x) => x.tier === t).length);
console.log("countries by tier 1..4:", count(countryLabels).join(" / "), "  cities by tier 1..4:", count(placedCities).join(" / "), `  (${droppedCities} of ${TOP_CITIES} cities dropped: no room)`);
report();
