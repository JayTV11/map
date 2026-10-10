import assert from "node:assert/strict";
import { test } from "node:test";
import { Tour } from "../src/tour";

function rig(opts: { active?: boolean; idle?: number; countries?: number } = {}) {
  const log: string[] = [];
  const state = { active: opts.active ?? true, idle: opts.idle ?? 60_000 };
  const countries = [
    { name: "Russia", lat: 55, lon: 37 }, { name: "China", lat: 35, lon: 105 }, { name: "Brazil", lat: -10, lon: -50 },
  ].slice(0, opts.countries ?? 3);
  const tour = new Tour({
    active: () => state.active, idleMs: () => state.idle,
    home: () => ({ name: "Oak Ridge", lat: 36, lon: -84 }),
    topCountries: () => countries,
    focus: (lat, lon, s) => log.push(`focus ${lat},${lon} x${s}`),
    reset: () => log.push("reset"),
  });
  return { tour, log, state };
}

test("does nothing until the screen has been idle long enough", () => {
  const { tour, log, state } = rig({ idle: 5_000 });
  tour.tick(0); tour.tick(1000);
  assert.deepEqual(log, []);
  assert.equal(tour.isRunning, false);
  state.idle = 31_000;
  tour.tick(2000);
  assert.deepEqual(log, ["reset"]);
  assert.equal(tour.isRunning, true);
});

test("cycles world, home, top country, world, second, third, and dwells between", () => {
  const { tour, log } = rig();
  let t = 0;
  const run = (ms: number) => { for (let end = t + ms; t < end; t += 1000) tour.tick(t); };
  run(25_000 * 2 + 14_000 * 4 + 1000);
  assert.deepEqual(log.slice(0, 6), [
    "reset", "focus 36,-84 x3.4", "focus 55,37 x3.4", "reset", "focus 35,105 x3.4", "focus -10,-50 x3.4",
  ]);
  assert.equal(log[6], "reset"); // and around again
  // dwell times: nothing happens between stops
  const { tour: t2, log: l2 } = rig();
  t2.tick(0); t2.tick(10_000); t2.tick(24_000);
  assert.deepEqual(l2, ["reset"]);
  t2.tick(25_000);
  assert.equal(l2.length, 2);
});

test("skips countries that haven't appeared yet", () => {
  const { tour, log } = rig({ countries: 0 });
  for (let t = 0; t <= 200_000; t += 1000) tour.tick(t);
  assert.ok(log.every((l) => l === "reset" || l.startsWith("focus 36,-84")));
  assert.ok(log.length >= 4);
});

test("stops the moment someone touches the screen, and restarts after the next quiet spell", () => {
  const { tour, log, state } = rig();
  tour.tick(0);
  assert.equal(log.length, 1);
  state.idle = 500; // a person moved the mouse
  tour.tick(1000);
  assert.equal(tour.isRunning, false);
  tour.tick(40_000);
  assert.equal(log.length, 1); // it didn't move the map under them
  state.idle = 35_000;
  tour.tick(41_000);
  assert.equal(log.length, 2);
  assert.equal(log[1], "reset"); // restarts from the top
});

test("does not run outside wall mode", () => {
  const { tour, log } = rig({ active: false });
  tour.tick(0); tour.tick(60_000);
  assert.deepEqual(log, []);
});
