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
    assert r.json() == {"entries": [{"cidr": "10.9.9.9", "note": "x", "source": "file"}], "editable": False, "loaded": True, "count": 1, "error": None}, r.json()

# ---- editing from the screen -------------------------------------------------------------
import json  # noqa: E402
import app.known_good as kgmod  # noqa: E402
from app.known_good import EditRefused  # noqa: E402


def refused(fn, *a):
    try:
        fn(*a)
    except EditRefused as exc:
        return str(exc)
    raise AssertionError("expected EditRefused")


with tempfile.TemporaryDirectory() as d:
    d = Path(d)
    yaml_path, added, audit = d / "known_good.yaml", d / "data" / "added.json", d / "data" / "audit.log"
    write(yaml_path, "sources:\n  - ip: 10.9.9.9\n    note: scanner\n")
    kg = KnownGoodList(yaml_path, added, audit)

    assert kg.add("203.0.113.5", "  partner   gateway ", "ana@corp") == {"cidr": "203.0.113.5", "note": "partner gateway"}
    assert kg.matches("203.0.113.5") and kg.matches("10.9.9.9") and not kg.matches("203.0.113.6")
    assert kg.count == 2
    ents = {e["cidr"]: e for e in kg.entries()}
    assert ents["10.9.9.9"]["source"] == "file" and ents["203.0.113.5"]["source"] == "analyst"
    assert ents["203.0.113.5"]["added_by"] == "ana@corp" and ents["203.0.113.5"]["added_at"]
    assert yaml_path.read_text() == "sources:\n  - ip: 10.9.9.9\n    note: scanner\n"  # the hand-edited file is never touched

    # survives a restart, and the audit trail records who did what
    kg2 = KnownGoodList(yaml_path, added, audit)
    assert kg2.matches("203.0.113.5")
    kg2.add("10.20.9.0/24", "probes", "bo@corp")
    assert kg2.matches("10.20.9.77")
    kg2.remove("203.0.113.5", "bo@corp")
    assert not kg2.matches("203.0.113.5")
    log = [json.loads(x) for x in audit.read_text().splitlines()]
    assert [(x["action"], x["cidr"], x["user"]) for x in log] == [
        ("add", "203.0.113.5", "ana@corp"), ("add", "10.20.9.0/24", "bo@corp"), ("remove", "203.0.113.5", "bo@corp")]

    # refusals come with plain-English reasons
    assert "not a valid" in refused(kg2.add, "nope", "", "u")
    assert "too wide" in refused(kg2.add, "10.0.0.0/8", "", "u")
    assert "too wide" in refused(kg2.add, "0.0.0.0/0", "", "u")
    assert "can't be muted" in refused(kg2.add, "127.0.0.1", "", "u")
    assert "already" in refused(kg2.add, "10.9.9.9", "", "u")
    assert "known_good.yaml" in refused(kg2.remove, "10.9.9.9", "u")   # the screen can't remove the admin's entries
    assert "not on the list" in refused(kg2.remove, "198.51.100.1", "u")
    assert kg2.matches("10.9.9.9")

    # a corrupted added-file doesn't take down the yaml list
    added.write_text("{broken")
    kg3 = KnownGoodList(yaml_path, added, audit)
    assert kg3.matches("10.9.9.9") and kg3.count == 1

# ---- the edit routes ---------------------------------------------------------------------
with tempfile.TemporaryDirectory() as d:
    d = Path(d)
    write(d / "known_good.yaml", "sources: []\n")
    route.known_good = KnownGoodList(d / "known_good.yaml", d / "added.json", d / "audit.log")
    api = FastAPI(); api.include_router(route.router)
    c = TestClient(api)
    H = {"x-sightline-edit": "1"}

    def settings(**kw):
        base = {"editable": False, "user_header": "", "min_prefix_v4": 16, "min_prefix_v6": 48}
        base.update(kw)
        route._kg_settings = lambda: base

    settings()                                                   # off by default
    assert c.post("/api/known-good", json={"ip": "203.0.113.5"}, headers=H).status_code == 403
    settings(editable=True)
    assert c.post("/api/known-good", json={"ip": "203.0.113.5"}).status_code == 403          # no custom header: refused (cross-site safety)
    r = c.post("/api/known-good", json={"ip": "203.0.113.5", "note": "x"}, headers=H)
    assert r.status_code == 200 and r.json()["cidr"] == "203.0.113.5", r.text
    g = c.get("/api/known-good").json()
    assert g["editable"] is True and g["entries"][0]["added_by"].startswith("unknown")
    assert c.post("/api/known-good", json={"ip": "10.0.0.0/8"}, headers=H).status_code == 400
    assert c.post("/api/known-good", content="ip=1.2.3.4", headers={**H, "content-type": "text/plain"}).status_code == 422

    settings(editable=True, user_header="x-forwarded-user")      # SSO header required
    assert c.post("/api/known-good", json={"ip": "203.0.113.9"}, headers=H).status_code == 401
    r = c.post("/api/known-good", json={"ip": "203.0.113.9"}, headers={**H, "x-forwarded-user": "ana@corp"})
    assert r.status_code == 200
    assert {e["cidr"]: e.get("added_by") for e in c.get("/api/known-good").json()["entries"]}["203.0.113.9"] == "ana@corp"
    assert c.delete("/api/known-good?cidr=203.0.113.9", headers=H).status_code == 401
    assert c.delete("/api/known-good?cidr=203.0.113.9", headers={**H, "x-forwarded-user": "ana@corp"}).status_code == 200
    assert c.delete("/api/known-good?cidr=203.0.113.9", headers={**H, "x-forwarded-user": "ana@corp"}).status_code == 400

print("known_good: all tests passed")
