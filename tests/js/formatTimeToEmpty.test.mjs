/**
 * Node test for the pure time-to-empty helper in the shared render core.
 *
 * hmi-core.js is framework-free and touches `document` only inside createHmi(),
 * so `formatTimeToEmpty` imports and runs cleanly under `node --test` with no
 * DOM. This is the single source of the tank drain math (both shells' data
 * assemblers stay dumb pass-throughs), so it is the thing worth unit-testing.
 *
 * Run: node --test tests/js/
 */

import test from "node:test";
import assert from "node:assert/strict";

import { formatTimeToEmpty } from "../../src/petronash_hmi/static/js/hmi-core.js";

const DHM = /^\d+d \d+h \d+m$/;

test("gallon capacity, GPD flow — whole days", () => {
  // 1000 gal * 50% = 500 gal; 100 gal/day -> 5 days exactly.
  const tte = formatTimeToEmpty(
    { percent: 50, capacity: { value: 1000, units: "gal" } },
    { value: 100, units: "GPD" },
  );
  assert.equal(tte, "5d 0h 0m");
});

test("GPH flow is converted to a per-day basis", () => {
  // 240 gal full; 10 GPH = 240 gal/day -> exactly 1 day.
  const tte = formatTimeToEmpty(
    { percent: 100, capacity: { value: 240, units: "gal" } },
    { value: 10, units: "GPH" },
  );
  assert.equal(tte, "1d 0h 0m");
});

test("gallon flow converts to a litre-capacity tank", () => {
  // 3785.41 L full; 1000 GPD = 1000 gal/day = 3785.41 L/day -> 1 day.
  const tte = formatTimeToEmpty(
    { percent: 100, capacity: { value: 3785.41, units: "L" } },
    { value: 1000, units: "GPD" },
  );
  assert.equal(tte, "1d 0h 0m");
});

test("live rig fixture (100000 L, 35%, 36 GPD) drains over months", () => {
  // 35000 L / (36 * 3.78541 L/day) ≈ 256.8 days.
  const tte = formatTimeToEmpty(
    { percent: 35, capacity: { value: 100000, units: "L" } },
    { value: 36, units: "GPD" },
  );
  assert.match(tte, DHM);
  const days = Number(tte.match(/^(\d+)d/)[1]);
  assert.ok(days > 250 && days < 260, `expected ~256 days, got ${tte}`);
});

test("hours and minutes are broken out", () => {
  // 100 gal full; 25 GPH = 600 gal/day -> 0.1667 day = 4h 0m.
  const tte = formatTimeToEmpty(
    { percent: 100, capacity: { value: 100, units: "gal" } },
    { value: 25, units: "GPH" },
  );
  assert.equal(tte, "0d 4h 0m");
});

test("flow of 0 renders the em-dash (pumps off, not draining)", () => {
  const tte = formatTimeToEmpty(
    { percent: 50, capacity: { value: 1000, units: "gal" } },
    { value: 0, units: "GPD" },
  );
  assert.equal(tte, "—");
});

test("negative flow renders the em-dash", () => {
  const tte = formatTimeToEmpty(
    { percent: 50, capacity: { value: 1000, units: "gal" } },
    { value: -5, units: "GPD" },
  );
  assert.equal(tte, "—");
});

test("null flow renders the em-dash", () => {
  const tte = formatTimeToEmpty(
    { percent: 50, capacity: { value: 1000, units: "gal" } },
    { value: null, units: "GPD" },
  );
  assert.equal(tte, "—");
});

test("null tank percent renders the em-dash", () => {
  const tte = formatTimeToEmpty(
    { percent: null, capacity: { value: 1000, units: "gal" } },
    { value: 100, units: "GPD" },
  );
  assert.equal(tte, "—");
});

test("missing capacity renders the em-dash", () => {
  assert.equal(
    formatTimeToEmpty({ percent: 50 }, { value: 100, units: "GPD" }),
    "—",
  );
  assert.equal(
    formatTimeToEmpty(
      { percent: 50, capacity: { value: null, units: "L" } },
      { value: 100, units: "GPD" },
    ),
    "—",
  );
});

test("unrecognised flow-rate basis renders the em-dash", () => {
  const tte = formatTimeToEmpty(
    { percent: 50, capacity: { value: 1000, units: "L" } },
    { value: 100, units: "L/min" },
  );
  assert.equal(tte, "—");
});

test("unrecognised volume unit skips conversion (assume same unit)", () => {
  // capacity units "widgets" unrecognised -> gal treated as widgets, no scale.
  // 1000 * 50% = 500; 100 GPD -> 5 days.
  const tte = formatTimeToEmpty(
    { percent: 50, capacity: { value: 1000, units: "widgets" } },
    { value: 100, units: "GPD" },
  );
  assert.equal(tte, "5d 0h 0m");
});
