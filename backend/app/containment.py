"""Where each source stands in the response: investigating, escalated, blocked, or a false positive.

A small shared list, so every analyst (and the wall) sees that "203.0.113.5 was blocked at the firewall at 14:02 by
Sam" instead of two people chasing the same address. It does NOT block anything: it records what people did.

Kept in data/containment.json (atomic writes, survives a restart); every change is appended to
data/containment_audit.log. Editing needs the same guards as the known-good list: the request must come from the
Sightline page (x-sightline-edit header), and if a user header is configured (the SSO proxy sets it) it must be
present, so the entry says who made it.

config.yaml:
    containment:
      enabled: true            # default; false turns the tracker off
      user_header: X-Forwarded-User   # defaults to known_good.user_header
"""
from __future__ import annotations

import ipaddress
import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from .config import config

STATUSES = ("investigating", "escalated", "blocked", "false_positive")
MAX_ENTRIES = 2_000
MAX_NOTE = 200


class ContainmentRefused(ValueError):
    """A message an analyst can read."""


def settings() -> dict[str, Any]:
    raw = config.get("containment")
    raw = raw if isinstance(raw, dict) else {}
    kg = config.get("known_good")
    kg = kg if isinstance(kg, dict) else {}
    return {
        "enabled": raw.get("enabled") is not False,
        "user_header": str(raw.get("user_header") or kg.get("user_header") or "").strip(),
    }


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class Containment:
    def __init__(self, path: Optional[Path], audit_path: Optional[Path] = None) -> None:
        self._path = path
        self._audit_path = audit_path
        self._rows: dict[str, dict[str, str]] = {}
        self.error: Optional[str] = None
        self._load()

    def entries(self) -> list[dict[str, str]]:
        return [{"ip": ip, **row} for ip, row in sorted(self._rows.items(), key=lambda kv: kv[1]["at"], reverse=True)]

    def get(self, ip: str) -> Optional[dict[str, str]]:
        row = self._rows.get(ip)
        return {"ip": ip, **row} if row else None

    def info(self) -> dict[str, Any]:
        return {"enabled": settings()["enabled"], "count": len(self._rows), "error": self.error}

    def set(self, ip: str, status: str, note: str, user: str) -> dict[str, str]:
        ip = self._norm_ip(ip)
        if status not in STATUSES:
            raise ContainmentRefused("Status must be one of: " + ", ".join(STATUSES) + ".")
        if ip not in self._rows and len(self._rows) >= MAX_ENTRIES:
            raise ContainmentRefused(f"The tracker is full ({MAX_ENTRIES} addresses). Clear some that are finished.")
        row = {"status": status, "note": " ".join(str(note).split())[:MAX_NOTE], "by": user, "at": _now()}
        before = self._rows.get(ip)
        self._rows[ip] = row
        self._save()
        self._audit("set", ip, row["status"], row["note"], user, before["status"] if before else None)
        return {"ip": ip, **row}

    def clear(self, ip: str, user: str) -> None:
        ip = self._norm_ip(ip)
        before = self._rows.pop(ip, None)
        if before is None:
            return
        self._save()
        self._audit("clear", ip, "", "", user, before["status"])

    @staticmethod
    def _norm_ip(ip: str) -> str:
        try:
            return str(ipaddress.ip_address(str(ip).strip()))
        except ValueError:
            raise ContainmentRefused("That is not a valid IP address.") from None

    def _save(self) -> None:
        if self._path is None:
            return
        try:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self._path.with_suffix(".tmp")
            tmp.write_text(json.dumps({"entries": self._rows}, indent=2), encoding="utf-8")
            os.replace(tmp, self._path)
        except OSError as exc:
            raise ContainmentRefused(f"The change could not be saved on the server ({type(exc).__name__}). Is the data folder writable?") from exc

    def _audit(self, action: str, ip: str, status: str, note: str, user: str, was: Optional[str]) -> None:
        print(f"[containment] {action} {ip} {status} by {user}")
        if self._audit_path is None:
            return
        line = {"ts": _now(), "action": action, "ip": ip, "status": status, "was": was, "note": note, "user": user}
        try:
            self._audit_path.parent.mkdir(parents=True, exist_ok=True)
            with self._audit_path.open("a", encoding="utf-8") as f:
                f.write(json.dumps(line) + "\n")
        except OSError as exc:
            print(f"[containment] audit log not written: {exc!r}")

    def _load(self) -> None:
        if self._path is None or not self._path.exists():
            return
        try:
            raw = json.loads(self._path.read_text(encoding="utf-8"))
            rows: dict[str, dict[str, str]] = {}
            for ip, r in raw["entries"].items():
                if r["status"] in STATUSES:
                    rows[str(ip)] = {"status": r["status"], "note": str(r.get("note", ""))[:MAX_NOTE], "by": str(r.get("by", "")), "at": str(r.get("at", ""))}
            self._rows = rows
        except (OSError, ValueError, KeyError, TypeError, AttributeError) as exc:
            self.error = f"saved statuses were not loaded ({type(exc).__name__}); starting empty"
            print(f"[containment] {self.error}: {exc}")


_DATA = Path(__file__).resolve().parent.parent / "data"
containment = Containment(_DATA / "containment.json", _DATA / "containment_audit.log")
