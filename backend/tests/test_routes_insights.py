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
