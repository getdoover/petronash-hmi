/**
 * Pure alarm/setpoint helpers in the HMI data adapter. Run: node --test tests/
 *
 * These mirror the (now-removed) python tests/test_setpoints.py: when the HMI
 * became a widget-only PRO app the python assembler was deleted, so this logic
 * lives ONLY here now and is tested here.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  alarmActive,
  assembleDashboardData,
  resolveAlarmSetpoints,
  resolveAlarmType,
  tankAlarmDisplay,
  volumeUnits,
} from "../src/lib/assembleDashboardData.ts";

// -- alarmActive: which bounds a sensor's alarm_type arms -----------------

test("alarmActive: Allowed Range arms both", () => {
  assert.deepEqual(alarmActive("Allowed Range"), { low: true, high: true });
});
test("alarmActive: Less Than arms only low", () => {
  assert.deepEqual(alarmActive("Less Than"), { low: true, high: false });
});
test("alarmActive: Greater Than arms only high", () => {
  assert.deepEqual(alarmActive("Greater Than"), { low: false, high: true });
});
test("alarmActive: disabled/unknown arms neither", () => {
  assert.deepEqual(alarmActive(null), { low: false, high: false });
  assert.deepEqual(alarmActive("Bogus"), { low: false, high: false });
});

// -- resolveAlarmType: nested (4-20mA) vs flat (level) vs disabled --------

test("resolveAlarmType: nested alarm block (4-20mA)", () => {
  assert.equal(
    resolveAlarmType({ alarm: { alarm_type: "Allowed Range" } }),
    "Allowed Range",
  );
});
test("resolveAlarmType: flat (analog level sensor)", () => {
  assert.equal(resolveAlarmType({ alarm_type: "Greater Than" }), "Greater Than");
});
test("resolveAlarmType: alarm_enabled false -> null", () => {
  assert.equal(
    resolveAlarmType({ alarm: { alarm_enabled: false, alarm_type: "Less Than" } }),
    null,
  );
  assert.equal(resolveAlarmType({}), null);
});

// -- resolveAlarmSetpoints: which ui_cmds key is authoritative ------------

test("resolveAlarmSetpoints: Allowed Range sorts the pair", () => {
  const cfg = { alarm: { alarm_type: "Allowed Range" } };
  assert.deepEqual(resolveAlarmSetpoints(cfg, { alarm_range: [63.3, 34.2] }), {
    low: 34.2,
    high: 63.3,
  });
});
test("resolveAlarmSetpoints: Allowed Range ignores a stale alarm_point", () => {
  const cfg = { alarm: { alarm_type: "Allowed Range" } };
  assert.deepEqual(resolveAlarmSetpoints(cfg, { alarm_point: 20 }), {
    low: null,
    high: null,
  });
});
test("resolveAlarmSetpoints: Greater Than -> high, Less Than -> low", () => {
  assert.deepEqual(
    resolveAlarmSetpoints({ alarm_type: "Greater Than" }, { alarm_point: 56.2 }),
    { low: null, high: 56.2 },
  );
  assert.deepEqual(
    resolveAlarmSetpoints({ alarm_type: "Less Than" }, { alarm_point: 20 }),
    { low: 20, high: null },
  );
});
test("resolveAlarmSetpoints: no type / disabled / no entry -> no setpoint", () => {
  assert.deepEqual(resolveAlarmSetpoints({}, { alarm_point: 5 }), {
    low: null,
    high: null,
  });
  assert.deepEqual(
    resolveAlarmSetpoints({ alarm: { alarm_enabled: false } }, { alarm_point: 5 }),
    { low: null, high: null },
  );
});

// -- tankAlarmDisplay: alarm_source sets the setpoint's units ------------

test("tankAlarmDisplay: Filled Percentage -> %", () => {
  assert.deepEqual(tankAlarmDisplay(null, 56.2, "Filled Percentage", "L", "m"), {
    low: null,
    high: 56.2,
    units: "%",
  });
});
test("tankAlarmDisplay: Volume -> the sensor's volume_units", () => {
  assert.deepEqual(tankAlarmDisplay(null, 1000, "Volume", "L", "m"), {
    low: null,
    high: 1000,
    units: "L",
  });
});
test("tankAlarmDisplay: Level Reading -> metres converted to the sensor's Depth Units", () => {
  const metres = tankAlarmDisplay(null, 1.5, "Level Reading", "L", "m");
  assert.equal(metres.high, 1.5);
  assert.equal(metres.units, "m");
  const feet = tankAlarmDisplay(null, 1.0, "Level Reading", "L", "ft");
  assert.ok(Math.abs(feet.high - 3.2808399) < 1e-6); // 1 m in feet
  assert.equal(feet.units, "ft");
  const inches = tankAlarmDisplay(null, 1.0, "Level Reading", "L", "in");
  assert.ok(Math.abs(inches.high - 39.3700787) < 1e-6); // 1 m in inches
  assert.equal(inches.units, "in");
});
test("tankAlarmDisplay: unknown source -> no setpoint (no mislabel)", () => {
  assert.deepEqual(tankAlarmDisplay(1, 2, null, "L", "m"), {
    low: null,
    high: null,
    units: null,
  });
});

// -- assembleDashboardData: tank block -----------------------------------

test("assembleDashboardData: tank carries volume + depth in the sensor's units", () => {
  const data = assembleDashboardData({
    appKey: "petronash_hmi_1",
    deploymentConfig: {
      applications: {
        petronash_hmi_1: { tank_level_app: "analog_level_sensor_1" },
        analog_level_sensor_1: {
          depth_units: "ft",
          volume_units: "Dram",
          volume_decimal_precision: 1,
          max_volume: 1000,
        },
      },
    },
    tagValues: {
      analog_level_sensor_1: {
        level_filled_percentage: 50,
        level_reading: 2,
        level_volume: 500,
      },
    },
    uiCmds: {},
    lastUpdated: 0,
  });
  assert.equal(data.tank.percent, 50);
  assert.equal(data.tank.level_mm, 2000);
  assert.equal(data.tank.depth_units, "ft");
  assert.equal(data.tank.volume, 500);
  assert.equal(data.tank.volume_units, "Dram");
  assert.equal(data.tank.volume_precision, 1);
});

// -- assembleDashboardData: Time-to-Empty tuning -------------------------
//
// A dumb pass-through of this HMI install's own config, except the deadband:
// the operator configures it as a percentage of the flow sensor's range, and
// the assembler is the only place that knows the range, so it converts.

test("assembleDashboardData: TTE tuning comes from the HMI config keys", () => {
  const data = assembleDashboardData({
    appKey: "petronash_hmi_1",
    deploymentConfig: {
      applications: {
        petronash_hmi_1: {
          flow_sensor_app: "4_20ma_sensor_1",
          time_to_empty_smoothing_s: 120,
          time_to_empty_min_flow_percent: 2.5,
        },
        "4_20ma_sensor_1": { max_range: 10 },
      },
    },
    tagValues: {},
    uiCmds: {},
    lastUpdated: 0,
  });
  assert.equal(data.tank.tte_smoothing_seconds, 120);
  // 2.5% of a 0-10 GPH sensor = 0.25 GPH.
  assert.ok(
    Math.abs(data.tank.tte_min_flow - 0.25) < 1e-9,
    `expected 0.25, got ${data.tank.tte_min_flow}`,
  );
});

test("assembleDashboardData: TTE tuning falls back to the schema defaults", () => {
  const data = assembleDashboardData({
    appKey: "petronash_hmi_1",
    deploymentConfig: {
      applications: {
        petronash_hmi_1: { flow_sensor_app: "4_20ma_sensor_1" },
        "4_20ma_sensor_1": { max_range: 10 },
      },
    },
    tagValues: {},
    uiCmds: {},
    lastUpdated: 0,
  });
  // Same defaults as doover_config.json: 300 s and 1% of the sensor's range.
  assert.equal(data.tank.tte_smoothing_seconds, 300);
  assert.ok(
    Math.abs(data.tank.tte_min_flow - 0.1) < 1e-9,
    `expected 0.1, got ${data.tank.tte_min_flow}`,
  );
});

test("assembleDashboardData: no flow max_range -> no deadband", () => {
  const data = assembleDashboardData({
    appKey: "petronash_hmi_1",
    deploymentConfig: {
      applications: {
        petronash_hmi_1: {
          flow_sensor_app: "4_20ma_sensor_1",
          time_to_empty_min_flow_percent: 5,
        },
        "4_20ma_sensor_1": {},
      },
    },
    tagValues: {},
    uiCmds: {},
    lastUpdated: 0,
  });
  // A percentage of an unknown range is not a number we can invent — the
  // `flow > 0` gate in hmi-core.js is all that is left.
  assert.equal(data.tank.tte_min_flow, null);
});

// -- volumeUnits ---------------------------------------------------------

test("assembleDashboardData: deadband is min_range + percent of the span", () => {
  // A 2-12 GPH channel sits at 2 GPH (its 4 mA floor) with the pumps off; the
  // 1% default deadband must land just above that floor, not at 0.12 GPH.
  const data = assembleDashboardData({
    appKey: "petronash_hmi_1",
    deploymentConfig: {
      applications: {
        petronash_hmi_1: {},
        "4_20ma_sensor_1": { min_range: 2, max_range: 12 },
      },
    },
    tagValues: {},
    uiCmds: {},
    lastUpdated: null,
  });
  assert.ok(
    Math.abs(data.tank.tte_min_flow - 2.1) < 1e-9,
    `expected 2.1, got ${data.tank.tte_min_flow}`,
  );
});

test("volumeUnits: GP* -> gal, else units", () => {
  assert.equal(volumeUnits("GPD"), "gal");
  assert.equal(volumeUnits("gph"), "gal");
  assert.equal(volumeUnits("L/min"), "units");
});
