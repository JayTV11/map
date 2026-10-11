import test from "node:test";
import assert from "node:assert/strict";
import { MAX_ENTRIES, MAX_NOTE, ReviewStore, parseReviews } from "../src/reviews";

function memory(initial: Record<string, string> = {}) {
  const data = { ...initial };
  return { data, getItem: (k: string) => data[k] ?? null, setItem: (k: string, v: string) => { data[k] = v; } };
}

test("marks and notes persist and reload", () => {
  const m = memory();
  const a = new ReviewStore(m);
  a.set("k1", { reviewed: true });
  a.set("k2", { note: "ask the web team" });
  const b = new ReviewStore(m);
  assert.equal(b.isReviewed("k1"), true);
  assert.equal(b.hasNote("k2"), true);
  assert.equal(b.isReviewed("k2"), false);
});

test("clearing both the mark and the note removes the entry", () => {
  const s = new ReviewStore(memory());
  s.set("k", { reviewed: true, note: "x" });
  s.set("k", { reviewed: false, note: "" });
  assert.equal(s.size, 0);
});

test("a patch changes only what it names", () => {
  const s = new ReviewStore(memory());
  s.set("k", { note: "keep me" });
  s.set("k", { reviewed: true });
  assert.equal(s.get("k")?.note, "keep me");
});

test("notes are length-limited and the oldest entries are dropped past the cap", () => {
  const s = new ReviewStore(memory());
  s.set("long", { note: "x".repeat(MAX_NOTE + 50) });
  assert.equal(s.get("long")?.note.length, MAX_NOTE);
  for (let i = 0; i < MAX_ENTRIES + 5; i++) s.set(`k${i}`, { reviewed: true });
  assert.equal(s.size, MAX_ENTRIES);
  assert.equal(s.get("long"), undefined);
  assert.equal(s.isReviewed(`k${MAX_ENTRIES + 4}`), true);
});

test("subscribers hear which key changed", () => {
  const s = new ReviewStore(memory());
  const seen: string[] = [];
  s.subscribe((k) => seen.push(k));
  s.set("a", { reviewed: true });
  assert.deepEqual(seen, ["a"]);
});

test("corrupted or hostile storage is ignored", () => {
  assert.equal(parseReviews("nope").size, 0);
  assert.equal(parseReviews([1, 2]).size, 0);
  assert.equal(parseReviews({ a: 5, b: { reviewed: "yes" }, c: { reviewed: true } }).size, 1);
  const s = new ReviewStore(memory({ "sightline:reviews": "{not json" }));
  assert.equal(s.size, 0);
});

test("works with no storage at all", () => {
  const s = new ReviewStore(null);
  s.set("k", { reviewed: true });
  assert.equal(s.isReviewed("k"), true);
});
