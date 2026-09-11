# Traffic Map

A local-only "missile map" visualization: animated arcs on a world map showing
traffic by geolocation, fed either by a CSV upload or by polling a live SIEM
(Elastic, backing Suricata alerts).

Nothing here calls out to the internet at runtime — no map tile server, no
IP-geolocation API — and nothing is persisted to disk beyond what your SIEM
already stores. This app is a live view, not a system of record.

## How it's built

One data contract (`TrafficEvent`) unifies both ingestion paths:

- **`backend/app/sources/elastic_source.py`** polls your Elastic index on an
  interval, using a `(timestamp, id)` cursor so nothing is missed or
  double-counted between polls. It expects `src_lat/lon` and `dst_lat/lon`
  to already exist on each document (no IP geolocation is performed here).
- **`backend/app/sources/csv_source.py`** loads an uploaded CSV
  (`src_lat, src_lon, dst_lat, dst_lon, severity, count, src_ip, dst_ip` —
  no timestamp) as a weighted pool and continuously fires synthetic events
  sampled from it, at a rate controlled by the intensity slider, rather than
  literally replaying a timeline that doesn't exist in the data.

Both sources call the same `broadcaster.publish()`, which fans events out to
every connected browser tab over one WebSocket. There is no database — an
in-memory rolling buffer (`backend/app/broadcast.py`) just lets a newly
opened tab catch up on the last few minutes.

The frontend (`frontend/src/arcs.ts`, `map.ts`) renders with plain Canvas 2D,
not a mapping library — this was validated in an interactive mockup before
any of this was built, and performed well without the WebGL/basemap-tile
complexity a library like deck.gl would have pulled in. The world outline
itself is a static path baked once from Natural Earth data (see `mapgen/`)
and committed as `frontend/src/world-path.ts` — no map tiles are fetched at
runtime.

Severity is a 3-tier scale sourced from Suricata: **Critical** > **Major** >
**High**, plus an `unknown` fallback for anything that doesn't map cleanly.

## Running it

### Backend

```
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env        # then fill in ELASTIC_API_KEY if you're using the live feed
```

Edit `backend/config.yaml`:

- Leave `elastic.hosts: []` (empty list) if you only want CSV mode for now —
  the app runs fine with no Elastic configured.
- Otherwise set `elastic.hosts`, `elastic.index`, and check
  `elastic.field_mapping` against your actual index's field names (Suricata
  → Elastic pipelines vary in exactly where geo/severity end up).

```
python run.py
```

This binds to `127.0.0.1:8000` by default (not `0.0.0.0` — it's not meant to
be exposed to your network) and opens your browser automatically once the
frontend has been built (see below).

### Frontend

```
cd frontend
npm install
npm run dev       # dev server with hot reload, proxies /api and /ws to :8000
```

For the version the backend actually serves at `127.0.0.1:8000`:

```
npm run build      # outputs frontend/dist, which backend/app/main.py mounts
```

### Try it without Elastic

With `elastic.hosts` empty, start the backend, open the app, and upload
`sample_data/example.csv` from the sidebar — you should see the same arc
animation validated in the earlier mockup, just running off the real
pipeline this time.

## What's a stub vs. what's real here

This is a scaffold to build on, not a finished app:

- `elastic_source.py` is untested against a live cluster — the query shape,
  cursor logic, and field-mapping approach are all real, but expect to
  adjust field paths once you point it at your actual index.
- There's no throttling yet between a burst of events and the renderer —
  worth adding if your index turns out to be bursty (flagged during the
  original design discussion, never resolved).
- No auth/session handling — this is intentionally a single-user, local tool.
- No automated tests yet.

## Repo layout

```
backend/     FastAPI app, ingestion sources, WebSocket broadcast
frontend/    Vite + TypeScript, Canvas 2D rendering
mapgen/      one-time script that generated frontend/src/world-path.ts
sample_data/ example CSV matching the required column schema
```
