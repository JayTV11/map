"""How unusual is this event, judged by what this network has seen before?

Every event is compared with a running history of counts: how many events so far involved this
country, this address, this signature, this target, this port, and some combinations of them. The
rarer those are, the higher the score (0-100). It is plain frequency counting, not machine learning,
so every score can be explained in words ("first time seen: country Brazil") and shown with it.

    raw surprise              r = ln((n + 2) / (count + 1)) / ln(n + 2)       0 = very common, 1 = never seen
    relative surprise         s = (r - typical) / (1 - typical)               "typical" is half of how rare a normal value of that
                                                                              field already is (addresses are nearly all rare;
                                                                              ports mostly are not), so only rarer-than-usual counts
    contribution              weight * s^1.5                                  the power keeps common values quiet
    score                     100 * (1 - product(1 - contribution))           a few rare things add up

Combinations ("this source has never hit this target") only count for the part that is NOT already
explained by their pieces being new, so a brand-new address is not double-counted.

The history is kept per source: the Elastic feed's history is saved to a small SQLite file (so it
survives restarts and is shared by every screen); the simulated CSV feed's history lives in memory
and starts over each time a dataset is loaded. Events are counted AFTER they are scored, and muted
(known-good) events are still counted, because the history should reflect what really happens.

Until enough has been seen (min_events and min_hours), scores are flagged `learning` so the screen
can show them as provisional. Configure under `anomaly:` in config.yaml (see config.example.yaml).
"""
from __future__ import annotations

import math
import sqlite3
import time
from pathlib import Path
from typing import Any, Callable, Optional

from .geo_country import country_at
from .models import Anomaly, TrafficEvent

MAX_VALUES_PER_FEATURE = 200_000   # past this, new values are scored as unseen but no longer stored
FLUSH_SECONDS = 10.0
TYPICAL_DISCOUNT = 0.5         # how much of a field's "normal rarity" to forgive (1 = all of it)
SHARPNESS = 1.5                # contribution = weight * s ** SHARPNESS; above 1 keeps common values quiet
UNUSUAL_AT = 70
UNCOMMON_AT = 40


class _Feature:
    __slots__ = ("name", "weight", "value", "show", "residual_of")

    def __init__(self, name: str, weight: float, value: str, show: str, residual_of: tuple[str, ...] = ()) -> None:
        self.name = name
        self.weight = weight
        self.value = value
        self.show = show
        self.residual_of = residual_of


def _short(text: str, n: int = 60) -> str:
    return text if len(text) <= n else text[: n - 1] + "…"


def features_of(e: TrafficEvent) -> list[_Feature]:
    """The facts about an event that get compared with history. Missing facts are simply left out."""
    out: list[_Feature] = []
    # "Remote" is the outside party: the attacker for inbound traffic, the destination for outbound.
    outbound = e.direction == "outbound"
    internal = e.direction == "internal"
    remote_ip = e.dst_ip if outbound else e.src_ip
    our_ip = e.src_ip if outbound else e.dst_ip

    if not internal:
        if outbound:
            country = country_at(e.dst_lat, e.dst_lon)
            label = "destination country"
        elif e.geo_note and "source location assumed" in e.geo_note:
            country = None  # not a real location: it was filled in from the home site
            label = "source country"
        else:
            country = country_at(e.src_lat, e.src_lon)
            label = "source country"
        if country:
            out.append(_Feature("country", 0.55, country, f"{label} {country}"))
    if remote_ip and not internal:
        out.append(_Feature("remote_ip", 0.35, remote_ip, f"address {remote_ip}"))
    sig = e.signature_id or e.signature
    if sig:
        out.append(_Feature("signature", 0.50, sig, f"signature {_short(e.signature or sig)}"))
    if our_ip:
        label = e.dst_asset.name if (not outbound and e.dst_asset) else (e.src_asset.name if (outbound and e.src_asset) else our_ip)
        out.append(_Feature("target", 0.30, our_ip, f"target {label}"))
    if e.dst_port is not None:
        out.append(_Feature("port", 0.30, str(e.dst_port), f"port {e.dst_port}"))
    if remote_ip and our_ip and not internal:
        out.append(_Feature("pair", 0.40, f"{remote_ip}>{our_ip}", "this address hitting this target", ("remote_ip", "target")))
    if sig and our_ip:
        out.append(_Feature("sig_target", 0.45, f"{sig}@{our_ip}", "this signature against this target", ("signature", "target")))
    return out


