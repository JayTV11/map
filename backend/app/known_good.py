"""The known-good source list: addresses whose traffic the map can mute.

Typical entries are your vulnerability scanners, monitoring probes, backup
servers and partner gateways -- sources that fire alerts all day and bury
the interesting ones. Defined in backend/known_good.yaml (copy
known_good.example.yaml). That file describes your real network, so it is
gitignored; only the example is committed.

    sources:
      - ip: 10.20.5.14              # a single address
        note: Nessus scanner
      - cidr: 10.20.9.0/24          # a whole range
        note: Monitoring probes
      - 192.0.2.77                  # a bare string works too

Like assets.yaml, the file is re-read automatically when it changes (no
restart), and a bad edit never blanks the list: a file that fails to parse
is ignored (the previous list stays in force) and individual bad entries are
skipped, with the problem reported in the server log and GET /api/status.

The browser does the actual muting (see frontend/src/knownGood.ts) and shows
how many events it muted -- this module only owns the list.
"""
from __future__ import annotations

import ipaddress
import time
from pathlib import Path
from typing import Any, Optional

import yaml

_Net = ipaddress.IPv4Network | ipaddress.IPv6Network


def _display(net: _Net) -> str:
    """A single host shows as a bare address, a range as CIDR."""
    return str(net.network_address) if net.prefixlen == net.max_prefixlen else str(net)


class KnownGoodList:
    RELOAD_CHECK_SECONDS = 5.0

    def __init__(self, path: Path) -> None:
        self._path = path
        self._entries: list[tuple[_Net, str]] = []
        self._mtime: Optional[float] = None
        self._next_check = 0.0
        self.error: Optional[str] = None
        self._load()

    @property
    def count(self) -> int:
        return len(self._entries)

    def entries(self) -> list[dict[str, str]]:
        self._maybe_reload()
        return [{"cidr": _display(net), "note": note} for net, note in self._entries]

    def info(self) -> dict[str, Any]:
        self._maybe_reload()  # so /api/status reflects the file's current state
        return {"loaded": self.count > 0, "count": self.count, "error": self.error}

    def matches(self, ip: Optional[str]) -> bool:
        if not ip:
            return False
        self._maybe_reload()
        try:
            addr = ipaddress.ip_address(ip.strip())
        except ValueError:
            return False
        return any(addr.version == net.version and addr in net for net, _ in self._entries)

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
        try:
            self._mtime = self._path.stat().st_mtime if self._path.exists() else None
        except OSError:
            self._mtime = None

        if self._mtime is None:
            self._entries, self.error = [], None  # no file = feature simply off
            return

        try:
            raw = yaml.safe_load(self._path.read_text(encoding="utf-8"))
            if raw is None:
                items: Any = []  # an empty file is a valid empty list
            elif isinstance(raw, list):
                items = raw  # tolerate a bare top-level list
            else:
                # A missing 'sources:' key (say, a typo) is an error, not "mute nothing".
                items = raw.get("sources") if isinstance(raw, dict) else None
            if not isinstance(items, list):
                raise ValueError("expected a top-level 'sources:' list")
        except (yaml.YAMLError, ValueError, OSError) as exc:
            # Keep whatever loaded last time rather than un-muting a live wall.
            self.error = f"{self._path.name} was not loaded: {type(exc).__name__}"
            print(f"[known_good] {self.error} ({exc})")
            return

        entries: list[tuple[_Net, str]] = []
        seen: set[str] = set()
        skipped = 0
        for i, item in enumerate(items, start=1):
            try:
                if isinstance(item, (str, int)):
                    spec, note = str(item), ""
                else:
                    spec = str(item.get("cidr") or item.get("ip") or "").strip()
                    note = str(item.get("note") or item.get("name") or "").strip()
                if not spec:
                    raise ValueError("needs an 'ip' or 'cidr'")
                net = ipaddress.ip_network(spec.strip(), strict=False)
                key = str(net)
                if key in seen:
                    continue  # harmless duplicate
                seen.add(key)
                entries.append((net, note[:120]))
            except (TypeError, ValueError, AttributeError) as exc:
                skipped += 1
                print(f"[known_good] entry {i} skipped: {exc!r}")

        self._entries = entries
        self.error = f"{skipped} entr{'y' if skipped == 1 else 'ies'} skipped (see server log)" if skipped else None


known_good = KnownGoodList(Path(__file__).resolve().parent.parent / "known_good.yaml")
