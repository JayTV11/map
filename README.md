# Sightline

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

## Searching and muting

**Search bar** (top-left of the map, press `/` to jump to it). A KQL-style
filter over the events the screen has received. It is not a query against
Elastic, so it can't search history, and it works the same for every data
source.

```
severity:(critical or major)
src_ip:203.0.113.0/24 and not dst_port:443
source.ip:10.0.0.0/8            # Elastic-style names work too
signature:*scan*                # * wildcards (unquoted values)
dst_asset:"Payment API"
dst_port >= 1024 and protocol:tcp
10.50.0.0/16                    # a bare address or range matches either side
```

`and` / `or` / `not` and parentheses work (and binds tighter than or; terms
side by side are ANDed). Any column that wasn't mapped to a built-in field is
searchable by its own name. A mistake shows a message under the bar and keeps
the last good filter. The query is saved in the URL (`?q=...`), so a filtered
view can be bookmarked or shared. A badge at the bottom of the map always shows
the active filter and how many events it hid, including in wall mode.

**Known-good sources.** Copy `backend/known_good.example.yaml` to
`backend/known_good.yaml` (gitignored; it describes your network) and list the
scanners, probes and partner gateways whose traffic you don't want to see. With
**Mute known-good sources** on (the default at page load; `?mute=0` starts it
off), events whose *source* is on the list are hidden from the map, log,
counters and Top Talkers, and the badge shows how many were muted. The file is
re-read within a minute of an edit, and a bad edit keeps the previous list.
Muting only changes what this screen shows; nothing is deleted and Elastic is
not touched.

## Wall display and analyst tools

**Wall mode** (press `K`, or open `/?kiosk=1`) is laid out for a 16:9 TV:

- **Threat level** (learning / normal / elevated / high) next to the severity counts. It compares the last 5 minutes with this site's own baseline from the prior hour (it says "learning" for the first ~15 minutes after the page loads). To use fixed numbers instead, set `threat_level: {elevated: ..., high: ...}` in `backend/config.yaml` (weighted events per minute; see `config.example.yaml`).
- **Spotlight card** for the most serious alerts, one at a time. If `assets.yaml` defines key assets, only hits on those qualify.
- Key-asset hits draw larger impact rings; the map shades night and day; clock with local time and UTC.
- **Top talkers** rotates through Sources / Countries / Signatures / Targets; the **events-per-minute** strip shows the last hour.
- After 30 s untouched, a slow **tour** visits home and the busiest source countries. Disable with `?tour=0`.
- **Logo:** put `logo.svg` or `logo.png` in `frontend/public/` and rebuild.

**Analyst tools** (normal view):

- Click an arc or endpoint to pin it (same as clicking its log row).
- Quick-filter chips under the search bar, plus saved searches (stored in this browser). `?chips=` and `?q=` in the URL preload them.
- **Replay & Export:** replay the last 1/5/10 minutes at 5-60x, or export them as CSV.
- **Alerts:** optional beep and desktop notification for critical hits on key assets (off by default; browsers need a click to allow sound).
- **Arrange the right-hand column:** click a panel title to fold it, drag the grip (the dots in its left margin, or focus it and press Alt+Up/Down) to move it, and drag its bottom edge to resize it (double-click the edge to undo). The layout is remembered in that browser, and "Reset panel layout" appears at the bottom once you've changed it. Wall mode ignores folding and sizes.
- In the detail panel, **Copy as known-good entry** produces a `known_good.yaml` line.

Replay history and exports live in the browser's memory only (last 10 minutes); closing the page clears them.

### Editing the known-good list from the screen (optional, off by default)

An admin can let analysts add and remove known-good sources in the Known-Good Sources panel, and mute a source straight from an event's details ("Mute this source..."). In `backend/config.yaml`:

```yaml
known_good:
  editable: true
  user_header: X-Forwarded-User   # the header your SSO proxy sets; requests without it are refused
```

- Screen-added entries go in `backend/data/known_good_added.json`; `known_good.yaml` is never rewritten, and the screen can only remove what it added.
- Every change is appended to `backend/data/known_good_audit.log` (who, what, when). Keep `backend/data/` on a persistent volume.
- Muting asks first, warns on Critical events or key systems, and refuses ranges wider than /16 (IPv6 /48); wider ones go in the YAML file.
- Muting is shared: it hides the source from every analyst's screen and the wall (other screens pick it up within a minute).

### Working the event log (analyst view)

- **Pop-out window:** hover a log row and click the expand icon, or select a row and press `E`. It shows every field, the raw record, and a note box. Left/right arrows step through the log.
- **Keyboard:** `J` jumps into the log, Up/Down/Home/End move, Enter pins, `E` expands, `R` marks reviewed, `P` pauses the list.
- **Sort and group** (toolbar above the log): newest, most severe, most unusual, most repeated; group by source country, target or signature.
- **Pause:** holds new rows back so the list stops moving; the button counts what you are missing.
- **Reviewed marks and notes:** kept in your browser only (not shared with other analysts). "Hide reviewed" clears finished items away.
- **Views panel:** Triage, Threat hunter and Manager overview starting points; save your own views (optionally with your panel layout); copy a link that reopens the same search and log order; export/import saved views as a file.
- Wall mode always shows the plain newest-first log, whatever an analyst set on the same browser.

