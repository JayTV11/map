import assert from "node:assert/strict";
import { test } from "node:test";
import { inNet, ipInNet, parseIp, parseNet } from "../src/ipmatch";
import { compileQuery, tryCompile } from "../src/kql";
import { TrafficEvent } from "../src/types";

function ev(o: Partial<TrafficEvent> = {}): TrafficEvent {
  return {
    id: "1", timestamp: "2026-10-10T00:00:00Z", src_lat: 0, src_lon: 0, dst_lat: 0, dst_lon: 0,
    severity: "critical", count: 1, src_ip: "203.0.113.7", dst_ip: "10.50.10.12",
    signature: "ET SCAN Nmap Scripting Engine", signature_id: "2009582", category: "Attempted Information Leak",
    protocol: "tcp", src_port: 51514, dst_port: 443, action: "allowed", alert_time: null, kibana_url: null,
    src_asset: null, dst_asset: { name: "Payment API", criticality: "critical" }, direction: "inbound",
    extra: { "host.name": "web-01", user_agent: "Mozilla/5.0" }, geo_note: null, source: "elastic", is_replay: false,
    ...o,
  };
}
const q = (s: string) => compileQuery(s).test;
const err = (s: string) => {
  const r = tryCompile(s);
  assert.equal(r.ok, false, `expected "${s}" to be rejected`);
  return r.ok ? "" : r.error.message;
};

test("ip parsing", () => {
  assert.deepEqual(parseIp("10.0.0.1"), { v: 4, n: 167772161n });
  assert.equal(parseIp("10.0.0.256"), null);
  assert.equal(parseIp("10.0.0"), null);
  assert.equal(parseIp("garbage"), null);
  assert.equal(parseIp("2001:db8::1")?.v, 6);
  assert.equal(parseIp("::1")?.n, 1n);
  assert.equal(parseIp("1:2:3:4:5:6:7:8")?.v, 6);
  assert.equal(parseIp("1:2:3:4:5:6:7::")?.v, 6);
  assert.equal(parseIp("1::2::3"), null);
  assert.equal(parseIp("12345::1"), null);
  assert.deepEqual(parseIp("::ffff:10.0.0.5"), parseIp("10.0.0.5")); // IPv4-mapped is the v4 address
  assert.equal(parseIp("fe80::1%eth0")?.v, 6);
});

test("cidr matching", () => {
  const net = parseNet("10.20.9.0/24")!;
  assert.ok(ipInNet("10.20.9.200", net));
  assert.ok(!ipInNet("10.20.10.1", net));
  assert.ok(!ipInNet("2001:db8::1", net)); // family mismatch
  assert.ok(!ipInNet(null, net));
  assert.ok(!ipInNet("not an ip", net));
  const host = parseNet("192.0.2.77")!;
  assert.ok(ipInNet("192.0.2.77", host) && !ipInNet("192.0.2.78", host));
  const v6 = parseNet("2001:db8::/32")!;
  assert.ok(ipInNet("2001:db8:ffff::1", v6) && !ipInNet("2001:db9::1", v6));
  assert.ok(inNet(parseIp("1.2.3.4")!, parseNet("0.0.0.0/0")!));
  assert.equal(parseNet("10.0.0.0/33"), null);
  assert.equal(parseNet("10.0.0.0/x"), null);
  assert.equal(parseNet("::/129"), null);
});

test("empty query matches everything", () => {
  const c = compileQuery("   ");
  assert.ok(c.isEmpty && c.test(ev()));
});

test("field:value on IP fields, with aliases and CIDR", () => {
  assert.ok(q("src_ip:203.0.113.7")(ev()));
  assert.ok(q("source.ip:203.0.113.7")(ev()));
  assert.ok(q("destination.ip:10.0.0.0/8")(ev()));
  assert.ok(!q("src_ip:203.0.113.8")(ev()));
  assert.ok(!q("src_ip:10.0.0.0/8")(ev()));
  assert.ok(q("ip:10.50.10.12")(ev()) && q("ip:203.0.113.7")(ev())); // either side
  assert.ok(q("src_ip:203.0.113.*")(ev()));
  assert.ok(!q("src_ip:198.51.100.*")(ev()));
  assert.ok(q("SRC_IP:203.0.113.7")(ev())); // field names ignore case
});

