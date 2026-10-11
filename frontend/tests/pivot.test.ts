import assert from "node:assert/strict";
import test from "node:test";
import { pivotClause, pivotQuery } from "../src/pivot";
import { tryCompile } from "../src/kql";
import { TrafficEvent } from "../src/types";

const ev = (o: Partial<TrafficEvent>): TrafficEvent => ({
  id: "x", timestamp: "2026-01-01T00:00:00Z", src_lat: 0, src_lon: 0, dst_lat: 0, dst_lon: 0, severity: "critical", count: 1,
  src_ip: "203.0.113.5", dst_ip: "10.0.0.8", signature: null, signature_id: null, category: null, protocol: null,
  src_port: null, dst_port: null, action: null, alert_time: null, kibana_url: null, src_asset: null, dst_asset: null,
  direction: null, extra: {}, geo_note: null, source: "csv", is_replay: false, ...o,
});

test("plain values stay unquoted, odd ones are quoted and escaped", () => {
  assert.equal(pivotClause("src_ip", "203.0.113.5"), "src_ip:203.0.113.5");
  assert.equal(pivotClause("dst_port", 443), "dst_port:443");
  assert.equal(pivotClause("signature", "ET SCAN Nessus"), 'signature:"ET SCAN Nessus"');
  assert.equal(pivotClause("signature", 'say "hi" \\ there'), 'signature:"say \\"hi\\" \\\\ there"');
  assert.equal(pivotClause("category", "or"), 'category:"or"');
});

test("every pivot clause compiles and matches exactly the event it came from", () => {
  const e = ev({ signature: 'A "weird" sig (v2) * <x> and more', category: "Web Application Attack", dst_port: 8080, src_ip: "2001:db8::1" });
  const cases: [Parameters<typeof pivotClause>[0], string | number][] = [
    ["signature", e.signature!], ["category", e.category!], ["dst_port", 8080], ["src_ip", "2001:db8::1"], ["severity", "critical"],
  ];
  for (const [f, v] of cases) {
    const r = tryCompile(pivotClause(f, v));
    assert.ok(r.ok, `${f}=${v}: ${!r.ok && r.error.message}`);
    assert.ok(r.ok && r.query.test(e), `${f}=${v} should match its own event`);
  }
});

test("a wildcard in a value is literal, not a pattern", () => {
  const r = tryCompile(pivotClause("signature", "a*b"));
  assert.ok(r.ok);
  assert.ok(r.ok && !r.query.test(ev({ signature: "a-anything-b" })));
  assert.ok(r.ok && r.query.test(ev({ signature: "xx a*b yy" })));
});

test("click replaces, shift-click ands, and an existing or is bracketed", () => {
  assert.equal(pivotQuery("dst_port:80", "src_ip:1.1.1.1", false), "src_ip:1.1.1.1");
  assert.equal(pivotQuery("", "src_ip:1.1.1.1", true), "src_ip:1.1.1.1");
  assert.equal(pivotQuery("dst_port:80", "src_ip:1.1.1.1", true), "dst_port:80 and src_ip:1.1.1.1");
  assert.equal(pivotQuery("dst_port:80 or dst_port:443", "src_ip:1.1.1.1", true), "(dst_port:80 or dst_port:443) and src_ip:1.1.1.1");
  assert.equal(pivotQuery("dst_port:80", "dst_port:80", true), "dst_port:80");
  const r = tryCompile(pivotQuery("dst_port:80 or dst_port:443", "src_ip:1.1.1.1", true));
  assert.ok(r.ok && r.query.test(ev({ dst_port: 443, src_ip: "1.1.1.1" })) && !r.query.test(ev({ dst_port: 443, src_ip: "9.9.9.9" })));
});
