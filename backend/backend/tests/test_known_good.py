"""Run from backend/:  python tests/test_known_good.py"""
import os, sys, tempfile, time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from app.known_good import KnownGoodList  # noqa: E402


def write(p: Path, text: str) -> None:
    p.write_text(text, encoding="utf-8")
    t = time.time() + write.n  # force a distinct mtime
    write.n += 1
    os.utime(p, (t, t))
write.n = 1


def fresh(kg: KnownGoodList) -> None:
    kg._next_check = 0.0  # skip the 5s throttle
    kg.entries()          # and reload now


with tempfile.TemporaryDirectory() as d:
    path = Path(d) / "known_good.yaml"

    kg = KnownGoodList(path)                       # no file = feature off, no error
    assert kg.count == 0 and kg.error is None and not kg.matches("10.0.0.1")

    write(path, """
sources:
  - ip: 10.20.5.14
    note: Scanner
  - cidr: 10.20.9.0/24
    note: Probes
  - 192.0.2.77
  - ip: 2001:db8::/32
    note: v6 range
  - ip: 10.20.5.14        # duplicate
  - cidr: not-an-ip
  - note: no address
""")
    fresh(kg)
    assert kg.count == 4, kg.count
    assert kg.error == "2 entries skipped (see server log)", kg.error
    assert kg.matches("10.20.5.14") and kg.matches("10.20.9.200") and kg.matches("192.0.2.77")
    assert not kg.matches("10.20.5.15") and not kg.matches("10.20.10.1") and not kg.matches(None) and not kg.matches("garbage")
    assert kg.matches("2001:db8::5") and not kg.matches("2001:db9::5")
    cidrs = [e["cidr"] for e in kg.entries()]
    assert cidrs == ["10.20.5.14", "10.20.9.0/24", "192.0.2.77", "2001:db8::/32"], cidrs
    assert kg.entries()[0]["note"] == "Scanner"

    write(path, "sources: [this is: [not valid")  # a bad edit keeps the last good list
    fresh(kg)
    assert kg.count == 4 and kg.error and "not loaded" in kg.error and kg.matches("10.20.5.14")

    write(path, "- 10.1.1.1\n- 10.1.1.2\n")        # bare top-level list works, error clears
    fresh(kg)
    assert kg.count == 2 and kg.error is None and kg.matches("10.1.1.2") and not kg.matches("10.20.5.14")

    write(path, "something: else\n")               # wrong shape: ignored, keeps list
    fresh(kg)
    assert kg.count == 2 and kg.error

    path.unlink()                                  # file removed = off
    fresh(kg)
    assert kg.count == 0 and kg.error is None

# the HTTP route
from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
import app.routes.known_good as route  # noqa: E402

with tempfile.TemporaryDirectory() as d:
    path = Path(d) / "known_good.yaml"
    write(path, "sources:\n  - ip: 10.9.9.9\n    note: x\n")
    route.known_good = KnownGoodList(path)
    api = FastAPI(); api.include_router(route.router)
    r = TestClient(api).get("/api/known-good")
    assert r.status_code == 200 and r.headers["cache-control"] == "no-store"
    assert r.json() == {"entries": [{"cidr": "10.9.9.9", "note": "x"}], "loaded": True, "count": 1, "error": None}, r.json()

print("known_good: all tests passed")
