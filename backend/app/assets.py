"""Maps IP addresses to named business systems.

Turns "203.0.113.7 hit 10.50.10.12" into "someone scanned the Payment API".
Defined in backend/assets.yaml (copy assets.example.yaml). That file
describes your real network layout, so it is gitignored; only the example is
committed.

    networks:
      - cidr: 10.50.10.0/24
        name: Payment API
        criticality: critical      # low | normal | high | critical (default normal)

The most specific (longest-prefix) range wins, so a /32 host entry can sit
inside a /16 site entry. The file is re-read automatically when it changes
(no restart), and a bad edit never blanks the directory: a file that fails
to parse is ignored, and individual bad entries are skipped, with the
problem reported in the server log and GET /api/status.
"""
from __future__ import annotations

import ipaddress
import time
from pathlib import Path
from typing import Any, Optional

import yaml

from .models import AssetRef, Direction, TrafficEvent

_CRITICALITIES = {"low", "normal", "high", "critical"}
_Net = ipaddress.IPv4Network | ipaddress.IPv6Network


class AssetDirectory:
    RELOAD_CHECK_SECONDS = 5.0
    MAX_CACHE = 50_000

    def __init__(self, path: Path) -> None:
        self._path = path
        self._nets: list[tuple[_Net, AssetRef]] = []
        self._mtime: Optional[float] = None
        self._next_check = 0.0
        self._cache: dict[str, Optional[AssetRef]] = {}
        self.error: Optional[str] = None
        self._load()

    @property
    def count(self) -> int:
        return len(self._nets)

    def info(self) -> dict[str, Any]:
        self._maybe_reload()  # so /api/status reflects the file's current state even when no traffic is flowing
        return {"loaded": self.count > 0, "count": self.count, "error": self.error}

    def lookup(self, ip: Optional[str]) -> Optional[AssetRef]:
        if not ip:
            return None
        self._maybe_reload()
        if ip in self._cache:
            return self._cache[ip]
        try:
            addr = ipaddress.ip_address(ip)
        except ValueError:
            return None
        found = next((ref for net, ref in self._nets if addr.version == net.version and addr in net), None)
        if len(self._cache) >= self.MAX_CACHE:
            self._cache.clear()
        self._cache[ip] = found
        return found

    def enrich(self, event: TrafficEvent) -> None:
        event.src_asset = self.lookup(event.src_ip)
        event.dst_asset = self.lookup(event.dst_ip)
        event.direction = direction(event.src_asset, event.dst_asset)

    # ---- loading ---------------------------------------------------------------
    def _maybe_reload(self) -> None:
        now = time.monotonic()
        if now < self._next_check:
            return
        self._next_check = now + self.RELOAD_CHECK_SECONDS
        try:
            mtime = self._path.stat().st_mtime if self._path.exists() else None
        except OSError:
            return
        if mtime != self._mtime:
            self._load()

    def _load(self) -> None:
        self._cache.clear()
        try:
            self._mtime = self._path.stat().st_mtime if self._path.exists() else None
        except OSError:
            self._mtime = None

        if self._mtime is None:
            self._nets, self.error = [], None  # no file = feature simply off
            return

        try:
            raw = yaml.safe_load(self._path.read_text(encoding="utf-8")) or {}
            entries = raw.get("networks", []) if isinstance(raw, dict) else None
            if not isinstance(entries, list):
                raise ValueError("expected a top-level 'networks:' list")
        except (yaml.YAMLError, ValueError, OSError) as exc:
            # Keep whatever loaded last time rather than wiping the names off a live wall.
            self.error = f"{self._path.name} was not loaded: {type(exc).__name__}"
            print(f"[assets] {self.error} ({exc})")
            return

        nets: list[tuple[_Net, AssetRef]] = []
        skipped = 0
        for i, entry in enumerate(entries, start=1):
            try:
                net = ipaddress.ip_network(str(entry["cidr"]).strip(), strict=False)
                name = str(entry["name"]).strip()
                if not name:
                    raise ValueError("empty name")
                crit = str(entry.get("criticality", "normal")).strip().lower()
                if crit not in _CRITICALITIES:
                    raise ValueError(f"criticality must be one of {sorted(_CRITICALITIES)}")
                nets.append((net, AssetRef(name=name, criticality=crit)))  # type: ignore[arg-type]
            except (KeyError, TypeError, ValueError, AttributeError) as exc:
                skipped += 1
                print(f"[assets] entry {i} skipped: {exc!r}")

        nets.sort(key=lambda pair: pair[0].prefixlen, reverse=True)  # most specific first
        self._nets = nets
        self.error = f"{skipped} entr{'y' if skipped == 1 else 'ies'} skipped (see server log)" if skipped else None


def direction(src: Optional[AssetRef], dst: Optional[AssetRef]) -> Optional[Direction]:
    if src and dst:
        return "internal"
    if dst:
        return "inbound"
    if src:
        return "outbound"
    return None


directory = AssetDirectory(Path(__file__).resolve().parent.parent / "assets.yaml")
