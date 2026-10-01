"""Turns the many ways logs spell a location into (lat, lon).

Handles: separate numbers, "lat,lon" strings, {"lat":..,"lon":..} objects
(also latitude/longitude/lng/long), Elastic/GeoJSON [lon, lat] arrays, and
"POINT(lon lat)". A location of exactly (0, 0) is treated as MISSING: it is
the default many tools write for "unknown" and would draw every such event
off the coast of Africa.
"""
from __future__ import annotations

import re
from typing import Any, Optional

_NUM = r"-?\d+(?:\.\d+)?"
_WKT = re.compile(rf"^\s*POINT\s*\(\s*({_NUM})\s+({_NUM})\s*\)\s*$", re.I)


def to_number(v: Any) -> Optional[float]:
    if isinstance(v, bool) or v is None:
        return None
    try:
        f = float(str(v).strip())
    except ValueError:
        return None
    return f if f == f and abs(f) != float("inf") else None


def valid(lat: Optional[float], lon: Optional[float]) -> bool:
    if lat is None or lon is None:
        return False
    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
        return False
    return not (lat == 0 and lon == 0)


def from_pair(lat: Any, lon: Any) -> Optional[tuple[float, float]]:
    a, b = to_number(lat), to_number(lon)
    return (a, b) if valid(a, b) else None  # type: ignore[return-value]


def parse_geo(value: Any) -> Optional[tuple[float, float]]:
    if value is None:
        return None
    if isinstance(value, dict):
        low = {str(k).casefold(): v for k, v in value.items()}
        lat = next((low[k] for k in ("lat", "latitude") if k in low), None)
        lon = next((low[k] for k in ("lon", "lng", "long", "longitude") if k in low), None)
        return from_pair(lat, lon)
    if isinstance(value, (list, tuple)):
        if len(value) != 2:
            return None
        a, b = to_number(value[0]), to_number(value[1])
        if a is None or b is None:
            return None
        # Elastic and GeoJSON arrays are [lon, lat]; only flip when the numbers can't be that.
        if abs(b) > 90 and abs(a) <= 90:
            return from_pair(a, b)
        return from_pair(b, a)
    if isinstance(value, str):
        m = _WKT.match(value)
        if m:
            return from_pair(m.group(2), m.group(1))
        parts = [p for p in re.split(r"[,;\s]+", value.strip()) if p]
        if len(parts) == 2:
            a, b = to_number(parts[0]), to_number(parts[1])
            if a is None or b is None:
                return None
            if abs(a) > 90 and abs(b) <= 90:
                return from_pair(b, a)  # written lon,lat
            return from_pair(a, b)      # "lat,lon" is the usual string order
    return None
