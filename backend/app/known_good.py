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

Analysts can also add and remove sources from the screen, if an admin turns that on (config.yaml,
`known_good: editable: true`). Those entries are kept in a SEPARATE file (data/known_good_added.json), so
your hand-edited known_good.yaml and its comments are never rewritten, and the screen can only remove
what the screen added. Every change is appended to data/known_good_audit.log with who did it.

The browser does the actual muting (see frontend/src/knownGood.ts) and shows
how many events it muted -- this module only owns the list.
"""
from __future__ import annotations

import ipaddress
import json
import os
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

import yaml

from .config import config

_Net = ipaddress.IPv4Network | ipaddress.IPv6Network


def _display(net: _Net) -> str:
    """A single host shows as a bare address, a range as CIDR."""
    return str(net.network_address) if net.prefixlen == net.max_prefixlen else str(net)


MAX_ADDED = 500
MAX_NOTE = 120


class EditRefused(ValueError):
    """An edit that was understood but not allowed; the message is safe to show to the analyst."""


def _kg_settings() -> dict[str, Any]:
    raw = config.get("known_good")
    raw = raw if isinstance(raw, dict) else {}
    return {
        "editable": raw.get("editable") is True,
        "user_header": str(raw.get("user_header") or "").strip(),
        # Widest range an analyst may mute in one go. Wider ones need the YAML file (an admin).
        "min_prefix_v4": int(raw.get("min_prefix_v4", 16)),
        "min_prefix_v6": int(raw.get("min_prefix_v6", 48)),
    }


class KnownGoodList:
    RELOAD_CHECK_SECONDS = 5.0

    def __init__(self, path: Path, added_path: Optional[Path] = None, audit_path: Optional[Path] = None) -> None:
        self._path = path
        self._added_path = added_path
        self._audit_path = audit_path
        self._added: list[dict[str, Any]] = []  # {net, note, added_by, added_at}
        self._load_added()
        self._entries: list[tuple[_Net, str]] = []
        self._mtime: Optional[float] = None
        self._next_check = 0.0
        self.error: Optional[str] = None
        self._load()

    @property
    def count(self) -> int:
        return len(self._entries) + len(self._added)

    def entries(self) -> list[dict[str, str]]:
        self._maybe_reload()
        out: list[dict[str, str]] = [{"cidr": _display(net), "note": note, "source": "file"} for net, note in self._entries]
        out += [
            {"cidr": _display(a["net"]), "note": a["note"], "source": "analyst", "added_by": a["added_by"], "added_at": a["added_at"]}
            for a in self._added
        ]
        return out

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
        if any(addr.version == net.version and addr in net for net, _ in self._entries):
            return True
        return any(addr.version == a["net"].version and addr in a["net"] for a in self._added)

    # ---- edits from the screen --------------------------------------------------------
    def add(self, spec: str, note: str, user: str) -> dict[str, str]:
        """Adds a source or range. Raises EditRefused with a plain-English reason when it isn't allowed."""
        cfg = _kg_settings()
        try:
            net = ipaddress.ip_network(str(spec).strip(), strict=False)
        except ValueError:
            raise EditRefused("That is not a valid IP address or range (like 203.0.113.5 or 10.20.9.0/24).") from None
        if net.is_unspecified or net.is_loopback or net.is_multicast:
            raise EditRefused("That address can't be muted.")
        floor = cfg["min_prefix_v4"] if net.version == 4 else cfg["min_prefix_v6"]
        if net.prefixlen < floor:
            raise EditRefused(
                f"That range is too wide to mute from the screen (nothing wider than /{floor}). "
                "An admin can add wider ranges in known_good.yaml."
            )
        self._maybe_reload()
        key = str(net)
        if any(str(n) == key for n, _ in self._entries) or any(str(a["net"]) == key for a in self._added):
            raise EditRefused("That source is already on the list.")
        if len(self._added) >= MAX_ADDED:
            raise EditRefused(f"The screen-added list is full ({MAX_ADDED}). Ask an admin to tidy it.")
        entry = {
            "net": net,
            "note": " ".join(str(note or "").split())[:MAX_NOTE],
            "added_by": user,
            "added_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        }
        self._added.append(entry)
        self._save_added()
        self._audit("add", net, entry["note"], user)
        return {"cidr": _display(net), "note": entry["note"]}

    def remove(self, spec: str, user: str) -> None:
        try:
            net = ipaddress.ip_network(str(spec).strip(), strict=False)
        except ValueError:
            raise EditRefused("That is not a valid IP address or range.") from None
        key = str(net)
        for i, a in enumerate(self._added):
            if str(a["net"]) == key:
                del self._added[i]
                self._save_added()
                self._audit("remove", net, a["note"], user)
                return
        if any(str(n) == key for n, _ in self._entries):
            raise EditRefused("That entry comes from known_good.yaml. Ask an admin to remove it there.")
        raise EditRefused("That source is not on the list.")

    def _load_added(self) -> None:
        self._added = []
        if self._added_path is None or not self._added_path.exists():
            return
        try:
            raw = json.loads(self._added_path.read_text(encoding="utf-8"))
            for item in (raw.get("entries") if isinstance(raw, dict) else None) or []:
                self._added.append({
                    "net": ipaddress.ip_network(str(item["cidr"]), strict=False),
                    "note": str(item.get("note") or "")[:MAX_NOTE],
                    "added_by": str(item.get("added_by") or "unknown"),
                    "added_at": str(item.get("added_at") or ""),
                })
        except (OSError, ValueError, KeyError, TypeError, AttributeError) as exc:
            print(f"[known_good] {self._added_path.name} was not loaded: {exc!r}")  # never blocks the yaml list

    def _save_added(self) -> None:
        if self._added_path is None:
            return
        data = {"entries": [
            {"cidr": _display(a["net"]), "note": a["note"], "added_by": a["added_by"], "added_at": a["added_at"]} for a in self._added
        ]}
        try:
            self._added_path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self._added_path.with_suffix(".tmp")
            tmp.write_text(json.dumps(data, indent=2), encoding="utf-8")
            os.replace(tmp, self._added_path)  # atomic: a crash can't leave half a file
        except OSError as exc:
            raise EditRefused(f"The change could not be saved on the server ({type(exc).__name__}). Is the data folder writable?") from exc

    def _audit(self, action: str, net: _Net, note: str, user: str) -> None:
        line = {"ts": datetime.now(timezone.utc).isoformat(timespec="seconds"), "action": action, "cidr": _display(net), "note": note, "user": user}
        print(f"[known_good] {action} {line['cidr']} by {user}")
        if self._audit_path is None:
            return
        try:
            self._audit_path.parent.mkdir(parents=True, exist_ok=True)
            with self._audit_path.open("a", encoding="utf-8") as f:
                f.write(json.dumps(line) + "\n")
        except OSError as exc:
            print(f"[known_good] audit log not written: {exc!r}")

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


_BACKEND = Path(__file__).resolve().parent.parent
known_good = KnownGoodList(
    _BACKEND / "known_good.yaml",
    added_path=_BACKEND / "data" / "known_good_added.json",
    audit_path=_BACKEND / "data" / "known_good_audit.log",
)