class AnomalyScorer:
    def __init__(self, path: Optional[Path] = None, min_events: int = 1000, min_hours: float = 24.0,
                 clock: Callable[[], float] = time.time) -> None:
        self._counts: dict[str, dict[str, int]] = {}
        self._ent: dict[str, float] = {}    # per feature: sum of count*ln(count), for its typical rarity
        self._ftot: dict[str, int] = {}     # per feature: events counted
        self.total = 0
        self.first_ts: Optional[float] = None
        self._min_events = min_events
        self._min_hours = min_hours
        self._clock = clock
        self._path = path
        self._db: Optional[sqlite3.Connection] = None
        self._dirty: set[tuple[str, str]] = set()
        self._meta_dirty = False
        self._next_flush = 0.0
        self.error: Optional[str] = None
        if path is not None:
            self._open(path)

    # ---- scoring ---------------------------------------------------------------
    @property
    def learning(self) -> bool:
        if self.total < self._min_events:
            return True
        if self.first_ts is None:
            return True
        return (self._clock() - self.first_ts) < self._min_hours * 3600

    def _surprise(self, feature: str, value: str) -> tuple[float, int]:
        c = self._counts.get(feature, {}).get(value, 0)
        n = self._ftot.get(feature, 0)
        raw = math.log((n + 2) / (c + 1)) / math.log(n + 2)
        entropy = (math.log(n) - self._ent.get(feature, 0.0) / n) if n > 0 else 0.0
        typical = TYPICAL_DISCOUNT * min(0.95, max(0.0, entropy / math.log(n + 2)))
        return max(0.0, (raw - typical) / (1.0 - typical)), c

    def score(self, e: TrafficEvent) -> Anomaly:
        feats = features_of(e)
        n = self.total
        surprise = {f.name: self._surprise(f.name, f.value) for f in feats}
        parts: list[tuple[float, _Feature, int]] = []
        for f in feats:
            s, c = surprise[f.name]
            if f.residual_of:
                # only what the pieces do not already explain
                known = [surprise[p][0] for p in f.residual_of if p in surprise]
                if known:
                    s = max(0.0, s - max(known))
            parts.append((f.weight * s ** SHARPNESS, f, c))
        keep = 1.0
        for contribution, _, _ in parts:
            keep *= 1.0 - contribution
        score = round(100 * (1.0 - keep))
        level = "unusual" if score >= UNUSUAL_AT else "uncommon" if score >= UNCOMMON_AT else "usual"

        reasons: list[str] = []
        for contribution, f, c in sorted(parts, key=lambda p: -p[0])[:3]:
            if contribution < 0.12:
                break
            if f.residual_of:
                reasons.append(f"Never seen before: {f.show}" if c == 0 else f"Rarely seen: {f.show} ({c:,} of {n:,} events)")
            elif c == 0:
                reasons.append(f"First time seen: {f.show}")
            else:
                reasons.append(f"Rarely seen: {f.show} ({c:,} of {n:,} events)")
        if not reasons:
            reasons.append("Matches what this network normally sees")
        return Anomaly(score=score, level=level, reasons=reasons, learning=self.learning)

    def observe(self, e: TrafficEvent) -> None:
        if self.first_ts is None:
            self.first_ts = self._clock()
            self._meta_dirty = True
        self.total += 1
        self._meta_dirty = True
        for f in features_of(e):
            bucket = self._counts.setdefault(f.name, {})
            c = bucket.get(f.value, 0)
            if c == 0 and len(bucket) >= MAX_VALUES_PER_FEATURE:
                continue
            bucket[f.value] = c + 1
            self._ent[f.name] = self._ent.get(f.name, 0.0) + (c + 1) * math.log(c + 1) - (c * math.log(c) if c else 0.0)
            self._ftot[f.name] = self._ftot.get(f.name, 0) + 1
            self._dirty.add((f.name, f.value))

    def score_and_learn(self, e: TrafficEvent) -> Anomaly:
        result = self.score(e)   # before counting: a first-ever value must still read as new
        self.observe(e)
        self.flush_if_due()
        return result

    def reset(self) -> None:
        self._counts.clear()
        self._ent.clear()
        self._ftot.clear()
        self.total = 0
        self.first_ts = None
        self._dirty.clear()

    def info(self) -> dict[str, Any]:
        hours = 0.0 if self.first_ts is None else (self._clock() - self.first_ts) / 3600
        return {"events": self.total, "hours": round(hours, 1), "learning": self.learning,
                "min_events": self._min_events, "min_hours": self._min_hours,
                "saved": self._db is not None, "error": self.error}

    # ---- persistence -----------------------------------------------------------
    def _open(self, path: Path) -> None:
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            db = sqlite3.connect(str(path), check_same_thread=False)
            db.execute("CREATE TABLE IF NOT EXISTS counts (feature TEXT NOT NULL, value TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (feature, value))")
            db.execute("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value REAL)")
            for feature, value, n in db.execute("SELECT feature, value, n FROM counts"):
                self._counts.setdefault(feature, {})[value] = n
            meta = dict(db.execute("SELECT key, value FROM meta"))
            for feature, bucket in self._counts.items():
                self._ftot[feature] = sum(bucket.values())
                self._ent[feature] = sum(n * math.log(n) for n in bucket.values())
            self.total = int(meta.get("total", 0))
            self.first_ts = meta.get("first_ts")
            self._db = db
        except (sqlite3.Error, OSError) as exc:
            self.error = f"history not saved ({type(exc).__name__}); running in memory only"
            print(f"[anomaly] {self.error}: {exc}")
            self._db = None

    def flush_if_due(self, force: bool = False) -> None:
        if self._db is None:
            return
        now = time.monotonic()
        if not force and now < self._next_flush:
            return
        self._next_flush = now + FLUSH_SECONDS
        if not self._dirty and not self._meta_dirty:
            return
        try:
            rows = [(f, v, self._counts[f][v]) for f, v in self._dirty if v in self._counts.get(f, {})]
            self._db.executemany("INSERT INTO counts (feature, value, n) VALUES (?, ?, ?) ON CONFLICT(feature, value) DO UPDATE SET n = excluded.n", rows)
            self._db.execute("INSERT OR REPLACE INTO meta (key, value) VALUES ('total', ?)", (self.total,))
            if self.first_ts is not None:
                self._db.execute("INSERT OR REPLACE INTO meta (key, value) VALUES ('first_ts', ?)", (self.first_ts,))
            self._db.commit()
            self._dirty.clear()
            self._meta_dirty = False
            self.error = None
        except sqlite3.Error as exc:
            self.error = f"history not saved ({type(exc).__name__})"
            print(f"[anomaly] {self.error}: {exc}")


