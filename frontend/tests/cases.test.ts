import assert from "node:assert/strict";
import test from "node:test";
import { CaseEvent, CaseStore, caseMarkdown, MAX_CASES, MAX_ITEMS, parseCases, utc } from "../src/cases";
import { campaignId, campaignQuery, campaignText, campaignTitle, FanIn, FanOut } from "../src/campaigns";
import { ContainmentStore } from "../src/containment";
import { tryCompile } from "../src/kql";
import { TrafficEvent } from "../src/types";

const mem = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); } }; };
const evt = (o: Partial<CaseEvent> = {}): CaseEvent => ({ kind: "event", id: "1.1.1.1|10.0.0.1|Sig", src: "1.1.1.1", dst: "10.0.0.1", srcName: null, dstName: "Web 1",
  signature: "Sig", severity: "critical", first: Date.UTC(2026, 0, 2, 3, 4, 5), last: Date.UTC(2026, 0, 2, 3, 9, 5), count: 4, score: 80, addedAt: 1, ...o });

test("a case is started on first add, items dedupe by id, and it all survives a reload", () => {
  const s = mem();
  const a = new CaseStore(s, () => 1000);
  assert.equal(a.active, null);
  assert.ok(a.add(evt()));
  assert.equal(a.active?.name, "Case 1");
  a.add(evt({ count: 9 }));
  assert.equal(a.active?.items.length, 1);
  assert.equal((a.active?.items[0] as CaseEvent).count, 9);
  const b = new CaseStore(s);
  assert.equal(b.active?.items.length, 1);
  assert.ok(b.has("1.1.1.1|10.0.0.1|Sig"));
});

test("cases: naming, switching, removing, and the limits", () => {
  const a = new CaseStore(mem());
  const c1 = a.create("Phishing")!; const c2 = a.create()!;
  assert.equal(c2.name, "Case 1");
  assert.equal(a.active?.id, c2.id);
  a.setActive(c1.id); assert.equal(a.active?.name, "Phishing");
  a.rename(c1.id, "  Phishing wave  "); assert.equal(a.active?.name, "Phishing wave");
  a.remove(c1.id); assert.equal(a.active?.id, c2.id);
  for (let i = 0; i < MAX_CASES; i++) a.create();
  assert.equal(a.cases.length, MAX_CASES); assert.equal(a.create(), null);
  const b = new CaseStore(mem());
  for (let i = 0; i < MAX_ITEMS; i++) assert.ok(b.add(evt({ id: `k${i}` })));
  assert.equal(b.add(evt({ id: "one-too-many" })), false);
});

test("garbage in storage does not break anything", () => {
  assert.deepEqual(parseCases("x"), { cases: [], active: null });
  assert.equal(parseCases({ cases: [{ id: "a", name: 5, items: [{ kind: "event" }, null, { kind: "summary", id: "s", title: "t", text: "x" }] }], active: "zzz" }).cases[0].items.length, 1);
  assert.equal(new CaseStore({ getItem: () => "{bad", setItem: () => {} }).cases.length, 0);
});