### Analyst extras

- **Click to pivot.** In an event's details, click an address, alert name, category, protocol, system and so on to filter the whole screen to it. **Shift-click** adds it to the current search instead of replacing it.
- **Seen from this source before.** The details ask the server how many events it has seen from that address, since when, how many targets and alert types, and the top alerts, targets and ports. The server counts every event as it is published, so this does not depend on what the browser had open. Live history is saved to `backend/data/insights_live.json` (once a minute); demo data is kept in memory and cleared with the upload. **Keep `backend/data/` on a persistent volume** or the history restarts empty.
- **What this alert means.** Copy `backend/signatures.example.yaml` to `backend/signatures.yaml` and write a plain-English note (`what`, `action`, optional runbook `link`) per alert name (`match`, `*` allowed) or rule `id`. Every analyst sees it in the details; changes show up within a minute. The most specific match wins. The file is gitignored because it describes your network.
- **Shift summary** (Views panel > Reports). Totals, severity split, events per hour, top alert types, sources, targets and countries, and a "worth a look" list (top severity, unusual, or aimed at a key system) for the last 4, 8, 12 or 24 hours, with **Copy as text** and **Print**. It says plainly how far back the server has been counting, and whether it is live or demo data. Your own notes from the last hours are added from this browser. Muted (known-good) events are counted separately and left out of the tops.
- **Ticket and tool links.** In `backend/config.yaml`, `links:` adds buttons to the details, e.g. `url: "https://tickets.example.com/new?title={signature}&src={src_ip}"`. Placeholders are URL-encoded; http(s) only; `public_only: true` hides the link for private addresses. When `links:` is set, it replaces the built-in VirusTotal/AbuseIPDB buttons. See `config.example.yaml`.
- **Mute a signature** (optional). With `known_good.editable: true` and `known_good.allow_signature_mute: true`, the details get "Mute this signature…". It hides every alert with that name, from any source, for everyone, so it needs a written reason, shows a stronger warning, and is written to the same audit log. Entries appear in the Known-Good list and can be removed there.
- **Colour-blind-safe palette** (Views panel > Display). Swaps red/orange/yellow for magenta/amber/light yellow and gives each severity a shape (diamond, square, triangle) in the log, legend and on the map. Remembered in this browser; the page reloads when you switch.
- **Second monitor.** Views panel > "Log in a new window" opens `?view=console` (log, details and search only); "Map only in a new window" opens `?view=map` (no sidebar). Pinning an alert in one window pins it in the other. Only the pin is shared; search, filters and notes are per window. Both windows must be in the same browser.

## Unusualness score

Every event gets a 0-100 score for how unusual it is compared with what this network has seen before, with the reasons in plain words ("First time seen: source country Kazakhstan"). It shows as a purple number on log rows (40 and up), in the alert detail panel, on the spotlight card for very unusual alerts, and in search: `anomaly_score >= 70` or `anomaly:unusual` (the **Unusual** chip does the same).

It is frequency counting, not machine learning: the server keeps counts of countries, addresses, signatures, targets, ports and a few combinations, and the rarer an event's pieces are *for that kind of field*, the higher the score (`backend/app/anomaly.py` explains the arithmetic). A few things to know:

- **It starts out knowing nothing.** Scores are dimmed ("provisional") until 1000 events and 24 hours of history exist (`anomaly:` in `config.example.yaml`). The demo CSV feed learns in about a minute and starts over with each dataset.
- **The live feed's history is saved** in `backend/data/anomaly.db` (gitignored) so it survives restarts. In a container, mount `backend/data/` as a volume or the history resets on every redeploy.
- **Muted (known-good) events still count** toward the history, since it should reflect what really happens.
- **Rare is not the same as dangerous.** Read the score next to the severity.
- Country names come from the same offline outlines as the Countries tab (`backend/app/data/countries.json`, generated by `mapgen/gen-countries.js`).

## What's a stub vs. what's real here

This is a scaffold to build on, not a finished app:

- `elastic_source.py` is untested against a live cluster — the query shape,
  cursor logic, and field-mapping approach are all real, but expect to
  adjust field paths once you point it at your actual index.
- There's no throttling yet between a burst of events and the renderer —
  worth adding if your index turns out to be bursty (flagged during the
  original design discussion, never resolved).
- No auth/session handling — this is intentionally a single-user, local tool.
- Automated tests cover the search parser and mute logic (`npm test` in `frontend/`) and the known-good list (`python tests/test_known_good.py` in `backend/`); the rest has none yet.

## Repo layout

```
backend/     FastAPI app, ingestion sources, WebSocket broadcast
frontend/    Vite + TypeScript, Canvas 2D rendering
mapgen/      one-time script that generated frontend/src/world-path.ts
sample_data/ example CSV matching the required column schema
```
