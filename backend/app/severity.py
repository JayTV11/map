"""Configurable severity scale and the rules that map raw values onto it.

Different data uses different severity vocabularies: words (high/medium/low),
numbers where 1 is worst (Suricata, many IDS), numbers where 5 is worst,
CVSS 0-10, syslog 0-7 ... The app shows YOUR scale (any number of levels,
your names and colours; config.yaml `severity.levels`) and maps raw values
onto it.

Numbers are the dangerous case: "3" means "mild" in one dataset and "severe"
in another, so the code never guesses a direction. A numeric column is only
mapped when a preset or an explicit mapping says which way it runs, and
anything unmapped shows as Unknown rather than as a wrong colour.
"""
from __future__ import annotations

from typing import Any, Callable, Optional

from pydantic import BaseModel

UNKNOWN_ID = "unknown"
UNKNOWN = {"id": UNKNOWN_ID, "label": "Unknown", "color": "#4f8cff"}

DEFAULT_LEVELS = [
    {"id": "critical", "label": "Critical", "color": "#ff3868"},
    {"id": "major", "label": "Major", "color": "#ff9f2e"},
    {"id": "high", "label": "High", "color": "#ffe066"},
]


class Level(BaseModel):
    id: str
    label: str
    color: str


# Severity "classes", 0 = most severe .. 3 = least. Word lists and banded
# presets speak in classes; class_index() decides which of YOUR levels each
# class lands on, so the same word or preset works whether you have 3 levels or 6.
CLASS_WORDS: dict[int, set[str]] = {
    0: {"critical", "crit", "fatal", "emergency", "emerg", "urgent", "severe", "catastrophic"},
    1: {"high", "major", "error", "err", "important", "serious"},
    2: {"medium", "moderate", "warning", "warn", "med", "mid"},
    3: {"low", "minor", "info", "informational", "notice", "debug", "trivial"},
}
WORD_CLASS = {w: k for k, words in CLASS_WORDS.items() for w in words}


