import assert from "node:assert/strict";
import { test } from "node:test";
import { AlertGate, Alerter, AlertEnv } from "../src/alerts";
import { csvCell, eventsToCsv } from "../src/csv";
import { EventHistory, Replayer } from "../src/replay";
import { TrafficEvent } from "../src/types";

function ev(o: Partial<TrafficEvent> = {}): TrafficEvent {
  return {
    id: "1", timestamp: "2026-10-10T12:00:00Z", src_lat: 50.45, src_lon: 30.52, dst_lat: 36, dst_lon: -84, severity: "critical", count: 1,
    src_ip: "198.51.100.1", dst_ip: "10.50.10.12", signature: "ET EXPLOIT Log4j", signature_id: "2034647", category: "Attempted Admin",
    protocol: "tcp", src_port: 51234, dst_port: 8080, action: "blocked", alert_time: null, kibana_url: null,
    src_asset: null, dst_asset: { name: "Payment API", criticality: "critical" }, direction: "inbound",
    extra: {}, geo_note: null, source: "elastic", is_replay: false, ...o,
  };
}

// ---- CSV -------------------------------------------------------------------------
test("csv: quoting, and formula injection is defused", () => {
  assert.equal(csvCell("plain"), "plain");
  assert.equal(csvCell('say "hi", ok'), '"say ""hi"", ok"');
  assert.equal(csvCell("two\nlines"), '"two\nlines"');
  assert.equal(csvCell(null), "");
  assert.equal(csvCell(443), "443");
  for (const bad of ["=HYPERLINK(\"http://x\")", "+1+1", "-2+3", "@SUM(A1)", "\tcmd"]) {
    assert.ok(csvCell(bad).replace(/^"/, "").startsWith("'"), `${bad} -> ${csvCell(bad)}`);
  }
  assert.equal(csvCell("-"), "'-");
});

test("csv: header, one row per event, country filled in, CRLF line ends", () => {
  const csv = eventsToCsv([{ event: ev(), at: Date.UTC(2026, 9, 10, 12, 0, 5) }, { event: ev({ signature: "=cmd|' /C calc'!A0" }), at: Date.UTC(2026, 9, 10, 12, 0, 6) }]);
  const lines = csv.trimEnd().split("\r\n");
  assert.equal(lines.length, 3);
  assert.equal(lines[0], "received_at,alert_time,severity,signature,signature_id,category,src_ip,src_port,src_country,src_system,dst_ip,dst_port,dst_system,direction,protocol,action,feed");
  assert.match(lines[1], /^2026-10-10T12:00:05\.000Z,2026-10-10T12:00:00Z,Critical,ET EXPLOIT Log4j,2034647,Attempted Admin,198\.51\.100\.1,51234,Ukraine,,10\.50\.10\.12,8080,Payment API,inbound,tcp,blocked,elastic$/);
  assert.ok(lines[2].includes(",'=cmd"));
  assert.equal(csv.endsWith("\r\n"), true);
});

// ---- history + replay -------------------------------------------------------------
test("history keeps only the recent window and a size cap", () => {
  const h = new EventHistory(10_000, 3);
  h.add(ev({ id: "a" }), 0);
  h.add(ev({ id: "b" }), 5_000);
  h.add(ev({ id: "c" }), 12_000);              // "a" is older than the window
  assert.deepEqual(h.last(60_000, 12_000).map((b) => b.event.id), ["b", "c"]);
  h.add(ev({ id: "d" }), 12_500); h.add(ev({ id: "e" }), 13_000); // cap of 3 drops the oldest
  assert.deepEqual(h.last(60_000, 13_000).map((b) => b.event.id), ["c", "d", "e"]);
  assert.deepEqual(h.last(400, 13_000).map((b) => b.event.id), ["e"]);
});

test("replay plays at speed, in order, and stops itself", () => {
  const items = [0, 10_000, 20_000, 60_000].map((at, i) => ({ event: ev({ id: String(i) }), at: 1_000_000 + at }));
  const r = new Replayer();
  assert.equal(r.start(items, 10, 5_000), true);
  assert.equal(r.totalMs, 6_000);                                    // 60s of history at 10x
  assert.deepEqual(r.tick(5_000).map((b) => b.event.id), ["0"]);     // first event is due at once
  assert.deepEqual(r.tick(5_500).map((b) => b.event.id), []);        // 0.5s real = 5s of history
  assert.deepEqual(r.tick(6_000).map((b) => b.event.id), ["1"]);     // 10s of history
  assert.deepEqual(r.tick(7_100).map((b) => b.event.id), ["2"]);
  assert.ok(r.playing && r.progress === 0.75);
  assert.deepEqual(r.tick(11_000).map((b) => b.event.id), ["3"]);
  assert.equal(r.playing, false);
  assert.deepEqual(r.tick(12_000), []);
});

test("replay: nothing to play, stop, and restart", () => {
  const r = new Replayer();
  assert.equal(r.start([], 10, 0), false);
  assert.equal(r.playing, false);
  const items = [{ event: ev(), at: 0 }];
  r.start(items, 5, 0);
  r.stop();
  assert.deepEqual(r.tick(1_000), []);
  assert.equal(r.start(items, 5, 2_000), true);
  assert.equal(r.tick(2_000).length, 1);
});

// ---- alerts ----------------------------------------------------------------------
function envSpy() {
  const log: string[] = [];
  let answer: "granted" | "denied" | "default" | "unsupported" = "granted";
  const env: AlertEnv = {
    requestNotifications: async () => answer,
    notify: (t, b) => log.push(`notify:${t}|${b}`),
    beep: () => log.push("beep"),
  };
  return { env, log, setAnswer: (a: typeof answer) => { answer = a; } };
}

test("alert gate: worthy events only, rate limited, same flow suppressed", () => {
  const g = new AlertGate(() => true, 15_000, 120_000);
  assert.equal(g.shouldAlert(ev({ severity: "major" }), 0), false);
  assert.equal(g.shouldAlert(ev({ dst_asset: null }), 0), false);     // assets configured: needs a key system
  assert.equal(g.shouldAlert(ev(), 0), true);
  assert.equal(g.shouldAlert(ev({ signature: "other" }), 5_000), false);   // inside the 15s gap
  assert.equal(g.shouldAlert(ev(), 20_000), false);                        // same flow within 2 minutes
  assert.equal(g.shouldAlert(ev({ signature: "other" }), 20_000), true);
  assert.equal(g.shouldAlert(ev(), 200_000), true);                        // long enough ago
});

test("alerter: off by default, asks permission on enable, beeps as a test, notifies when granted", async () => {
  const { env, log } = envSpy();
  const a = new Alerter(new AlertGate(() => true), env);
  a.offer(ev(), 0);
  assert.deepEqual(log, []);                  // off: silent
  await a.setEnabled(true);
  assert.equal(a.permission, "on");
  assert.deepEqual(log, ["beep"]);            // the test beep
  a.offer(ev(), 1_000);
  assert.deepEqual(log, ["beep", "beep", "notify:Sightline: ET EXPLOIT Log4j|198.51.100.1 → Payment API"]);
  await a.setEnabled(false);
  a.offer(ev({ signature: "x" }), 100_000);
  assert.equal(log.length, 3);
});

test("alerter: denied notifications still give sound", async () => {
  const { env, log, setAnswer } = envSpy();
  setAnswer("denied");
  const a = new Alerter(new AlertGate(() => true), env);
  await a.setEnabled(true);
  assert.equal(a.permission, "sound-only");
  a.offer(ev(), 1_000);
  assert.ok(!log.some((l) => l.startsWith("notify")));
  assert.equal(log.filter((l) => l === "beep").length, 2);
});

// ---- known-good entry text and chip combining ------------------------------------
import { combineQueries, builtinChips } from "../src/filterChips";
import { knownGoodEntry } from "../src/detailPanel";
import { compileQuery } from "../src/kql";

test("known-good entry is YAML that pastes under sources:", () => {
  assert.equal(knownGoodEntry("203.0.113.7", null), "  - ip: 203.0.113.7\n    note: ");
  assert.equal(knownGoodEntry("203.0.113.7", "Partner \"A\" gateway"), '  - ip: 203.0.113.7\n    note: "Partner \\"A\\" gateway"');
  assert.equal(knownGoodEntry("2001:db8::5", null), "  - ip: 2001:db8::5\n    note: ");
  assert.match(knownGoodEntry("evil: {x}\n- ip: 1.1.1.1", null), /ip: "evil: \{x\}\\n- ip: 1\.1\.1\.1"/); // never lets text break out of the line
});

test("chips: parts are ANDed and parenthesised; built-ins compile and match", () => {
  assert.equal(combineQueries("", []), "");
  assert.equal(combineQueries("  a:1 ", []), "a:1");
  assert.equal(combineQueries("", [{ query: "direction:inbound" }]), "direction:inbound");
  assert.equal(combineQueries("src_ip:1.1.1.1 or src_ip:2.2.2.2", [{ query: "direction:inbound" }]), "(src_ip:1.1.1.1 or src_ip:2.2.2.2) and (direction:inbound)");
  // the parentheses matter: without them the 'or' would swallow the chip
  const q = compileQuery(combineQueries("src_ip:1.1.1.1 or src_ip:2.2.2.2", [{ query: "direction:inbound" }])).test;
  assert.equal(q(ev({ src_ip: "2.2.2.2", direction: "outbound" })), false);
  assert.equal(q(ev({ src_ip: "2.2.2.2", direction: "inbound" })), true);

  const by = Object.fromEntries(builtinChips().map((c) => [c.id, compileQuery(c.query).test]));
  assert.ok(by.worst(ev()) && !by.worst(ev({ severity: "major" })));
  assert.ok(by.key(ev()) && !by.key(ev({ dst_asset: null })));
  assert.ok(by.unusual(ev({ anomaly: { score: 80, level: "unusual", reasons: [], learning: false } })) && !by.unusual(ev({ anomaly: { score: 50, level: "uncommon", reasons: [], learning: false } })) && !by.unusual(ev()));
  assert.ok(compileQuery("anomaly:unusual").test(ev({ anomaly: { score: 90, level: "unusual", reasons: [], learning: false } })));
  assert.ok(by.inbound(ev()) && !by.inbound(ev({ direction: "internal" })));
  assert.ok(by.blocked(ev({ action: "blocked" })) && by.blocked(ev({ action: "denied" })) && by.blocked(ev({ action: "DROP" })) && !by.blocked(ev({ action: "allowed" })));
});
