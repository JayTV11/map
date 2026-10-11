import test from "node:test";
import assert from "node:assert/strict";
import { KnownGoodList } from "../src/knownGood";

// knownGood.refresh uses window.setTimeout; give Node a window.
(globalThis as unknown as { window: unknown }).window = globalThis;

type Call = { url: string; init?: RequestInit };

/** A fake server: remembers the list, answers like the backend does. */
function fakeServer(editable = true) {
  const calls: Call[] = [];
  const entries: { cidr: string; note: string; source: string; added_by?: string }[] = [{ cidr: "10.9.9.9", note: "scanner", source: "file" }];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const method = init?.method ?? "GET";
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
    if (method === "GET") return json(200, { entries, editable, loaded: true, count: entries.length, error: null });
    if ((init?.headers as Record<string, string>)["x-sightline-edit"] !== "1") return json(403, { detail: "Edit requests must come from the Sightline page." });
    if (!editable) return json(403, { detail: "Editing the known-good list from the screen is turned off." });
    if (method === "POST") {
      const b = JSON.parse(String(init?.body));
      if (b.ip === "bad") return json(400, { detail: "That is not a valid IP address or range." });
      entries.push({ cidr: b.ip, note: b.note, source: "analyst", added_by: "ana" });
      return json(200, { cidr: b.ip, note: b.note });
    }
    const cidr = new URL(String(url), "http://x").searchParams.get("cidr");
    const i = entries.findIndex((e) => e.cidr === cidr && e.source === "analyst");
    if (i < 0) return json(400, { detail: "That source is not on the list." });
    entries.splice(i, 1);
    return json(200, { removed: cidr });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

test("the list reads whether editing is on and keeps where each entry came from", async () => {
  const s = fakeServer();
  const kg = new KnownGoodList();
  await kg.refresh(s.fetchImpl);
  assert.equal(kg.editable, true);
  assert.equal(kg.entries[0].source, "file");
});

test("adding sends the page's header, then the list refreshes and starts muting", async () => {
  const s = fakeServer();
  const kg = new KnownGoodList();
  await kg.refresh(s.fetchImpl);
  assert.equal(kg.matches("203.0.113.5"), false);
  assert.equal(await kg.add("203.0.113.5", "partner", s.fetchImpl), null);
  const post = s.calls.find((c) => c.init?.method === "POST")!;
  assert.equal((post.init!.headers as Record<string, string>)["x-sightline-edit"], "1");
  assert.deepEqual(JSON.parse(String(post.init!.body)), { ip: "203.0.113.5", note: "partner" });
  assert.equal(kg.matches("203.0.113.5"), true);
  assert.equal(kg.entries.find((e) => e.cidr === "203.0.113.5")?.source, "analyst");
});

test("removing an added source un-mutes it", async () => {
  const s = fakeServer();
  const kg = new KnownGoodList();
  await kg.refresh(s.fetchImpl);
  await kg.add("203.0.113.5", "", s.fetchImpl);
  assert.equal(await kg.remove("203.0.113.5", s.fetchImpl), null);
  assert.equal(kg.matches("203.0.113.5"), false);
  assert.equal(kg.matches("10.9.9.9"), true);
});

test("a refusal comes back as the server's plain-English reason and changes nothing", async () => {
  const s = fakeServer();
  const kg = new KnownGoodList();
  await kg.refresh(s.fetchImpl);
  assert.equal(await kg.add("bad", "", s.fetchImpl), "That is not a valid IP address or range.");
  assert.equal(kg.size, 1);
  const off = fakeServer(false);
  const kg2 = new KnownGoodList();
  await kg2.refresh(off.fetchImpl);
  assert.equal(kg2.editable, false);
  assert.match((await kg2.add("203.0.113.5", "", off.fetchImpl)) ?? "", /turned off/);
});

test("an unreachable server is reported and nothing is assumed", async () => {
  const kg = new KnownGoodList();
  const down = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
  assert.match((await kg.add("203.0.113.5", "", down)) ?? "", /Couldn't reach the server/);
  assert.equal(kg.size, 0);
});
