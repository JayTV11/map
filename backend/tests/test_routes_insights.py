"""Routes: python tests/test_routes_insights.py"""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from fastapi.testclient import TestClient
from app.main import app
from app import insights
from app.models import TrafficEvent

c = TestClient(app)
insights.reset_simulated()
insights.observe_event(TrafficEvent(src_lat=1, src_lon=1, dst_lat=2, dst_lon=2, src_ip="8.8.8.8", dst_ip="10.1.1.1",
                                    signature="X", severity="critical", source="csv"), False)
r = c.get("/api/source-history", params={"ip": "8.8.8.8"}).json()
assert r["source"] == "simulated" and r["history"]["events"] == 1, r
assert c.get("/api/source-history", params={"ip": "1.2.3.4"}).json()["history"] is None
assert c.get("/api/source-history", params={"ip": "<script>"}).status_code == 400
s = c.get("/api/summary", params={"hours": 4}).json()
assert s["source"] == "simulated" and s["events"] == 1 and len(s["timeline"]) == 4, s
assert c.get("/api/summary", params={"hours": 999}).status_code == 422
assert "notes" in c.get("/api/signature-notes").json()
assert "links" in c.get("/api/config").json()
st = c.get("/api/status").json()
assert "insights" in st and "signature_notes" in st
print("insight routes: all tests passed")

# ---- dossier and containment routes ----
from app import containment as _cm
d = c.get("/api/source-dossier", params={"ip": "8.8.8.8"}).json()
assert d["source"] == "simulated" and d["dossier"]["events"] == 1 and len(d["dossier"]["activity"]) == 24, d
assert c.get("/api/source-dossier", params={"ip": "<x>"}).status_code == 400
_cm.containment._path = None; _cm.containment._audit_path = None; _cm.containment._rows = {}  # keep the test off the real data
assert c.get("/api/containment").json()["entries"] is not None
assert c.put("/api/containment", json={"ip": "8.8.8.8", "status": "blocked"}).status_code == 403, "needs the page's header"
H = {"x-sightline-edit": "1"}
ok = c.put("/api/containment", json={"ip": "8.8.8.8", "status": "blocked", "note": "fw"}, headers=H)
assert ok.status_code == 200 and ok.json()["status"] == "blocked", ok.text
assert c.put("/api/containment", json={"ip": "8.8.8.8", "status": "bogus"}, headers=H).status_code == 400
assert [e["ip"] for e in c.get("/api/containment").json()["entries"]] == ["8.8.8.8"]
assert c.delete("/api/containment", params={"ip": "8.8.8.8"}, headers=H).status_code == 200
assert c.get("/api/containment").json()["entries"] == []
print("containment routes: all tests passed")
assert "campaigns" in c.get("/api/campaigns", params={"minutes": 60}).json()
assert c.get("/api/campaigns", params={"minutes": 1}).status_code == 422
print("campaign route: ok")
