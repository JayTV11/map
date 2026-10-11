import test from "node:test";
import assert from "node:assert/strict";
import { MAX_VIEWS, PRESETS, ViewStore, buildShareUrl, defaultView, paramsToView, parseSavedViews, parseViewState, viewToParams } from "../src/views";

function memory(initial: Record<string, string> = {}) {
  const data = { ...initial };
  return { data, getItem: (k: string) => data[k] ?? null, setItem: (k: string, v: string) => { data[k] = v; } };
}

test("the default view writes no parameters", () => {
  assert.deepEqual(viewToParams(defaultView()), {});
});

test("a view survives a trip through URL parameters", () => {
  const v = { q: "src_ip:10.0.0.0/8", chips: ["key", "unusual"], mute: false, sort: "unusual" as const, group: "country" as const, hideReviewed: true };
  const url = buildShareUrl("https://sightline.example/?kiosk=1&tour=0#x", v);
  assert.ok(!url.includes("kiosk") && !url.includes("#"));
  assert.deepEqual(paramsToView(new URL(url).searchParams), v);
});

test("unknown or hostile values fall back to defaults", () => {
  const v = parseViewState({ q: 5, chips: [1, "ok"], mute: "no", sort: "drop table", group: {}, hideReviewed: 1 });
  assert.deepEqual(v, { ...defaultView(), chips: ["ok"] });
  assert.deepEqual(parseViewState(null), defaultView());
});

test("presets are valid views", () => {
  for (const p of PRESETS) assert.deepEqual(parseViewState(p.view), p.view);
  assert.ok(PRESETS.length >= 3);
});

test("saved views persist, replace by name and remove", () => {
  const m = memory();
  const s = new ViewStore(m);
  assert.equal(s.save("Mine", { ...defaultView(), sort: "severity" }), true);
  assert.equal(s.save("Mine", { ...defaultView(), sort: "repeats" }), true);
  assert.equal(s.list().length, 1);
  assert.equal(new ViewStore(m).list()[0].view.sort, "repeats");
  s.remove("Mine");
  assert.equal(s.list().length, 0);
  assert.equal(s.save("   ", defaultView()), false);
});

test("the view limit is enforced", () => {
  const s = new ViewStore(memory());
  for (let i = 0; i < MAX_VIEWS; i++) assert.equal(s.save(`v${i}`, defaultView()), true);
  assert.equal(s.save("one too many", defaultView()), false);
  assert.equal(s.save("v3", defaultView()), true); // replacing by name is still fine
});

test("export then import round-trips, including the panel layout", () => {
  const a = new ViewStore(memory());
  a.save("Night", { ...defaultView(), q: "severity:critical" }, { order: ["a", "b"], collapsed: { a: true }, heights: {} });
  const text = a.exportJson();
  const b = new ViewStore(memory());
  assert.equal(b.importJson(text), 1);
  assert.equal(b.list()[0].view.q, "severity:critical");
  assert.deepEqual(b.list()[0].layout?.collapsed, { a: true });
});

test("garbage imports add nothing", () => {
  const s = new ViewStore(memory());
  assert.equal(s.importJson("not json"), 0);
  assert.equal(s.importJson('{"views":"x"}'), 0);
  assert.equal(s.importJson('{"views":[{"name":""},5,null]}'), 0);
  assert.deepEqual(parseSavedViews(undefined), []);
});
