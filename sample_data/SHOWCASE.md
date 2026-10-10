# Showcase demo

`showcase.csv` is built to show off Sightline's newer features with fake traffic (documentation IP ranges, invented signatures).

## Set up (about a minute)

From the repo root, in PowerShell:

```powershell
Copy-Item sample_data\showcase_known_good.yaml backend\known_good.yaml
Copy-Item backend\assets.example.yaml backend\assets.yaml     # skip if you already have an assets.yaml
```

Optional, so the threat level works right away instead of "LEARNING" for 15 minutes: add this on its own new lines at the bottom of `backend/config.yaml`, then restart the server.

```yaml
threat_level:
  elevated: 400
  high: 900
```

Start the server, open the page, click **Upload CSV**, and pick `sample_data/showcase.csv`.
Delete `backend/known_good.yaml` (and `assets.yaml` if you copied it just for this) afterwards.

## What to try

| Do this | You'll see |
|---|---|
| Open `/?kiosk=1` (or press **K**) | Wall layout: clock, threat level, big severity counts, rotating top talkers, events-per-minute strip |
| Wait about 30 s without touching anything | The tour: world, home, then the busiest source countries |
| Wait for a key-asset hit (every 20-40 s) | A spotlight card for a critical alert on Payment API, Plant Network or Public Web Server, with extra-large rings on the map |
| Slide **CSV feed intensity** up from 3 to 10 and wait a few minutes | The threat level climbs from NORMAL to ELEVATED to HIGH (needs the `threat_level` setting above; it averages the last 5 minutes, so it moves gradually) |
| Toggle **Mute known-good sources** | The Nessus scanner and monitoring probes disappear or reappear; the badge counts what's hidden |
| Click the **Countries** tab in Top Talkers | Share of traffic by source country |
| Click the chips under the search bar: **Critical**, **Key assets**, **Inbound**, **Blocked** | One-click filtering; chips combine with each other and with typed searches |
| Type `src_ip:198.51.100.0/24 and not action:blocked` | KQL-style search; `?` next to the bar lists the syntax |
| Click any arc or its endpoint | Pins that event and opens its details |
| In the detail panel, click **Copy as known-good entry** | A ready-to-paste line for `known_good.yaml` |
| Open **Replay & Export**, then **Play replay** | The last few minutes replay at 5-60x; **Export CSV** downloads them |
| Open **Alerts** and switch them on | A beep and desktop notification on each critical key-asset hit |
