import assert from "node:assert/strict";
import { test } from "node:test";
import { isNight, nightPath, sunPosition } from "../src/daynight";

test("equinox noon UTC: the sun is over the equator near the prime meridian", () => {
  const s = sunPosition(new Date("2026-03-20T12:00:00Z"));
  assert.ok(Math.abs(s.lat) < 1, `lat ${s.lat}`);
  assert.ok(Math.abs(s.lon) < 4, `lon ${s.lon}`); // equation of time is a few minutes = a degree or so
});

test("June solstice: the sun is over the Tropic of Cancer; December: Capricorn", () => {
  assert.ok(Math.abs(sunPosition(new Date("2026-06-21T12:00:00Z")).lat - 23.4) < 0.5);
  assert.ok(Math.abs(sunPosition(new Date("2026-12-21T12:00:00Z")).lat + 23.4) < 0.5);
});

test("the sun moves west 15 degrees per hour", () => {
  const a = sunPosition(new Date("2026-05-01T06:00:00Z")).lon;
  const b = sunPosition(new Date("2026-05-01T07:00:00Z")).lon;
  assert.ok(Math.abs(((a - b + 540) % 360) - 180 - 15) < 0.3, `${a} -> ${b}`);
});

test("night and day at known places and times", () => {
  const noonUtc = new Date("2026-03-20T12:00:00Z");
  assert.equal(isNight(51.5, -0.1, noonUtc), false);   // London at midday
  assert.equal(isNight(35.7, 139.7, noonUtc), true);   // Tokyo, 9pm
  assert.equal(isNight(-33.9, 151.2, noonUtc), true);  // Sydney, ~11pm
  assert.equal(isNight(40.7, -74.0, noonUtc), false);  // New York, 8am
  assert.equal(isNight(37.8, -122.4, noonUtc), true);  // San Francisco, 5am
});

test("polar day and night follow the season", () => {
  assert.equal(isNight(80, 0, new Date("2026-06-21T00:00:00Z")), false); // midnight sun
  assert.equal(isNight(80, 0, new Date("2026-12-21T12:00:00Z")), true);  // polar night
});

test("the night path is a closed shape in the map's 1000x500 space", () => {
  const d = nightPath(new Date("2026-10-10T15:00:00Z"));
  assert.match(d, /^M-?[\d.]+,-?[\d.]+L/);
  assert.ok(d.endsWith("Z"));
  const nums = [...d.matchAll(/(-?[\d.]+),(-?[\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
  assert.ok(nums.length >= 180);
  for (const [x, y] of nums) assert.ok(x >= 0 && x <= 1000 && y >= -1 && y <= 501, `${x},${y}`);
  assert.doesNotThrow(() => nightPath(new Date("2026-03-20T12:00:00Z"))); // equinox: no divide-by-zero
});
