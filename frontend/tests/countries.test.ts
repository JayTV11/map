import assert from "node:assert/strict";
import { test } from "node:test";
import { countryAt } from "../src/countries";

test("well-known cities resolve to their country", () => {
  const cases: [string, number, number, string][] = [
    ["Washington", 38.9, -77.04, "United States"],
    ["Oak Ridge", 36.01, -84.27, "United States"],
    ["Beijing", 39.9, 116.4, "China"],
    ["Moscow", 55.75, 37.62, "Russia"],
    ["Kyiv", 50.45, 30.52, "Ukraine"],
    ["London", 51.51, -0.13, "United Kingdom"],
    ["Paris", 48.86, 2.35, "France"],
    ["Sao Paulo", -23.55, -46.63, "Brazil"],
    ["Sydney", -33.87, 151.21, "Australia"],
    ["Tokyo", 35.68, 139.69, "Japan"],
    ["Mumbai", 19.08, 72.88, "India"],
    ["Lagos", 6.52, 3.38, "Nigeria"],
    ["Cairo", 30.04, 31.24, "Egypt"],
    ["Seoul", 37.57, 126.98, "South Korea"],
    ["Pyongyang", 39.04, 125.76, "North Korea"],
    ["Tehran", 35.69, 51.39, "Iran"],
    ["Anchorage (far side of the date line)", 61.22, -149.9, "United States"],
    ["Vladivostok", 43.12, 131.89, "Russia"],
    ["Maseru is its own country inside South Africa's outline", -29.31, 27.48, "Lesotho"],
    ["Johannesburg", -26.2, 28.05, "South Africa"],
  ];
  for (const [what, lat, lon, want] of cases) assert.equal(countryAt(lat, lon), want, what);
});

test("islands and coasts fall back to the nearest country within a few degrees", () => {
  assert.ok(countryAt(1.35, 103.82), "Singapore resolves to something nearby"); // not in the 110m data
  assert.ok(countryAt(35.9, 14.5), "Malta resolves to something nearby");
});

test("open ocean, invalid input and (0,0) give null", () => {
  assert.equal(countryAt(-40, -140), null); // South Pacific
  assert.equal(countryAt(0, 0), null);
  assert.equal(countryAt(NaN, 10), null);
  assert.equal(countryAt(91, 10), null);
  assert.equal(countryAt(10, 181), null);
});

test("repeat lookups are consistent (cache)", () => {
  assert.equal(countryAt(48.86, 2.35), countryAt(48.86, 2.35));
});