test("IPv6 values are not mistaken for field:value", () => {
  const e = ev({ src_ip: "2001:db8::5" });
  assert.ok(q("2001:db8::5")(e));
  assert.ok(q("2001:db8::/32")(e));
  assert.ok(q("src_ip:2001:db8::5")(e));
  assert.ok(q("src_ip:2001:db8::/32")(e));
  assert.ok(!q("2001:db9::/32")(e));
});

test("numeric fields: equality and comparison", () => {
  assert.ok(q("dst_port:443")(ev()));
  assert.ok(q("destination.port:443")(ev()));
  assert.ok(q("port:51514")(ev()));
  assert.ok(q("dst_port > 400")(ev()) && q("dst_port>=443")(ev()) && q("dst_port<=443")(ev()));
  assert.ok(!q("dst_port > 443")(ev()) && !q("dst_port < 443")(ev()));
  assert.ok(!q("dst_port > 1")(ev({ dst_port: null }))); // missing never matches
  assert.ok(q("src_port >= 1024 and dst_port < 1024")(ev()));
  assert.match(err("dst_port:abc"), /not a number/);
  assert.match(err("dst_port >"), /Expected a number/);
  assert.match(err("signature > 5"), /numeric field/);
  assert.match(err("> 5"), /field name/);
});

test("keyword vs text matching", () => {
  assert.ok(q("action:allowed")(ev()) && q("action:ALLOWED")(ev()));
  assert.ok(!q("action:allow")(ev())); // keyword: whole value
  assert.ok(q("action:all*")(ev()));
  assert.ok(q("protocol:tcp")(ev()) && q("network.transport:tcp")(ev()));
  assert.ok(q("signature:nmap")(ev())); // text: contains
  assert.ok(q("signature:*scan*")(ev()));
  assert.ok(!q("signature:scan*")(ev())); // wildcard must fit the whole value ("ET SCAN..." doesn't start with scan)
  assert.ok(q('signature:"ET SCAN"')(ev()));
  assert.ok(q("rule.name:nmap")(ev()));
  assert.ok(q("asset:payment")(ev()) && q("dst_asset:\"Payment API\"")(ev()) && !q("src_asset:payment")(ev()));
  assert.ok(q("dst_criticality:critical")(ev()));
  assert.ok(q("direction:inbound")(ev()));
});

test("severity matches id or label", () => {
  assert.ok(q("severity:critical")(ev()) && q("severity:Critical")(ev()));
  assert.ok(q("event.severity:critical")(ev()));
  assert.ok(q("severity:(critical or major)")(ev()));
  assert.ok(!q("severity:(major or high)")(ev()));
  assert.ok(q("severity:unknown")(ev({ severity: "unknown" })));
});

test("exists", () => {
  assert.ok(q("signature:*")(ev()) && !q("signature:*")(ev({ signature: null })));
  assert.ok(q("dst_asset:*")(ev()) && !q("src_asset:*")(ev()));
});

test("boolean logic and precedence", () => {
  assert.ok(q("action:allowed and protocol:tcp")(ev()));
  assert.ok(!q("action:allowed and protocol:udp")(ev()));
  assert.ok(q("action:allowed or protocol:udp")(ev()));
  assert.ok(q("not protocol:udp")(ev()) && !q("not protocol:tcp")(ev()));
  assert.ok(q("AND_ISH:1 or protocol:tcp")(ev())); // 'or' is case-insensitive, and unknown fields just don't match
  assert.ok(q("protocol:tcp OR protocol:udp")(ev()));
  assert.ok(q("not (protocol:udp or protocol:icmp)")(ev()));
  // and binds tighter than or:  a or (b and c)
  assert.ok(q("protocol:tcp or protocol:udp and action:blocked")(ev()));
  assert.ok(!q("(protocol:tcp or protocol:udp) and action:blocked")(ev()));
  assert.ok(q("not not protocol:tcp")(ev()));
  // side-by-side terms are ANDed
  assert.ok(q("protocol:tcp action:allowed")(ev()) && !q("protocol:tcp action:blocked")(ev()));
});

