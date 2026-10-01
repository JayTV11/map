"""Turns any record into a TrafficEvent, and guesses which columns mean what.

`Mapping.columns` says, for each thing the map needs (source IP, destination
location, severity, ...), WHICH column of the data holds it. For CSV/JSON
uploads the guess comes from detect_mapping() and the user confirms it in the
upload dialog; for Elastic it comes from config.yaml's field_mapping. Both then
go through the same record_to_event(), so every source behaves alike.
"""
from __future__ import annotations

import ipaddress
import re
from datetime import datetime, timezone
from typing import Any, Optional

from pydantic import BaseModel, Field

from . import geo
from .models import TrafficEvent
from .severity import SeverityMapper

TARGETS = [
    "src_lat", "src_lon", "src_geo", "dst_lat", "dst_lon", "dst_geo",
    "src_ip", "dst_ip", "src_port", "dst_port",
    "severity", "signature", "signature_id", "category", "protocol", "action", "count", "timestamp",
]
MAX_EXTRA_FIELDS = 15
MAX_TEXT = 300


class Mapping(BaseModel):
    columns: dict[str, Optional[str]] = Field(default_factory=dict)
    severity_map: dict[str, str] = Field(default_factory=dict)   # raw value -> level id
    severity_preset: Optional[str] = None
    severity_default: str = "unknown"                            # for data with no severity column


def norm(name: str) -> str:
    return re.sub(r"[^a-z0-9]", "", name.casefold())


# Normalised column names (lowercase, letters+digits only) that usually mean each field, best first.
SYNONYMS: dict[str, list[str]] = {
    "src_lat": ["srclat", "srclatitude", "sourcelat", "sourcelatitude", "sourcegeolocationlat", "sourcegeolat", "sourcegeolatitude",
                "srcgeolat", "srcgeolatitude", "originlat", "originlatitude", "origlat", "fromlat", "fromlatitude", "clientlat",
                "attackerlat", "attackerlatitude", "geosrclat", "srcgeolocationlat"],
    "src_lon": ["srclon", "srclng", "srclong", "srclongitude", "sourcelon", "sourcelng", "sourcelong", "sourcelongitude",
                "sourcegeolocationlon", "sourcegeolon", "sourcegeolongitude", "srcgeolon", "srcgeolongitude", "originlon",
                "originlng", "originlongitude", "origlon", "fromlon", "fromlng", "fromlongitude", "clientlon", "attackerlon",
                "attackerlng", "attackerlongitude", "geosrclon", "srcgeolocationlon"],
    "src_geo": ["srcgeo", "sourcegeo", "srclocation", "sourcelocation", "sourcegeolocation", "srccoordinates", "sourcecoordinates",
                "srcloc", "srclatlon", "srclatlng", "sourcelatlon", "srcgeolocation", "origingeo", "attackergeo", "attackerlocation"],
    "dst_lat": ["dstlat", "dstlatitude", "destlat", "destlatitude", "destinationlat", "destinationlatitude", "destinationgeolocationlat",
                "destgeolat", "destinationgeolat", "destinationgeolatitude", "dstgeolat", "dstgeolatitude", "targetlat",
                "targetlatitude", "victimlat", "tolat", "tolatitude", "serverlat", "geodstlat", "dstgeolocationlat"],
    "dst_lon": ["dstlon", "dstlng", "dstlong", "dstlongitude", "destlon", "destlng", "destlong", "destlongitude", "destinationlon",
                "destinationlng", "destinationlong", "destinationlongitude", "destinationgeolocationlon", "destgeolon",
                "destinationgeolon", "destinationgeolongitude", "dstgeolon", "dstgeolongitude", "targetlon", "targetlng",
                "targetlongitude", "victimlon", "tolon", "tolng", "tolongitude", "serverlon", "geodstlon", "dstgeolocationlon"],
    "dst_geo": ["dstgeo", "destgeo", "destinationgeo", "dstlocation", "destlocation", "destinationlocation", "destinationgeolocation",
                "dstcoordinates", "destinationcoordinates", "dstloc", "dstlatlon", "dstlatlng", "destinationlatlon", "dstgeolocation",
                "targetgeo", "targetlocation", "victimgeo", "victimlocation"],
    "src_ip": ["srcip", "sourceip", "srcaddr", "srcaddress", "sourceaddress", "saddr", "ipsrc", "clientip", "origh", "idorigh",
               "attackerip", "sourcehost", "remoteip", "sourceipaddress", "srcipaddress", "src", "source", "sourceiplocal",
               "ip", "ipaddress", "ipaddr", "remoteaddr", "remotehost", "clientaddr"],  # bare "ip" is last: only if nothing more specific exists
    "dst_ip": ["dstip", "destip", "destinationip", "dstaddr", "dstaddress", "destaddr", "destinationaddress", "daddr", "ipdst",
               "serverip", "resph", "idresph", "targetip", "victimip", "desthost", "destinationipaddress", "dstipaddress",
               "dst", "dest", "destination", "target"],
    "src_port": ["srcport", "sourceport", "sport", "idorigp", "clientport", "origp", "sourceportnumber", "srcprt"],
    "dst_port": ["dstport", "destport", "destinationport", "dport", "idrespp", "serverport", "respp", "targetport", "dstprt",
                 "destinationportnumber", "port"],
    "severity": ["severity", "alertseverity", "eventseverity", "ruleseverity", "severitylevel", "sev", "priority", "alertpriority",
                 "level", "risk", "riskscore", "threatlevel", "urgency", "criticality", "cvss", "cvssscore", "score", "rulelevel"],
    "signature": ["signature", "alertsignature", "rulename", "alertname", "title", "alertmessage", "message", "msg", "threatname",
                  "threat", "attacktype", "eventname", "detectionname", "detection", "description", "rule", "alert", "name"],
    "signature_id": ["sid", "signatureid", "ruleid", "alertsignatureid", "alertid", "detectionid", "signaturesid", "eventid"],
    "category": ["category", "alertcategory", "rulecategory", "eventcategory", "classification", "attackcategory", "alertclass",
                 "threatcategory", "tactic", "alerttype", "eventtype", "class", "type"],
    "protocol": ["proto", "protocol", "networktransport", "transport", "ipprotocol", "l4proto", "networkprotocol", "appproto"],
    "action": ["action", "eventaction", "alertaction", "firewallaction", "disposition", "verdict", "outcome", "decision", "result"],
    "count": ["count", "hits", "eventcount", "numevents", "occurrences", "events", "total", "weight", "frequency", "times"],
    "timestamp": ["timestamp", "eventtime", "datetime", "time", "ts", "date", "createdat", "starttime", "logtime", "timegenerated", "utctime"],
}

