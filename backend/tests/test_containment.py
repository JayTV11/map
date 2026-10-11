"""Containment tracker + dossier. Run: python tests/test_containment.py"""
import sys, tempfile
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from app.containment import Containment, ContainmentRefused
from app.insights import Insights
from app.models import TrafficEvent

tmp = Path(tempfile.mkdtemp())
c = Containment(tmp / "c.json", tmp / "audit.log")
r = c.set("203.0.113.5", "blocked", "  blocked at   edge fw ", "sam")
assert r["status"] == "blocked" and r["note"] == "blocked at edge fw" and r["by"] == "sam", r
assert Containment(tmp / "c.json").get("203.0.113.5")["status"] == "blocked", "survives a reload"
c.set("203.0.113.5", "escalated", "", "kim")
assert c.get("203.0.113.5")["by"] == "kim" and len(c.entries()) == 1
for bad in (("nope", "blocked"), ("1.1.1.1", "deleted")):
    try: c.set(bad[0], bad[1], "", "x"); raise SystemExit(f"should refuse {bad}")
    except ContainmentRefused: pass
c.set("2001:0db8:0000:0000:0000:0000:0000:0001", "investigating", "", "sam")
assert c.get("2001:db8::1"), "addresses are normalised"
c.clear("203.0.113.5", "sam"); assert c.get("203.0.113.5") is None
lines = (tmp / "audit.log").read_text().strip().splitlines()
assert len(lines) == 4 and '"was": "blocked"' in lines[1] and '"action": "clear"' in lines[-1], lines
(tmp / "bad.json").write_text("{not json")
assert Containment(tmp / "bad.json").error, "a corrupt file starts empty and says so"

def mk(src, dst, sig="Sig A", sev="critical", port=80):
    return TrafficEvent(src_lat=1, src_lon=1, dst_lat=2, dst_lon=2, src_ip=src, dst_ip=dst, signature=sig, severity=sev, dst_port=port, source="csv")
ins = Insights(None, "critical", ("critical",))
for i in range(30): ins.observe(mk("9.9.9.9", f"10.0.0.{i % 5}", sig=f"S{i % 3}"), False)
d = ins.dossier("9.9.9.9", 6)
assert d["events"] == 30 and len(d["activity"]) == 6 and sum(a["n"] for a in d["activity"]) == 30, d["activity"]
assert len(d["recent"]) == 20 and d["recent"][0]["t"] >= d["recent"][-1]["t"], "newest first, capped"
assert len(d["top_targets"]) == 5 and ins.dossier("8.8.8.8") is None
print("containment: all tests passed")

# ---- campaigns ----
ins2 = Insights(None, "critical", ("critical", "high"))
for i in range(8): ins2.observe(mk("7.7.7.7", f"10.1.0.{i}", sig="Sweep", sev="high"), False)          # fan-out: one source, 8 targets
for i in range(6): ins2.observe(mk(f"6.6.6.{i}", "10.2.0.1", sig="Brute", sev="critical"), False)      # fan-in: 6 sources, one target
for i in range(10): ins2.observe(mk("5.5.5.5", "10.3.0.1", sig="Chatty", sev="critical"), False)       # one source, one target: not a campaign
ins2.observe(mk("4.4.4.4", "10.4.0.1"), True)                                                           # muted: never counted
r = ins2.campaigns(60, ["critical", "high"])
kinds = [(c["kind"], c.get("src_ip") or c.get("target")) for c in r["campaigns"]]
assert kinds == [("fan-in", "10.2.0.1"), ("fan-out", "7.7.7.7")], kinds   # worst severity first
assert r["campaigns"][1]["distinct"] == 8 and r["campaigns"][0]["distinct"] == 6 and r["events_considered"] == 24
assert ins2.campaigns(60, ["critical", "high"], now=__import__("time").time() + 7200)["campaigns"] == [], "old activity ages out"
print("campaigns: all tests passed")