test("grouped values", () => {
  assert.ok(q("dst_port:(80 or 443)")(ev()));
  assert.ok(!q("dst_port:(80 or 8080)")(ev()));
  assert.ok(q("signature:(*scan* and not *brute*)")(ev()));
  assert.ok(!q("signature:(*scan* and *brute*)")(ev()));
  assert.ok(q("src_ip:(203.0.113.0/24 or 198.51.100.0/24)")(ev()));
});

test("bare terms search every field", () => {
  assert.ok(q("nmap")(ev()) && q("Payment")(ev()) && q("web-01")(ev()) && q("mozilla")(ev()));
  assert.ok(!q("kerberos")(ev()));
  assert.ok(q("203.0.113.7")(ev()) && q("10.0.0.0/8")(ev()) && !q("192.168.0.0/16")(ev()));
  assert.ok(!q("203.0.113.70")(ev())); // an IP is matched as an address, not as text
  assert.ok(q("*scan*")(ev()));
  assert.ok(q('"ET SCAN"')(ev()));
  assert.ok(q("scan and not udp")(ev()));
});

test("quoted values are literal", () => {
  assert.ok(!q('signature:"*scan*"')(ev())); // a quoted * is a literal star
  assert.ok(q('signature:"ET SCAN Nmap Scripting Engine"')(ev()));
  assert.ok(q('signature:"a \\"quoted\\" word"')(ev({ signature: 'a "quoted" word' })));
});

test("unmapped extra columns", () => {
  assert.ok(q("host.name:web-01")(ev()));
  assert.ok(q("HOST.NAME:web*")(ev()));
  assert.ok(!q("host.name:db-01")(ev()));
  assert.ok(q("user_agent:mozilla")(ev()));
  assert.ok(!q("nothing.here:x")(ev()));
  assert.deepEqual(compileQuery("host.name:x and src_ip:1.1.1.1 and nothing.here:y").unknownFields, ["host.name", "nothing.here"]);
  assert.ok(q("size > 5")(ev({ extra: { size: "10" } })) && !q("size > 50")(ev({ extra: { size: "10" } })));
  assert.ok(!q("size > 5")(ev({ extra: { size: "huge" } })));
  assert.ok(q("signature:nmap")(ev({ extra: undefined as never })));
});

test("errors are specific and positioned", () => {
  assert.match(err('signature:"oops'), /closing quote/);
  assert.match(err("(src_ip:1.1.1.1"), /closing parenthesis/);
  assert.match(err("src_ip:1.1.1.1)"), /closing parenthesis/);
  assert.match(err("src_ip:999.1.1.1"), /valid IP/);
  assert.match(err("src_ip:10.0.0.0/40"), /valid IP/);
  assert.match(err("a or"), /ends too early/);
  assert.match(err("not"), /ends too early/);
  assert.match(err("and x"), /needs a search term/);
  assert.match(err("x and and y"), /needs a search term/);
  assert.match(err("src_ip:"), /Expected a value/);
  assert.match(err("src_ip: and x"), /Expected a value/);
  const r = tryCompile("action:allowed and src_ip:999.1.1.1");
  assert.ok(!r.ok && r.error.pos === 26 && r.error.end === 35, JSON.stringify(r));
  assert.match(err("()"), /Unexpected closing/);
});

test("a quoted keyword is searched, not treated as an operator", () => {
  assert.ok(q('"and"')(ev({ signature: "this and that" })));
  assert.ok(!q('"and"')(ev()));
});

test("compiled queries are reusable and side-effect free", () => {
  const f = q("severity:critical and dst_port:443");
  for (let i = 0; i < 3; i++) assert.ok(f(ev()));
  assert.ok(!f(ev({ dst_port: 80 })));
});
