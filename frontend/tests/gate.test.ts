import assert from "node:assert/strict";
import { test } from "node:test";
import { EventGate } from "../src/gate";
import { compileQuery } from "../src/kql";
import { KnownGoodList } from "../src/knownGood";
import { TrafficEvent } from "../src/types";

// knownGood.refresh uses window.setTimeout; give Node a window.
(globalThis as unknown as { window: unknown }).window = globalThis;

function ev(src: string, o: Partial<TrafficEvent> = {}): TrafficEvent {
  return {
    id: "1", timestamp: "2026-10-10T00:00:00Z", src_lat: 0, src_lon: 0, dst_lat: 0, dst_lon: 0,
    severity: "critical", count: 1, src_ip: src, dst_ip: "10.50.10.12", signature: "ET SCAN", signature_id: null,
    category: null, protocol: "tcp", src_port: null, dst_port: 443, action: null, alert_time: null, kibana_url: null,
    src_asset: null, dst_asset: null, direction: null, extra: {}, geo_note: null, source: "elastic", is_replay: false, ...o,
  };
}

const jsonResp = (body: unknown, status = 200) =>
  Promise.resolve({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) } as Response);

test("known-good list matches singles and ranges, v4 and v6", () => {
  const kg = new KnownGoodList();
  kg.setEntries([
    { cidr: "10.20.5.14", note: "Scanner" },
    { cidr: "10.20.9.0/24", note: "Probes" },
    { cidr: "2001:db8::/32", note: "" },
    { cidr: "not an ip", note: "ignored" },
  ]);
  assert.equal(kg.size, 3);
  assert.ok(kg.matches("10.20.5.14") && kg.matches("10.20.9.77") && kg.matches("2001:db8::9"));
  assert.ok(!kg.matches("10.20.5.15") && !kg.matches(null) && !kg.matches("") && !kg.matches("junk"));
  assert.equal(kg.find("10.20.9.77")?.note, "Probes");
  assert.ok(kg.matches("::ffff:10.20.5.14")); // mapped v4 form of a listed host
});

test("gate: muted by default, mute wins, filter hides the rest", () => {
  const kg = new KnownGoodList();
  kg.setEntries([{ cidr: "10.20.9.0/24", note: "" }]);
  const gate = new EventGate(kg);
  assert.equal(gate.muteEnabled, true); // default on
  assert.equal(gate.verdict(ev("10.20.9.5")), "muted");
  assert.equal(gate.verdict(ev("203.0.113.7")), "pass");

  gate.setQuery(compileQuery("src_ip:203.0.113.0/24"), "src_ip:203.0.113.0/24");
  assert.equal(gate.verdict(ev("198.51.100.1")), "filtered");
  assert.equal(gate.verdict(ev("203.0.113.7")), "pass");
  assert.equal(gate.verdict(ev("10.20.9.5")), "muted"); // both apply: counted as muted

  gate.setMute(false);
  assert.equal(gate.verdict(ev("10.20.9.5")), "filtered"); // un-muted, but the filter still excludes it
  gate.setQuery(null);
  assert.equal(gate.verdict(ev("10.20.9.5")), "pass");
  assert.equal(gate.hasQuery, false);
});

test("gate: counts, resets filter count on a new query, ignores replays by contract", () => {
  const kg = new KnownGoodList();
  const gate = new EventGate(kg);
  gate.count("muted"); gate.count("muted"); gate.count("filtered"); gate.count("pass");
  assert.equal(gate.mutedCount, 2);
  assert.equal(gate.filteredCount, 1);
  gate.setQuery(compileQuery("protocol:udp"), "protocol:udp");
  assert.equal(gate.filteredCount, 0);
  gate.count("filtered");
  gate.setQuery(compileQuery("protocol:udp"), "protocol:udp "); // same query again: keep the count
  assert.equal(gate.filteredCount, 1);
  assert.equal(gate.activeQuery, "protocol:udp");
  gate.setQuery(compileQuery("   "), "   "); // blank = no filter
  assert.equal(gate.hasQuery, false);
});

test("gate: onChange fires for mute, query and list changes, not for no-ops", () => {
  const kg = new KnownGoodList();
  const gate = new EventGate(kg);
  let n = 0;
  gate.onChange = () => { n += 1; };
  kg.onChange = () => gate.listChanged();
  gate.setMute(true); // already on
  assert.equal(n, 0);
  gate.setMute(false); gate.setMute(true);
  assert.equal(n, 2);
  gate.setQuery(compileQuery("protocol:tcp"), "protocol:tcp");
  assert.equal(n, 3);
  kg.setEntries([{ cidr: "10.0.0.1", note: "" }]);
  assert.equal(n, 4);
  kg.setEntries([{ cidr: "10.0.0.1", note: "" }]); // identical reload
  assert.equal(n, 4);
});

test("refresh: loads the list, keeps the old one on failure, handles old backends", async () => {
  const kg = new KnownGoodList();
  let changes = 0;
  kg.onChange = () => { changes += 1; };

  await kg.refresh(() => jsonResp({ entries: [{ cidr: "10.0.0.1", note: "a" }], error: "1 entry skipped (see server log)" }));
  assert.equal(kg.size, 1);
  assert.equal(kg.serverError, "1 entry skipped (see server log)");
  assert.equal(changes, 1);

  await kg.refresh(() => jsonResp({ entries: [{ cidr: "10.0.0.1", note: "a" }], error: "1 entry skipped (see server log)" }));
  assert.equal(changes, 1); // unchanged

  await kg.refresh(() => Promise.reject(new Error("network down")));
  assert.equal(kg.size, 1); // still muting
  assert.ok(kg.loadFailed);
  await kg.refresh(() => jsonResp({}, 500));
  assert.equal(kg.size, 1);

  await kg.refresh(() => jsonResp({ entries: [{ cidr: "10.0.0.2", note: "" }] }));
  assert.ok(!kg.loadFailed && kg.matches("10.0.0.2") && !kg.matches("10.0.0.1"));

  await kg.refresh(() => jsonResp({}, 404)); // older backend without the endpoint
  assert.equal(kg.size, 0);
  assert.ok(!kg.loadFailed);

  await kg.refresh(() => jsonResp({ entries: "garbage" }));
  assert.equal(kg.size, 0);
});
