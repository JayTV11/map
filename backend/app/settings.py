"""Scale and home-site settings from config.yaml, with safe defaults."""
from __future__ import annotations

import re
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


# ---- ticket / tool links ----------------------------------------------------------------------
LINK_PLACEHOLDERS = {"src_ip", "dst_ip", "src_port", "dst_port", "signature", "signature_id", "severity",
                     "category", "time", "src_asset", "dst_asset", "score"}
_PH = re.compile(r"\{([a-z_]+)\}")


def _load_links(raw: Any) -> list[dict[str, Any]]:
    """`links:` in config.yaml -> [{label, url, public_only}]. Bad entries are skipped with a reason."""
    if not raw:
        return []
    if not isinstance(raw, list):
        print("[settings] config.yaml links: must be a list, ignoring")
        return []
    out: list[dict[str, Any]] = []
    for i, item in enumerate(raw[:12]):
        try:
            label = str(item["label"]).strip()
            url = str(item["url"]).strip()
        except (TypeError, KeyError):
            print(f"[settings] config.yaml links[{i}]: needs label and url, skipped")
            continue
        if not label or len(label) > 40:
            print(f"[settings] config.yaml links[{i}]: label must be 1-40 characters, skipped")
            continue
        if not url.lower().startswith(("http://", "https://")):
            print(f"[settings] config.yaml links[{i}] ({label}): url must start with http:// or https://, skipped")
            continue
        unknown = sorted(set(_PH.findall(url)) - LINK_PLACEHOLDERS)
        if unknown:
            print(f"[settings] config.yaml links[{i}] ({label}): unknown placeholder {{{unknown[0]}}}, skipped")
            continue
        out.append({"label": label, "url": url, "public_only": bool(item.get("public_only", False))})
    if len(raw) > 12:
        print("[settings] config.yaml links: only the first 12 are used")
    return out


links: list[dict[str, Any]] = _load_links(config.get("links"))