test("markdown export: UTC times, sorted, escaped, with notes and response status", () => {
  const s = new CaseStore(mem());
  s.add(evt({ id: "late", first: Date.UTC(2026, 0, 2, 5, 0, 0), signature: "Pipe | in\nname", count: 1 }));
  s.add(evt());
  s.add({ kind: "summary", id: "campaign:out:1.1.1.1", title: "Sweep", text: "One source, 5 targets.", severity: "high", first: Date.UTC(2026, 0, 2, 3, 0, 0), last: Date.UTC(2026, 0, 2, 4, 0, 0), addedAt: 3 });
  const md = caseMarkdown(s.active!, { label: (i) => i.toUpperCase(), note: (k) => (k === "late" ? "called owner" : ""), status: (ip) => (ip === "1.1.1.1" ? { label: "Blocked", by: "sam", at: "2026-01-02T05:30:00+00:00", note: "edge fw" } : null) });
  assert.match(md, /^# Case 1\n/);
  assert.match(md, /all times UTC/);
  const rows = md.split("\n").filter((l) => l.startsWith("| 2026"));
  assert.equal(rows.length, 2);
  assert.ok(rows[0].startsWith("| 2026-01-02 03:04:05 | 2026-01-02 03:09:05 | CRITICAL | 1.1.1.1 | Web 1 (10.0.0.1) | Sig | 4 |"), rows[0]);
  assert.match(rows[1], /Pipe \\\| in name/);
  assert.match(rows[1], /called owner/);
  assert.match(md, /## Context\n\n- \*\*Sweep\*\*/);
  assert.match(md, /- 1\.1\.1\.1: Blocked by sam at 2026-01-02 05:30:00 UTC \(edge fw\)/);
  assert.equal(utc(0), "");
});

const out: FanOut = { kind: "fan-out", src_ip: "6.6.6.6", events: 12, distinct: 5, severity: "high", first: "", last: "", targets: [{ name: "Web 1", n: 4 }, { name: "10.0.0.9", n: 3 }], signatures: [{ name: "Sweep", n: 12 }] };
const inn: FanIn = { kind: "fan-in", target: "Web 1", dst_ip: "10.0.0.5", signature: 'ET "bad" thing', events: 30, distinct: 8, severity: "critical", first: "", last: "", sources: [{ name: "1.1.1.1", n: 9 }] };

test("campaign queries compile and match exactly the activity they describe", () => {
  const ev = (o: Partial<TrafficEvent>) => ({ id: "x", timestamp: "2026-01-01T00:00:00Z", src_lat: 0, src_lon: 0, dst_lat: 0, dst_lon: 0, severity: "high", count: 1, src_ip: "9.9.9.9", dst_ip: "10.0.0.5",
    signature: 'ET "bad" thing', signature_id: null, category: null, protocol: null, src_port: null, dst_port: null, action: null, alert_time: null, kibana_url: null,
    src_asset: null, dst_asset: { name: "Web 1", criticality: "high" }, direction: null, extra: {}, geo_note: null, source: "csv", is_replay: false, ...o }) as TrafficEvent;
  const q1 = tryCompile(campaignQuery(out)); assert.ok(q1.ok && q1.query.test(ev({ src_ip: "6.6.6.6" })) && !q1.query.test(ev({})));
  const q2 = tryCompile(campaignQuery(inn)); assert.ok(q2.ok && q2.query.test(ev({})) && !q2.query.test(ev({ signature: "other" })));
  const bare = tryCompile(campaignQuery({ ...inn, target: "10.0.0.5" })); assert.ok(bare.ok && bare.query.test(ev({ dst_asset: null })));
  assert.equal(campaignTitle(out), "6.6.6.6 reached 5 different targets");
  assert.match(campaignText(inn, (s) => s.toUpperCase()), /8 sources, 30 events .* CRITICAL/);
  assert.notEqual(campaignId(out), campaignId(inn));
});

test("containment store: only valid entries, announces real changes", () => {
  const c = new ContainmentStore(); let n = 0; c.onChange = () => { n++; };
  const row = { ip: "1.1.1.1", status: "blocked" as const, note: "fw", by: "sam", at: "t" };
  c.setEntries([row, { ...row, ip: "2.2.2.2", status: "bogus" as never }]);
  c.setEntries([row]);
  assert.equal(c.size, 1); assert.equal(c.get("1.1.1.1")?.status, "blocked"); assert.equal(c.get("2.2.2.2"), null); assert.equal(n, 1);
});

test("containment edits send the page header and surface the server's reason", async () => {
  const c = new ContainmentStore(); let seen: RequestInit | undefined;
  const f = (async (_u: string, init: RequestInit) => { seen = init; return { ok: false, status: 401, json: async () => ({ detail: "Sign-in required." }) }; }) as unknown as typeof fetch;
  assert.equal(await c.set("1.1.1.1", "blocked", "", f), "Sign-in required.");
  assert.equal((seen?.headers as Record<string, string>)["x-sightline-edit"], "1");
});

test("a case item's id turns back into the search that shows it", async () => {
  const { queryForItemId } = await import("../src/campaigns");
  assert.equal(queryForItemId("source:1.2.3.4"), "src_ip:1.2.3.4");
  assert.equal(queryForItemId("campaign:out:6.6.6.6"), "src_ip:6.6.6.6");
  assert.equal(queryForItemId("campaign:in:Web 1|Brute"), 'dst_asset:"Web 1" and signature:Brute');
  assert.equal(queryForItemId("campaign:in:10.0.0.5|Brute"), "dst_ip:10.0.0.5 and signature:Brute");
  assert.equal(queryForItemId("1.1.1.1|10.0.0.1|ET SCAN"), 'src_ip:1.1.1.1 and dst_ip:10.0.0.1 and signature:"ET SCAN"');
  assert.equal(queryForItemId("nonsense"), null);
});
