"""Run from backend/:  python tests/test_anomaly.py"""
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from app.anomaly import AnomalyScorer, features_of
from app.geo_country import country_at
from app.models import AssetRef, TrafficEvent  # noqa: E402

BEIJING = (39.9, 116.4)
SAO_PAULO = (-23.5, -46.6)


def ev(**kw) -> TrafficEvent:
    base = dict(src_lat=BEIJING[0], src_lon=BEIJING[1], dst_lat=39.04, dst_lon=-77.49, severity="major",
                src_ip="198.51.100.5", dst_ip="192.0.2.10", signature="ET SCAN SSH", dst_port=22,
                source="csv", direction="inbound")
    base.update(kw)
    return TrafficEvent(**base)


def trained(n=400, **kw) -> AnomalyScorer:
    clock = kw.pop("clock", lambda: 0.0)
    s = AnomalyScorer(None, min_events=kw.pop("min_events", 50), min_hours=kw.pop("min_hours", 0), clock=clock, **kw)
    for _ in range(n):
        s.score_and_learn(ev())
    return s


def test_country_lookup():
    assert country_at(*BEIJING) == "China"
    assert country_at(*SAO_PAULO) == "Brazil"
    assert country_at(0, 0) is None
    assert country_at(10, -30) is None  # open ocean
    assert country_at(999, 0) is None


def test_the_usual_scores_low_and_the_novel_scores_high():
    s = trained()
    usual = s.score(ev())
    assert usual.score < 10 and usual.level == "usual"
    novel = s.score(ev(src_lat=SAO_PAULO[0], src_lon=SAO_PAULO[1], signature="ET EXPLOIT Log4j", dst_port=8080))
    assert novel.score >= 70 and novel.level == "unusual"
    assert any("Brazil" in r for r in novel.reasons)
    assert any("Log4j" in r for r in novel.reasons)


def test_a_new_address_alone_is_not_alarming():
    s = trained()
    r = s.score(ev(src_ip="198.51.100.99"))
    assert r.level == "usual"
    assert r.reasons == ["First time seen: address 198.51.100.99"]


def test_first_event_is_scored_before_it_is_counted():
    s = AnomalyScorer(None, min_events=1, min_hours=0)
    for _ in range(100):
        s.score_and_learn(ev())
    first = s.score_and_learn(ev(src_lat=SAO_PAULO[0], src_lon=SAO_PAULO[1]))
    assert any("First time seen" in r for r in first.reasons)
    again = s.score(ev(src_lat=SAO_PAULO[0], src_lon=SAO_PAULO[1]))
    assert again.score < first.score


def test_known_things_in_a_new_pairing_are_flagged_without_double_counting():
    s = AnomalyScorer(None, min_events=1, min_hours=0)
    for _ in range(300):
        s.score_and_learn(ev(src_ip="198.51.100.5", dst_ip="192.0.2.10"))
        s.score_and_learn(ev(src_ip="198.51.100.6", dst_ip="192.0.2.11"))
    r = s.score(ev(src_ip="198.51.100.5", dst_ip="192.0.2.11"))
    assert any("this address hitting this target" in x for x in r.reasons)
    brand_new = s.score(ev(src_ip="198.51.100.77", dst_ip="192.0.2.10"))
    assert not any("this address hitting this target" in x for x in brand_new.reasons)


def test_learning_flag_needs_enough_events_and_time():
    now = [0.0]
    s = AnomalyScorer(None, min_events=100, min_hours=2, clock=lambda: now[0])
    assert s.score(ev()).learning is True
    for _ in range(150):
        s.score_and_learn(ev())
    assert s.score(ev()).learning is True      # enough events, not enough time
    now[0] = 3 * 3600
    assert s.score(ev()).learning is False


def test_outbound_looks_at_the_destination_country():
    f = {x.name: x.value for x in features_of(ev(direction="outbound", src_lat=36.0, src_lon=-84.3, dst_lat=SAO_PAULO[0], dst_lon=SAO_PAULO[1],
                                                src_ip="10.20.14.88", dst_ip="203.0.113.9"))}
    assert f["country"] == "Brazil"
    assert f["remote_ip"] == "203.0.113.9" and f["target"] == "10.20.14.88"


def test_internal_traffic_has_no_country_or_remote_address():
    names = {x.name for x in features_of(ev(direction="internal", src_ip="10.20.1.1", dst_ip="10.20.1.2"))}
    assert "country" not in names and "remote_ip" not in names and "pair" not in names


def test_an_assumed_source_location_is_not_a_country():
    names = {x.name for x in features_of(ev(geo_note="source location assumed (home site)"))}
    assert "country" not in names


def test_target_is_named_by_asset_when_known():
    f = {x.name: x.show for x in features_of(ev(dst_asset=AssetRef(name="Payment API", criticality="critical")))}
    assert f["target"] == "target Payment API"


def test_missing_fields_do_not_break_scoring():
    e = TrafficEvent(src_lat=1, src_lon=1, dst_lat=2, dst_lon=2, source="csv")
    s = AnomalyScorer(None)
    r = s.score_and_learn(e)
    assert 0 <= r.score <= 100


def test_history_survives_a_restart():
    with tempfile.TemporaryDirectory() as d:
        path = Path(d) / "sub" / "a.db"
        a = AnomalyScorer(path, min_events=10, min_hours=0)
        for _ in range(200):
            a.score_and_learn(ev())
        a.flush_if_due(force=True)
        b = AnomalyScorer(path, min_events=10, min_hours=0)
        assert b.total == 200
        assert b.score(ev()).score < 10
        assert b.score(ev(src_lat=SAO_PAULO[0], src_lon=SAO_PAULO[1])).score > 40


def test_unwritable_location_falls_back_to_memory():
    s = AnomalyScorer(Path("/proc/definitely/not/writable/a.db"))
    assert s.error and not s.info()["saved"]
    s.score_and_learn(ev())  # still works


def test_reset_starts_over():
    s = trained()
    s.reset()
    assert s.total == 0 and s.score(ev()).learning is True


if __name__ == "__main__":
    tests = [(n, f) for n, f in sorted(globals().items()) if n.startswith("test_") and callable(f)]
    for name, fn in tests:
        fn()
        print(f"ok  {name}")
    print(f"{len(tests)} anomaly tests passed")
