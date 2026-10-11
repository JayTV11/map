# Deploying Sightline

Three pieces: the container (this repo's `Dockerfile`), settings files you own, and NGINX with SSO in front.

## 1. Settings (not in GitHub, so create them on the server)

```
mkdir -p deploy/config
cp backend/config.yaml deploy/config/config.yaml                     # required, then edit
cp backend/assets.example.yaml     deploy/config/assets.yaml         # optional: name your systems, mark key ones
cp backend/known_good.example.yaml deploy/config/known_good.yaml     # optional: scanners to mute
cp backend/signatures.example.yaml deploy/config/signatures.yaml     # optional: "what this alert means" notes
printf 'ELASTIC_API_KEY=your-key-here\n' > deploy/.env               # only for the live feed
```

In `deploy/config/config.yaml`:

| Setting | Why |
|---|---|
| `elastic.hosts`, `elastic.index`, `elastic.field_mapping` | Leave `hosts: []` to run on uploaded CSVs only. For live data, the field mapping must match your index (send a sample alert and it can be checked). |
| `known_good.user_header` and `containment.user_header` | The header NGINX sets with the signed-in user (e.g. `X-Forwarded-User`). Needed so edits record who made them. |
| `known_good.editable`, `known_good.allow_signature_mute` | Let analysts mute sources / alert names from the screen. Off by default. |
| `links:` | Ticket / lookup buttons in an event's details. |

Files are re-read while the app runs (about every 5 seconds to a minute), except `config.yaml`, which needs a restart.

## 2. Run it

```
docker compose -f deploy/docker-compose.yml up -d --build
docker compose -f deploy/docker-compose.yml logs -f sightline
curl -s http://127.0.0.1:8000/api/status        # health, feed state, which files loaded
```

The named volume `sightline-data` holds saved state (anomaly history, source history and shift-summary data,
analyst-added mutes, response statuses, audit logs). **Back it up and do not delete it.** Without it, history
restarts empty on every container rebuild.

## 3. NGINX + SSO

Use `deploy/nginx-sightline.conf` as the starting point. The three things that matter:
the `/ws` block upgrades the connection (without it the map stays empty), `X-Forwarded-User` is set by NGINX
from the SSO result (never passed through from the browser), and port 8000 is reachable only from NGINX.

## Hosting it inside an existing web app (at /sightline/)

Sightline can sit under a path of a site you already run, so users stay on one domain and one SSO login.

1. Run the container exactly as in step 2 (it still listens on 127.0.0.1:8000 and still thinks it is at "/").
2. In the host app's NGINX `server { }` block, add the locations from `deploy/nginx-subpath.conf`. The trailing slash on
   `proxy_pass http://127.0.0.1:8000/;` is what strips `/sightline/`, so do not drop it.
3. Make sure `$sso_user` is set the same way the rest of that site sets it, and that `known_good.user_header` /
   `containment.user_header` in `config.yaml` names `X-Forwarded-User` (or whichever header you send).
4. Link to it from the host app: `<a href="/sightline/">Sightline</a>`. No rebuild is needed for a different prefix: the
   page works out where it is from its own URL, so `/sightline/`, `/soc/map/` and `/` all work with the same image.
5. Wall display: open `https://<host>/sightline/?kiosk=1`. Console window: `/sightline/?view=console`.

If the host app is not NGINX (Apache, IIS, a cloud load balancer), the rules are the same: forward the prefix with the
prefix removed, allow the WebSocket upgrade on `<prefix>/ws`, and overwrite the user header.

Checks: `https://<host>/sightline/api/status` returns JSON, and the browser's network tab shows
`wss://<host>/sightline/ws` with status 101.

## Checks after it is up

1. Open the site through NGINX: the map loads and the status chip says *Connected* (not "Connecting…").
2. `http://127.0.0.1:8000/api/status` on the server lists `assets`, `known_good`, `signature_notes` as loaded
   (if you provided those files) and `containment`, `insights` without errors.
3. As an analyst, set a response status on a source, then check
   `docker compose exec sightline tail -n1 /data/containment_audit.log`: the `user` field should be the SSO user,
   not `unknown (no user header configured)`.
4. Restart the container; the status should still be there.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Page loads, map stays empty / "Connecting…" | NGINX `/ws` block missing the `Upgrade` headers, or a proxy timeout. |
| 401 "Sign-in required" when muting or setting a status | `user_header` is configured but NGINX isn't sending that header. |
| 403 "must come from the Sightline page" | A proxy is stripping the custom `x-sightline-edit` request header. |
| History is empty after a restart | `/data` isn't a persistent volume. |
| "Elastic" feed shows an error banner | Wrong host/API key, or the field mapping doesn't match your index. |
| Edited `known_good.yaml` / `signatures.yaml` not picked up | File isn't in `deploy/config/`, or has a YAML error (see `/api/status` and the logs). |