# Second pass for compound names the exact list can't anticipate ("RiskLevel",
# "alert_severity_score", "fw_action"): a column whose name CONTAINS a telltale word.
CONTAINS: dict[str, list[str]] = {
    "severity": ["severity", "priority", "risk", "urgency", "criticality"],
    "signature": ["signature", "rulename", "alertname", "threatname"],
    "category": ["category"],
    "protocol": ["protocol"],
    "action": ["action", "verdict", "disposition"],
    "count": ["count"],
}

# A lone lat/lon pair (no source/destination in the name) is taken to be the SOURCE; the destination then defaults to home.
LONE_LAT = ["lat", "latitude", "geolat", "geolatitude", "locationlat", "locationlatitude"]
LONE_LON = ["lon", "lng", "long", "longitude", "geolon", "geolng", "geolongitude", "locationlon", "locationlongitude"]
LONE_GEO = ["geo", "geoip", "location", "geolocation", "coordinates", "latlon", "latlng", "geopoint", "geoiplocation"]


def _is_ip(v: Any) -> bool:
    try:
        ipaddress.ip_address(str(v).strip())
        return True
    except ValueError:
        return False


def _non_empty(rows: list[dict[str, Any]], col: str) -> list[Any]:
    return [r[col] for r in rows if col in r and r[col] not in (None, "")]


def _share(values: list[Any], pred) -> float:
    return sum(1 for v in values if pred(v)) / len(values) if values else 0.0


# What each target's sample values have to look like for a column to be believed.
CHECKS = {
    "src_ip": lambda v: _is_ip(v), "dst_ip": lambda v: _is_ip(v),
    "src_lat": lambda v: geo.to_number(v) is not None and abs(geo.to_number(v)) <= 90,
    "dst_lat": lambda v: geo.to_number(v) is not None and abs(geo.to_number(v)) <= 90,
    "src_lon": lambda v: geo.to_number(v) is not None and abs(geo.to_number(v)) <= 180,
    "dst_lon": lambda v: geo.to_number(v) is not None and abs(geo.to_number(v)) <= 180,
    "src_geo": lambda v: geo.parse_geo(v) is not None, "dst_geo": lambda v: geo.parse_geo(v) is not None,
    "src_port": lambda v: geo.to_number(v) is not None and 0 <= geo.to_number(v) <= 65535,
    "dst_port": lambda v: geo.to_number(v) is not None and 0 <= geo.to_number(v) <= 65535,
    "count": lambda v: geo.to_number(v) is not None and geo.to_number(v) >= 0,
}


