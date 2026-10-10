import assert from "node:assert/strict";
import { test } from "node:test";
import { isSpotlightWorthy, SpotlightCard, SpotlightController } from "../src/spotlight";
import { TrafficEvent } from "../src/types";

function ev(o: Partial<TrafficEvent> = {}): TrafficEvent {
  return {
    id: "1", timestamp: "", src_lat: 50.45, src_lon: 30.52, dst_lat: 36, dst_lon: -84, severity: "critical", count: 1,
    src_ip: "198.51.100.1", dst_ip: "10.50.10.12", signature: "ET EXPLOIT Log4j", signature_id: null, category: null,
    protocol: null, src_port: null, dst_port: null, action: null, alert_time: null, kibana_url: null,
    src_asset: null, dst_asset: { name: "Payment API", criticality: "critical" }, direction: "inbound",
    extra: {}, geo_note: null, source: "elastic", is_replay: false, ...o,
  };
}
const S = 1000;

test("worthy: top severity only; key assets only when assets are configured", () => {
  assert.ok(isSpotlightWorthy(ev(), true));
  assert.ok(!isSpotlightWorthy(ev({ severity: "major" }), true));
  assert.ok(!isSpotlightWorthy(ev({ severity: "unknown" }), false));
  assert.ok(!isSpotlightWorthy(ev({ dst_asset: { name: "Lab", criticality: "normal" } }), true)); // not key
  assert.ok(isSpotlightWorthy(ev({ dst_asset: null }), false)); // no names configured: any top-level event
  assert.ok(isSpotlightWorthy(ev({ dst_asset: null, src_asset: { name: "Plant", criticality: "high" } }), true)); // key at the source end
});

test("shows a card, expires it, and names the country", () => {
  const seen: (SpotlightCard | null)[] = [];
  const c = new SpotlightController(() => true);
  c.onChange = (x) => seen.push(x);
  c.offer(ev(), 100 * S);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.country, "Ukraine");
  assert.ok(seen[0]!.keyAsset);
  c.tick(105 * S);
  assert.ok(c.current);               // still up
  c.tick(110 * S);
  assert.equal(c.current, null);      // gone after 10s
  assert.equal(seen.at(-1), null);
});

test("ignores events that don't qualify", () => {
  const c = new SpotlightController(() => true);
  c.offer(ev({ severity: "high" }), 0);
  c.offer(ev({ dst_asset: null }), 0);
  assert.equal(c.current, null);
});

test("one at a time: the best waiting card is shown after the gap", () => {
  const shown: string[] = [];
  const c = new SpotlightController(() => true);
  c.onChange = (x) => { if (x) shown.push(x.event.signature!); };
  c.offer(ev({ signature: "first" }), 0);
  c.offer(ev({ signature: "ordinary", dst_asset: null, src_asset: { name: "Plant", criticality: "high" } }), 1 * S);
  c.offer(ev({ signature: "key-asset hit" }), 2 * S);   // key DESTINATION beats the ordinary one
  c.offer(ev({ signature: "later ordinary", dst_asset: null, src_asset: { name: "Plant", criticality: "high" } }), 3 * S);
  assert.deepEqual(shown, ["first"]);
  c.tick(10 * S);                    // first expires
  assert.deepEqual(shown, ["first"]);
  c.tick(12 * S);                    // still inside the 3s gap
  assert.deepEqual(shown, ["first"]);
  c.tick(13 * S);
  assert.deepEqual(shown, ["first", "key-asset hit"]);
});

test("the same flow is not repeated for a minute, even after its card is gone", () => {
  const shown: number[] = [];
  const c = new SpotlightController(() => true);
  c.onChange = (x) => { if (x) shown.push(x.shownAt); };
  c.offer(ev(), 0);
  c.tick(10 * S);
  c.offer(ev(), 20 * S);             // same src/dst/signature
  assert.deepEqual(shown, [0]);
  c.offer(ev(), 61 * S);
  assert.deepEqual(shown, [0, 61 * S]);
  c.offer(ev(), 62 * S);             // currently showing: not queued behind itself
  c.tick(80 * S);
  assert.equal(shown.length, 2);
});

test("a source location assumed from the home site is not named as a country", () => {
  const c = new SpotlightController(() => true);
  c.offer(ev({ src_lat: 36.0104, src_lon: -84.2696, geo_note: "source location assumed: Oak Ridge (no location in the data)" }), 0);
  assert.equal(c.current!.country, null);
});
