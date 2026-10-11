"""What this server has seen over time, for two analyst tools: a source's history and the shift summary.

  * Source history: for each source address, when it was first and last seen, how many events, and what
    it targeted and triggered. "Is this a one-off, or has it been at this for a week?"
  * Shift summary: per-hour totals, the top signatures / sources / targets / countries and the events
    worth a second look, for the last few hours. Built for handing a shift over.

Everything is counted server-side as events arrive, so it does not depend on which browser was open. The
live feed is saved to data/insights_live.json (about once a minute) and survives a restart; the demo feed
(an uploaded CSV) is kept in memory only and starts over with each dataset, like the anomaly history.

Bounded on purpose: the busiest sources, 72 hours, and a capped list of notable events, so memory and the
file stay small however long it runs. When a table is over its cap the rarest entries are dropped, so very
small counts can be approximate on a huge network. Events from muted sources / alert names are counted
separately and left out of the summary's tops, so it matches what the analysts were looking at.
"""
from __future__ import annotations

import json
import os
import time
from collections import OrderedDict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from .geo_country import country_at
from .models import TrafficEvent
from .severity import UNKNOWN_ID

MAX_SOURCES = 20_000
MAX_HOURS = 72
HOUR_TOP_CAP = 1_500          # distinct signatures / sources / targets / countries kept per hour
SOURCE_TOP_CAP = 40           # distinct signatures / targets kept per source
MAX_NOTABLE = 400
UNUSUAL_AT = 70
FLUSH_SECONDS = 60
SAVE_VERSION = 1


def _bump(d: dict[str, int], key: str, cap: int, by: int = 1) -> None:
    d[key] = d.get(key, 0) + by
    if len(d) > cap + cap // 4:  # over by a margin: drop the rarest, so this is not done on every event
        keep = sorted(d.items(), key=lambda kv: kv[1], reverse=True)[:cap]
        d.clear()
        d.update(keep)


def _top(d: dict[str, int], n: int) -> list[dict[str, Any]]:
    return [{"name": k, "n": v} for k, v in sorted(d.items(), key=lambda kv: (-kv[1], kv[0]))[:n]]


def _iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, timezone.utc).isoformat(timespec="seconds")


class _Hour:
    __slots__ = ("n", "muted", "unusual", "key_hits", "sev", "sigs", "srcs", "tgts", "ctry")

    def __init__(self) -> None:
        self.n = self.muted = self.unusual = self.key_hits = 0
        self.sev: dict[str, int] = {}
        self.sigs: dict[str, int] = {}
        self.srcs: dict[str, int] = {}
        self.tgts: dict[str, int] = {}
        self.ctry: dict[str, int] = {}

    def to_json(self) -> dict[str, Any]:
        return {k: getattr(self, k) for k in self.__slots__}

    @staticmethod
    def from_json(raw: dict[str, Any]) -> "_Hour":
        h = _Hour()
        for k in _Hour.__slots__:
            if k in raw:
                setattr(h, k, raw[k])
        return h


