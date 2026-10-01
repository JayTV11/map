One-time generators for the base map data. You do not need to run these to
build or run the app -- their output is already committed.

    npm install

## Land outline + country borders

Writes `frontend/src/world-path.ts` and `frontend/src/world-borders.ts`
directly (no manual paste step):

    node gen.js

Natural Earth data via `world-atlas`, projected with `d3-geo` (plain
equirectangular into a 1000x500 space) and clipped at the antimeridian, so
Russia/Alaska, Fiji and Antarctica don't draw streaks across the map. Change
`RES` at the top of `gen.js` to `"50m"` for sharper coastlines at deep zoom --
at the cost of a ~10x larger path (~770 KB) and heavier zoom/pan.

## Country/city name labels

Writes `frontend/src/country-labels.ts` and `frontend/src/city-labels.ts`:

    node gen-labels.js

Countries: `world-countries` package, independent/sovereign states only.
Cities: `all-the-cities` (GeoNames-derived), top 500 by population.

Every label gets a zoom tier by **collision checking**: the lowest zoom level
at which its box doesn't touch an already-placed label. Labels keep a constant
on-screen size as you zoom (see `frontend/src/map-theme.css`), so zooming in
spreads them apart. The script prints how crowded each zoom level ends up.

The zoom levels and font sizes at the top of `gen-labels.js` must match
`frontend/src/mapZoom.ts` (zoom-tier thresholds) and `map-theme.css` (label
font sizes). Change them together, then re-run.
