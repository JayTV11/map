"""Insights, links and signature-note tests. Run: python tests/test_insights.py"""
import sys, time
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from datetime import datetime, timezone
from app.insights import Insights
from app.models import TrafficEvent
from app.settings import _load_links

def mk(src="1.1.1.1", dst="10.0.0.1", sig="Sig A", sev="critical"):
    return TrafficEvent(src_lat=40, src_lon=-100, dst_lat=36, dst_lon=-84, src_ip=src, dst_ip=dst,
                        signature=sig, severity=sev, source="csv")

ins = Insights(None, "critical", ("critical", "high"))
for i in range(5): ins.observe(mk(src="1.1.1.1", dst=f"10.0.0.{i}"), False)
ins.observe(mk(src="2.2.2.2", sev="low", sig="Sig B"), False)
ins.observe(mk(src="3.3.3.3"), True)
h = ins.source_history("1.1.1.1")
assert h["events"] == 5 and h["distinct_targets"] == 5, h
assert ins.source_history("9.9.9.9") is None
s = ins.summary(4, ["critical", "high", "low"])
assert s["events"] == 6 and s["muted"] == 1, s
assert s["by_severity"][0] == {"id": "critical", "n": 5}, s["by_severity"]
assert all(x["name"] != "3.3.3.3" for x in s["top"]["sources"]), "muted must be excluded from tops"
assert len(s["timeline"]) == 4 and s["complete"] is False
assert s["notable"] and s["notable"][0]["severity"] == "critical"

good = _load_links([
    {"label": "VT", "url": "https://x.test/{src_ip}", "public_only": True},
    {"label": "bad", "url": "javascript:alert(1)"},
    {"label": "ph", "url": "https://x.test/{nope}"},
    {"label": "", "url": "https://x.test"},
    {"url": "https://x.test"},
])
assert [l["label"] for l in good] == ["VT"] and good[0]["public_only"] is True, good
assert _load_links("nope") == [] and _load_links(None) == []
print("insights: all tests passed")