class Insights:
    def __init__(self, path: Optional[Path] = None, top_severity: str = "", key_severities: tuple[str, ...] = ()) -> None:
        self._path = path
        self._top = top_severity
        self._key_sev = key_severities
        self.error: Optional[str] = None
        self.reset()
        self._next_flush = time.monotonic() + FLUSH_SECONDS
        self._dirty = False
        if path is not None:
            self._load(path)

    def reset(self) -> None:
        self.started: Optional[float] = None
        self._sources: "OrderedDict[str, dict[str, Any]]" = OrderedDict()
        self._hours: dict[int, _Hour] = {}
        self._notable: "OrderedDict[str, dict[str, Any]]" = OrderedDict()
        self._dirty = True

    @property
    def total(self) -> int:
        return sum(h.n + h.muted for h in self._hours.values())

    # ---- counting ---------------------------------------------------------------------
    def observe(self, e: TrafficEvent, muted: bool) -> None:
        ts = e.timestamp.timestamp() if e.timestamp else time.time()
        if self.started is None or ts < self.started:
            self.started = ts
        self._dirty = True
        self._observe_source(e, ts)

        hour_key = int(ts // 3600)
        h = self._hours.get(hour_key)
        if h is None:
            h = self._hours[hour_key] = _Hour()
            for old in sorted(self._hours)[:-MAX_HOURS]:
                del self._hours[old]
        if muted:
            h.muted += 1
            return
        h.n += 1
        sev = e.severity or UNKNOWN_ID
        h.sev[sev] = h.sev.get(sev, 0) + 1
        sig = e.signature or "(no signature)"
        _bump(h.sigs, sig, HOUR_TOP_CAP)
        if e.src_ip:
            _bump(h.srcs, e.src_ip, HOUR_TOP_CAP)
        target = e.dst_asset.name if e.dst_asset else (e.dst_ip or "?")
        _bump(h.tgts, target, HOUR_TOP_CAP)
        outbound = e.direction == "outbound"
        country = country_at(e.dst_lat, e.dst_lon) if outbound else (
            None if (e.geo_note and "source location assumed" in e.geo_note) else country_at(e.src_lat, e.src_lon))
        if country:
            _bump(h.ctry, country, HOUR_TOP_CAP)
        score = e.anomaly.score if e.anomaly else 0
        if score >= UNUSUAL_AT:
            h.unusual += 1
        key_asset = bool(e.dst_asset and e.dst_asset.criticality in ("high", "critical"))
        if key_asset:
            h.key_hits += 1
        worth = sev == self._top or score >= UNUSUAL_AT or (key_asset and sev in self._key_sev)
        if worth:
            self._note(e, ts, sig, target, country, score)

    def _observe_source(self, e: TrafficEvent, ts: float) -> None:
        ip = e.src_ip
        if not ip:
            return
        rec = self._sources.get(ip)
        if rec is None:
            rec = self._sources[ip] = {"first": ts, "last": ts, "n": 0, "sigs": {}, "tgts": {}, "ports": {}, "sev": {}}
            while len(self._sources) > MAX_SOURCES:
                self._sources.popitem(last=False)  # the least recently seen goes first
        else:
            self._sources.move_to_end(ip)
        rec["first"] = min(rec["first"], ts)
        rec["last"] = max(rec["last"], ts)
        rec["n"] += 1
        _bump(rec["sigs"], e.signature or "(no signature)", SOURCE_TOP_CAP)
        _bump(rec["tgts"], e.dst_asset.name if e.dst_asset else (e.dst_ip or "?"), SOURCE_TOP_CAP)
        if e.dst_port is not None:
            _bump(rec["ports"], str(e.dst_port), SOURCE_TOP_CAP)
        sev = e.severity or UNKNOWN_ID
        rec["sev"][sev] = rec["sev"].get(sev, 0) + 1

    def _note(self, e: TrafficEvent, ts: float, sig: str, target: str, country: Optional[str], score: int) -> None:
        key = f"{e.src_ip}|{e.dst_ip}|{sig}"
        cur = self._notable.get(key)
        if cur is None:
            cur = self._notable[key] = {
                "key": key, "first": ts, "count": 0, "score": 0, "reasons": [],
                "signature": sig, "src_ip": e.src_ip, "dst_ip": e.dst_ip, "target": target, "country": country,
                "src_asset": e.src_asset.name if e.src_asset else None,
                "dst_asset": e.dst_asset.name if e.dst_asset else None,
                "dst_criticality": e.dst_asset.criticality if e.dst_asset else None,
                "direction": e.direction,
            }
            while len(self._notable) > MAX_NOTABLE:
                self._notable.popitem(last=False)
        else:
            self._notable.move_to_end(key)
        cur["last"] = ts
        cur["count"] += 1
        cur["severity"] = e.severity
        if score >= cur["score"] and e.anomaly:
            cur["score"] = score
            cur["reasons"] = list(e.anomaly.reasons[:2])
            cur["learning"] = e.anomaly.learning
        elif "learning" not in cur:
            cur["learning"] = False

    # ---- questions --------------------------------------------------------------------
    def source_history(self, ip: str) -> Optional[dict[str, Any]]:
        rec = self._sources.get(ip)
        if rec is None:
            return None
        return {
            "ip": ip, "first_seen": _iso(rec["first"]), "last_seen": _iso(rec["last"]), "events": rec["n"],
            "distinct_targets": len(rec["tgts"]), "distinct_signatures": len(rec["sigs"]),
            "top_signatures": _top(rec["sigs"], 5), "top_targets": _top(rec["tgts"], 5),
            "top_ports": _top(rec["ports"], 5), "severities": dict(rec["sev"]),
        }

    def summary(self, hours: int, severity_order: list[str], now: Optional[float] = None) -> dict[str, Any]:
        hours = max(1, min(int(hours), MAX_HOURS))
        now = now if now is not None else time.time()
        end_key = int(now // 3600)
        start_key = end_key - hours + 1
        start_ts = start_key * 3600
        merged = _Hour()
        timeline = []
        for k in range(start_key, end_key + 1):
            h = self._hours.get(k)
            timeline.append({"t": _iso(k * 3600), "n": h.n if h else 0, "by_sev": dict(h.sev) if h else {}})
            if not h:
                continue
            merged.n += h.n
            merged.muted += h.muted
            merged.unusual += h.unusual
            merged.key_hits += h.key_hits
            for src, dst in ((h.sev, merged.sev), (h.sigs, merged.sigs), (h.srcs, merged.srcs), (h.tgts, merged.tgts), (h.ctry, merged.ctry)):
                for name, n in src.items():
                    dst[name] = dst.get(name, 0) + n
        rank = {sid: i for i, sid in enumerate(severity_order)}
        notable = [n for n in self._notable.values() if n["last"] >= start_ts]
        notable.sort(key=lambda n: (rank.get(n["severity"], 99), -n["score"], -n["last"]))
        by_sev = [{"id": sid, "n": merged.sev.get(sid, 0)} for sid in severity_order]
        extra = sum(n for sid, n in merged.sev.items() if sid not in rank)
        if extra:
            by_sev.append({"id": UNKNOWN_ID, "n": extra})
        return {
            "from": _iso(start_ts), "to": _iso(now), "hours": hours,
            "data_since": _iso(self.started) if self.started else None,
            # True when this server has been counting since before the start of the window.
            "complete": self.started is not None and self.started <= start_ts,
            "events": merged.n, "muted": merged.muted, "unusual": merged.unusual, "key_asset_hits": merged.key_hits,
            "by_severity": by_sev, "timeline": timeline,
            "top": {"signatures": _top(merged.sigs, 10), "sources": _top(merged.srcs, 10),
                    "targets": _top(merged.tgts, 10), "countries": _top(merged.ctry, 10)},
            "notable": [{**n, "first": _iso(n["first"]), "last": _iso(n["last"])} for n in notable[:40]],
            "notable_total": len(notable),
        }

    # ---- saving -----------------------------------------------------------------------
    def flush_if_due(self, force: bool = False) -> None:
        if self._path is None or not self._dirty:
            return
        now = time.monotonic()
        if not force and now < self._next_flush:
            return
        self._next_flush = now + FLUSH_SECONDS
        data = {
            "version": SAVE_VERSION, "started": self.started,
            "sources": list(self._sources.items()),
            "hours": {str(k): h.to_json() for k, h in self._hours.items()},
            "notable": list(self._notable.values()),
        }
        try:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self._path.with_suffix(".tmp")
            tmp.write_text(json.dumps(data, separators=(",", ":")), encoding="utf-8")
            os.replace(tmp, self._path)  # atomic
            self._dirty = False
            self.error = None
        except OSError as exc:
            self.error = f"history not saved ({type(exc).__name__}); running in memory only"
            print(f"[insights] {self.error}: {exc}")

    def _load(self, path: Path) -> None:
        if not path.exists():
            return
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
            if raw.get("version") != SAVE_VERSION:
                raise ValueError("unknown save version")
            self.started = raw.get("started")
            self._sources = OrderedDict((ip, rec) for ip, rec in raw.get("sources", []))
            self._hours = {int(k): _Hour.from_json(v) for k, v in raw.get("hours", {}).items()}
            self._notable = OrderedDict((n["key"], n) for n in raw.get("notable", []))
            self._dirty = False
        except (OSError, ValueError, KeyError, TypeError, AttributeError) as exc:
            self.reset()
            self._dirty = False
            self.error = f"saved history was not loaded ({type(exc).__name__}); starting empty"
            print(f"[insights] {self.error}: {exc}")

    def info(self) -> dict[str, Any]:
        return {"events": self.total, "sources": len(self._sources), "since": _iso(self.started) if self.started else None,
                "saved": self._path is not None, "error": self.error}


# ---- the two stores the app uses (same split as anomaly.py) ----------------------------------
def _build() -> tuple[Insights, Insights]:
    from .settings import scale  # imported here: settings reads config, which must exist by now
    ids = scale.ids()
    top = ids[0] if ids else ""
    key_sev = tuple(ids[:2])
    path = Path(__file__).resolve().parent.parent / "data" / "insights_live.json"
    return Insights(path, top, key_sev), Insights(None, top, key_sev)


_live, _sim = _build()


def observe_event(e: TrafficEvent, muted: bool) -> None:
    """Called for every event as it is published. Never allowed to stop an event reaching the screen."""
    try:
        store = _live if e.source == "elastic" else _sim
        store.observe(e, muted)
        store.flush_if_due()
    except Exception as exc:
        print(f"[insights] failed: {type(exc).__name__}: {exc}")


def reset_simulated() -> None:
    _sim.reset()


def pick(source: str = "auto") -> tuple[str, Insights]:
    """`auto` = the live feed once it has produced anything, else the demo feed."""
    if source == "live" or (source == "auto" and _live.total > 0):
        return "live", _live
    return "simulated", _sim


def flush() -> None:
    _live.flush_if_due(force=True)


def info() -> dict[str, Any]:
    return {"live": _live.info(), "simulated": _sim.info()}