def detect_mapping(columns: list[str], sample: list[dict[str, Any]]) -> dict[str, Optional[str]]:
    """Guesses target -> column from the column names, believing a guess only
    if the sample values actually look right (an 'ip' column of hostnames, or
    a 'location' column of city names, is rejected)."""
    by_norm: dict[str, str] = {}
    for c in columns:
        by_norm.setdefault(norm(c), c)

    used: set[str] = set()
    found: dict[str, Optional[str]] = {t: None for t in TARGETS}

    def pick(target: str, names: list[str]) -> Optional[str]:
        for n in names:
            col = by_norm.get(n)
            if col is None or col in used:
                continue
            vals = _non_empty(sample, col)
            check = CHECKS.get(target)
            if check and (not vals or _share(vals, check) < 0.6):
                continue
            used.add(col)
            return col
        return None

    for t in TARGETS:
        found[t] = pick(t, SYNONYMS[t])

    for t, words in CONTAINS.items():
        if found[t] is None:
            names = [n for n in by_norm if any(w in n for w in words)]
            found[t] = pick(t, names)

    # One location for the whole record: treat it as the source.
    if not (found["src_lat"] and found["src_lon"]) and not found["src_geo"]:
        lat, lon = pick("src_lat", LONE_LAT), pick("src_lon", LONE_LON)
        if lat and lon:
            found["src_lat"], found["src_lon"] = lat, lon
        else:
            if lat: used.discard(lat)
            if lon: used.discard(lon)
            found["src_geo"] = pick("src_geo", LONE_GEO)

    # A lat without its lon (or vice versa) can't place anything.
    for side in ("src", "dst"):
        if bool(found[f"{side}_lat"]) != bool(found[f"{side}_lon"]):
            found[f"{side}_lat"] = found[f"{side}_lon"] = None
    return found


# ---------------------------------------------------------------------------

def _text(v: Any) -> Optional[str]:
    if v is None:
        return None
    s = str(v).strip()
    return s[:MAX_TEXT] if s else None


def _port(v: Any) -> Optional[int]:
    n = geo.to_number(v)
    return int(n) if n is not None and 0 <= n <= 65535 else None


def parse_time(v: Any) -> Optional[datetime]:
    if v in (None, ""):
        return None
    n = geo.to_number(v)
    if n is not None:  # epoch seconds, or milliseconds
        try:
            return datetime.fromtimestamp(n / 1000 if n > 1e11 else n, tz=timezone.utc)
        except (OverflowError, OSError, ValueError):
            return None
    try:
        dt = datetime.fromisoformat(str(v).strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _side(rec: dict[str, Any], cols: dict[str, Optional[str]], side: str):
    lat_c, lon_c, geo_c = cols.get(f"{side}_lat"), cols.get(f"{side}_lon"), cols.get(f"{side}_geo")
    if lat_c and lon_c:
        pt = geo.from_pair(rec.get(lat_c), rec.get(lon_c))
        if pt:
            return pt
    if geo_c:
        return geo.parse_geo(rec.get(geo_c))
    return None


def record_to_event(
    rec: dict[str, Any],
    columns: dict[str, Optional[str]],
    sev: SeverityMapper,
    home: dict[str, Any],
    source: str,
    timestamp: Optional[datetime] = None,
) -> tuple[Optional[TrafficEvent], Optional[str]]:
    """Returns (event, None), or (None, reason) when the record can't go on the map."""
    src, dst = _side(rec, columns, "src"), _side(rec, columns, "dst")
    if src is None and dst is None:
        return None, "no_geo"

    notes = []
    label = home.get("label") or "home site"
    if src is None:
        src = (home["lat"], home["lon"])
        notes.append(f"source location assumed: {label} (no location in the data)")
    if dst is None:
        dst = (home["lat"], home["lon"])
        notes.append(f"destination location assumed: {label} (no location in the data)")

    def get(key: str) -> Any:
        c = columns.get(key)
        return rec.get(c) if c else None

    count = geo.to_number(get("count"))
    ts = parse_time(get("timestamp")) or timestamp
    mapped = {c for c in columns.values() if c}
    extra: dict[str, str] = {}
    for k, v in rec.items():
        if len(extra) >= MAX_EXTRA_FIELDS:
            break
        if k in mapped or v in (None, "") or isinstance(v, (list, dict)) and not v:
            continue
        extra[k] = str(v)[:160]

    kwargs: dict[str, Any] = dict(
        src_lat=src[0], src_lon=src[1], dst_lat=dst[0], dst_lon=dst[1],
        severity=sev.normalize(get("severity")),
        count=max(1, int(count)) if count is not None else 1,
        src_ip=_text(get("src_ip")), dst_ip=_text(get("dst_ip")),
        signature=_text(get("signature")), signature_id=_text(get("signature_id")),
        category=_text(get("category")), protocol=_text(get("protocol")),
        src_port=_port(get("src_port")), dst_port=_port(get("dst_port")),
        action=_text(get("action")), extra=extra,
        geo_note="; ".join(notes) or None, source=source,
    )
    if ts is not None:
        kwargs["timestamp"] = ts
    return TrafficEvent(**kwargs), None