# ---- the two scorers the app uses ------------------------------------------------
def _settings() -> dict[str, Any]:
    from .config import config
    cfg = config.get("anomaly")
    return cfg if isinstance(cfg, dict) else {}


def _build() -> tuple[bool, AnomalyScorer, AnomalyScorer]:
    cfg = _settings()
    enabled = bool(cfg.get("enabled", True))
    path = Path(str(cfg.get("path", "data/anomaly.db")))
    if not path.is_absolute():
        path = Path(__file__).resolve().parent.parent / path
    live = AnomalyScorer(path if enabled else None,
                         min_events=int(cfg.get("min_events", 1000)),
                         min_hours=float(cfg.get("min_hours", 24)))
    # The demo feed starts over with every dataset, so it learns fast and is never saved.
    sim = AnomalyScorer(None, min_events=int(cfg.get("demo_min_events", 100)), min_hours=0)
    return enabled, live, sim


ENABLED, _live, _sim = _build()


def score_event(e: TrafficEvent) -> Optional[Anomaly]:
    if not ENABLED:
        return None
    try:
        return (_live if e.source == "elastic" else _sim).score_and_learn(e)
    except Exception as exc:  # scoring must never stop events from reaching the screen
        print(f"[anomaly] scoring failed: {type(exc).__name__}: {exc}")
        return None


def reset_simulated() -> None:
    _sim.reset()


def info() -> dict[str, Any]:
    return {"enabled": ENABLED, "live": _live.info(), "simulated": _sim.info()}
