"""Scale and home-site settings from config.yaml, with safe defaults."""
from __future__ import annotations

from typing import Any

from .config import config
from .geo import valid
from .severity import SeverityScale, load_scale

DEFAULT_HOME = {"lat": 36.0104, "lon": -84.2696, "label": "Oak Ridge, TN"}


def _load_home(raw: Any) -> dict[str, Any]:
    try:
        lat, lon = float(raw["lat"]), float(raw["lon"])
        if valid(lat, lon):
            return {"lat": lat, "lon": lon, "label": str(raw.get("label") or "Home site")}
        print("[settings] config.yaml home: lat/lon out of range, using the default")
    except (TypeError, KeyError, ValueError):
        if raw:
            print("[settings] config.yaml home: needs lat and lon, using the default")
    return dict(DEFAULT_HOME)


def _load_threat(raw: Any) -> dict[str, float] | None:
    """Optional fixed thresholds for the wall's threat level (score per minute). Absent = the page learns its own baseline."""
    if raw is None:
        return None
    try:
        elevated, high = float(raw["elevated"]), float(raw["high"])
        if 0 < elevated < high:
            return {"elevated": elevated, "high": high}
        print("[settings] config.yaml threat_level: need 0 < elevated < high, so the level will be learned instead")
    except (TypeError, KeyError, ValueError):
        print("[settings] config.yaml threat_level: needs numeric elevated and high, so the level will be learned instead")
    return None


scale: SeverityScale = load_scale((config.get("severity") or {}).get("levels"))
home: dict[str, Any] = _load_home(config.get("home"))
threat_level: dict[str, float] | None = _load_threat(config.get("threat_level"))
