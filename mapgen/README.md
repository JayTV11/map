One-time generators. You do not need to run these to build or run the
app -- their output is already committed.

## World outline (frontend/src/world-path.ts)

Re-run only if you want a different map resolution/projection.

    npm install
    node gen.js
    # then paste worldpath.txt's contents into ../frontend/src/world-path.ts

## Country/city name labels (frontend/src/country-labels.ts, city-labels.ts)

Re-run only if you want a different city cutoff/tiering, or to refresh
against newer package data. Writes both output files directly (no manual
paste step needed).

    npm install
    node gen-labels.js

Countries: `world-countries` package, independent/sovereign states only.
Cities: `all-the-cities` (GeoNames-derived), top 500 by population, split
into 3 tiers by rank so the frontend can reveal more of them as the user
zooms in -- see `frontend/src/mapZoom.ts`'s zoom-tier classes and
`style.css`'s `.label-city` rules.
