import assert from "node:assert/strict";
import test from "node:test";
import { fillLink, linksFor } from "../src/links";
import { SignatureNotes } from "../src/signatureNotes";
import { SourceHistoryStore } from "../src/sourceHistory";
import { TrafficEvent } from "../src/types";

const ev = (o: Partial<TrafficEvent> = {}): TrafficEvent => ({
  id: "x", timestamp: "2026-01-01T00:00:00Z", src_lat: 0, src_lon: 0, dst_lat: 0, dst_lon: 0, severity: "critical", count: 1,
  src_ip: "203.0.113.5", dst_ip: "10.0.0.8", signature: "ET SCAN Nessus & co", signature_id: "2100", category: null, protocol: null,
  src_port: 4444, dst_port: 80, action: null, alert_time: null, kibana_url: null, src_asset: null, dst_asset: { name: "Web 1", criticality: "high" },
  direction: null, extra: {}, geo_note: null, source: "csv", is_replay: false, ...o,
});

test("links fill placeholders URL-encoded", () => {
  const u = fillLink({ label: "t", url: "https://t.test/new?s={signature}&a={src_ip}&d={dst_asset}" }, ev());
  assert.equal(u, "https://t.test/new?s=ET%20SCAN%20Nessus%20%26%20co&a=203.0.113.5&d=Web%201");
});

test("a value cannot break out of the URL", () => {
  const u = fillLink({ label: "t", url: "https://t.test/?q={signature}" }, ev({ signature: "x&evil=1#frag" }));
  assert.equal(u, "https://t.test/?q=x%26evil%3D1%23frag");
});

test("non-http links are refused", () => {
  assert.equal(fillLink({ label: "t", url: "javascript:alert(1)" }, ev()), null);
  assert.equal(fillLink({ label: "t", url: "{signature}" }, ev({ signature: "javascript:alert(1)" })), null);
});

test("public_only hides links for private or missing addresses", () => {
  const spec = { label: "vt", url: "https://vt.test/{src_ip}", public_only: true };
  assert.ok(fillLink(spec, ev()));
  assert.equal(fillLink(spec, ev({ src_ip: "10.1.1.1" })), null);
  assert.equal(fillLink(spec, ev({ src_ip: null })), null);
  assert.equal(linksFor([spec, { label: "all", url: "https://x.test/" }], ev({ src_ip: "192.168.0.1" })).length, 1);
});

test("signature notes: exact beats pattern, longer pattern beats shorter, id beats all", () => {
  const n = new SignatureNotes();
  n.setNotes([
    { match: "ET *", what: "generic" },
    { match: "ET SCAN*", what: "scan" },
    { match: "ET SCAN Nessus", what: "nessus exact" },
    { id: "2100", what: "by id" },
  ]);
  assert.equal(n.find("ET SCAN Nessus", "1")?.what, "nessus exact");
  assert.equal(n.find("ET SCAN Nessus", "2100")?.what, "by id");
  assert.equal(n.find("ET SCAN Other")?.what, "scan");
  assert.equal(n.find("ET POLICY x")?.what, "generic");
  assert.equal(n.find("Other thing"), null);
  assert.equal(n.find("  et scan   nessus ")?.what, "nessus exact");
  assert.equal(n.find(null), null);
});

test("signature notes only announce real changes", () => {
  const n = new SignatureNotes();
  let calls = 0;
  n.onChange = () => { calls++; };
  n.setNotes([{ match: "a", what: "b" }]);
  n.setNotes([{ match: "a", what: "b" }]);
  assert.equal(calls, 1);
});

test("source history is cached for a short while and announces arrivals once", async () => {
  let t = 1000, fetches = 0;
  const body = { source: "live", history: { ip: "1.1.1.1", events: 3 } };
  const store = new SourceHistoryStore(() => t, (async () => { fetches++; return { ok: true, status: 200, json: async () => body }; }) as unknown as typeof fetch);
  const seen: string[] = [];
  store.onChange = (ip) => seen.push(ip);
  assert.equal(store.get("1.1.1.1").state, "loading");
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(store.get("1.1.1.1").state, "ready");
  assert.equal(fetches, 1);
  t += 5_000;
  store.get("1.1.1.1");
  assert.equal(fetches, 1, "still fresh");
  t += 20_000;
  store.get("1.1.1.1");
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(fetches, 2);
  assert.deepEqual(seen, ["1.1.1.1"], "an unchanged answer does not redraw");
});

test("source history failure and not-found are states, not exceptions", async () => {
  const bad = new SourceHistoryStore(() => 0, (async () => { throw new Error("down"); }) as unknown as typeof fetch);
  bad.get("2.2.2.2");
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(bad.get("2.2.2.2").state, "error");
  const none = new SourceHistoryStore(() => 0, (async () => ({ ok: true, status: 200, json: async () => ({ source: null, history: null }) })) as unknown as typeof fetch);
  none.get("3.3.3.3");
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(none.get("3.3.3.3").state, "none");
});