def class_index(k: int, n: int) -> int:
    """Index (0 = most severe) of the level a severity class lands on, for a scale of n levels."""
    if n <= 1:
        return 0
    if n == 2:
        return 0 if k <= 1 else 1
    if n == 3:
        return (0, 1, 1, 2)[k]
    return (0, 1, n // 2, n - 1)[k]


def _even(f: float, n: int) -> int:
    """f = 0 (worst) .. 1 (mildest), spread evenly over n levels."""
    return int(f * (n - 1) + 0.5)  # round half UP (Python's round() goes to even: 0.5 -> 0 but 1.5 -> 2)


def _suricata(v: float, n: int) -> Optional[int]:       # 1 = most severe, 3 = least
    return class_index({1: 0, 2: 1, 3: 3}[int(v)], n) if v == int(v) and int(v) in (1, 2, 3) else None


def _syslog(v: float, n: int) -> Optional[int]:         # 0 = emergency .. 7 = debug
    if not (0 <= v <= 7 and v == int(v)):
        return None
    return class_index(0 if v <= 2 else 1 if v == 3 else 2 if v <= 5 else 3, n)


def _cvss(v: float, n: int) -> Optional[int]:           # 0-10, 10 = worst
    if not 0 <= v <= 10:
        return None
    return class_index(0 if v >= 9 else 1 if v >= 7 else 2 if v >= 4 else 3, n)


def _one_to_five(v: float, n: int) -> Optional[int]:    # 5 = worst
    return _even((5 - int(v)) / 4, n) if v == int(v) and 1 <= v <= 5 else None


def _one_to_five_reversed(v: float, n: int) -> Optional[int]:  # 1 = worst
    return _even((int(v) - 1) / 4, n) if v == int(v) and 1 <= v <= 5 else None


PRESETS: dict[str, tuple[str, Callable[[float, int], Optional[int]]]] = {
    "suricata": ("Suricata / IDS: 1 = most severe, 3 = least", _suricata),
    "one_to_five": ("1-5 where 5 = most severe", _one_to_five),
    "one_to_five_reversed": ("1-5 where 1 = most severe", _one_to_five_reversed),
    "cvss": ("CVSS score 0-10 (10 = worst)", _cvss),
    "syslog": ("Syslog 0-7 (0 = emergency)", _syslog),
}


def to_float(raw: Any) -> Optional[float]:
    try:
        return float(str(raw).strip())
    except (TypeError, ValueError):
        return None


class SeverityScale:
    def __init__(self, levels: list[Level]) -> None:
        self.levels = levels  # highest severity first

    def ids(self) -> list[str]:
        return [lv.id for lv in self.levels]

    def match_level(self, text: str) -> Optional[str]:
        """Exact (case-insensitive) match on a level's id or label."""
        t = text.strip().casefold()
        for lv in self.levels:
            if t in (lv.id.casefold(), lv.label.casefold()):
                return lv.id
        return None

    def level_at(self, index: int) -> str:
        return self.levels[max(0, min(index, len(self.levels) - 1))].id

    def class_to_level(self, k: int) -> str:
        return self.level_at(class_index(k, len(self.levels)))

    def public(self) -> dict[str, Any]:
        return {"levels": [lv.model_dump() for lv in self.levels], "unknown": UNKNOWN}


def load_scale(raw_levels: Any) -> SeverityScale:
    """Builds the scale from config.yaml, falling back to the default (and
    saying so) rather than refusing to start on a typo."""
    try:
        if raw_levels:
            levels = [Level(**{k: str(v).strip() for k, v in lv.items()}) for lv in raw_levels]
            ids = [lv.id.casefold() for lv in levels]
            if not 1 <= len(levels) <= 8:
                raise ValueError("severity.levels needs between 1 and 8 levels")
            if len(set(ids)) != len(ids) or UNKNOWN_ID in ids:
                raise ValueError("level ids must be unique, and 'unknown' is reserved")
            if any(not lv.color.startswith("#") for lv in levels):
                raise ValueError("colors must be hex like #ff3868")
            return SeverityScale(levels)
    except (TypeError, ValueError, AttributeError) as exc:
        print(f"[severity] config.yaml severity.levels ignored, using the default scale: {exc}")
    return SeverityScale([Level(**lv) for lv in DEFAULT_LEVELS])


class SeverityMapper:
    """Raw value -> level id. Order: explicit map, exact level name, numeric
    preset, severity words, otherwise `default` (Unknown)."""

    def __init__(self, scale: SeverityScale, explicit: Optional[dict[str, str]] = None,
                 preset: Optional[str] = None, default: str = UNKNOWN_ID) -> None:
        self.scale = scale
        valid = set(scale.ids()) | {UNKNOWN_ID}
        self._explicit = {str(k).strip().casefold(): v for k, v in (explicit or {}).items() if v in valid}
        self._preset = PRESETS[preset][1] if preset in PRESETS else None
        self.default = default if default in valid else UNKNOWN_ID

    def normalize(self, raw: Any) -> str:
        if raw is None:
            return self.default
        text = str(raw).strip()
        if not text:
            return self.default
        key = text.casefold()
        if key in self._explicit:
            return self._explicit[key]
        level = self.scale.match_level(key)
        if level:
            return level
        num = to_float(text)
        if num is not None:
            if self._preset:
                idx = self._preset(num, len(self.scale.levels))
                if idx is not None:
                    return self.scale.level_at(idx)
            return UNKNOWN_ID  # a bare number with no stated direction is never guessed
        k = WORD_CLASS.get(key)
        return self.scale.class_to_level(k) if k is not None else UNKNOWN_ID

    def suggest(self, values: list[str]) -> dict[str, str]:
        """Best guess per distinct raw value, for the user to confirm.

        If EVERY value is one of the scale's own level names, those map exactly.
        Otherwise words map by meaning (so "High" in a generic dataset lands on
        the second tier rather than being mistaken for this scale's lowest
        level, which happens to be called High)."""
        if values and all(self.scale.match_level(v) for v in values):
            return {v: self.scale.match_level(v) or UNKNOWN_ID for v in values}
        out: dict[str, str] = {}
        for v in values:
            key = v.strip().casefold()
            num = to_float(v)
            if num is not None:
                idx = self._preset(num, len(self.scale.levels)) if self._preset else None
                out[v] = self.scale.level_at(idx) if idx is not None else UNKNOWN_ID
            else:
                k = WORD_CLASS.get(key)
                out[v] = self.scale.class_to_level(k) if k is not None else (self.scale.match_level(key) or UNKNOWN_ID)
        return out
