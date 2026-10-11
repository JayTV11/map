"""Plain-English notes on alert types, written once and shown to every analyst.

Defined in backend/signatures.yaml (copy signatures.example.yaml). It is yours to write and keep: what an
alert means in your environment, what to check, where the runbook is. It is gitignored (it describes
your network); only the example is committed.

    notes:
      - match: "ET SCAN Nessus*"          # the alert name; * matches anything. Or use id: below.
        what: Our vulnerability scanner probing a host.
        action: Check the scan calendar; if it is not scheduled, escalate.
        link: https://wiki.example.com/runbooks/nessus
      - id: "2100498"                     # the rule / signature id instead of a name
        what: ...

The most specific note wins (an exact name beats a pattern; a longer pattern beats a shorter one). Like
assets.yaml the file is re-read when it changes, and a bad edit never blanks the notes: a file that fails
to parse is ignored (the previous notes stay) and bad entries are skipped, reported in the server log
and GET /api/status. The browser does the matching (frontend/src/signatureNotes.ts).
"""
from __future__ import annotations

import time
from pathlib import Path
from typing import Any, Optional

import yaml

MAX_NOTES = 1000
MAX_TEXT = 800


class SignatureNotes:
    RELOAD_CHECK_SECONDS = 5.0

    def __init__(self, path: Path) -> None:
        self._path = path
        self._notes: list[dict[str, str]] = []
        self._mtime: Optional[float] = None
        self._next_check = 0.0
        self.error: Optional[str] = None
        self._load()

    @property
    def count(self) -> int:
        return len(self._notes)

    def entries(self) -> list[dict[str, str]]:
        self._maybe_reload()
        return list(self._notes)

    def info(self) -> dict[str, Any]:
        self._maybe_reload()
        return {"loaded": self.count > 0, "count": self.count, "error": self.error}

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
            self._notes, self.error = [], None  # no file = feature simply off
            return
        try:
            raw = yaml.safe_load(self._path.read_text(encoding="utf-8")) or {}
            items = raw.get("notes") if isinstance(raw, dict) else raw if isinstance(raw, list) else None
            if not isinstance(items, list):
                raise ValueError("expected a top-level 'notes:' list")
        except (yaml.YAMLError, ValueError, OSError) as exc:
            self.error = f"{self._path.name} was not loaded: {type(exc).__name__}"
            print(f"[signature_notes] {self.error} ({exc})")
            return  # keep the previous notes rather than blanking them

        notes: list[dict[str, str]] = []
        skipped = 0
        for i, item in enumerate(items[:MAX_NOTES], start=1):
            try:
                match = str(item.get("match") or "").strip()
                sig_id = str(item.get("id") or "").strip()
                if not match and not sig_id:
                    raise ValueError("needs a 'match' (alert name) or an 'id'")
                what = " ".join(str(item.get("what") or "").split())[:MAX_TEXT]
                if not what:
                    raise ValueError("needs a 'what'")
                entry = {"what": what}
                if match:
                    entry["match"] = match[:300]
                if sig_id:
                    entry["id"] = sig_id[:80]
                action = " ".join(str(item.get("action") or "").split())[:MAX_TEXT]
                if action:
                    entry["action"] = action
                link = str(item.get("link") or "").strip()
                if link:
                    if not link.lower().startswith(("http://", "https://")):
                        raise ValueError("link must start with http:// or https://")
                    entry["link"] = link[:500]
                notes.append(entry)
            except (TypeError, ValueError, AttributeError) as exc:
                skipped += 1
                print(f"[signature_notes] entry {i} skipped: {exc!r}")
        self._notes = notes
        self.error = f"{skipped} entr{'y' if skipped == 1 else 'ies'} skipped (see server log)" if skipped else None


signature_notes = SignatureNotes(Path(__file__).resolve().parent.parent / "signatures.yaml")
