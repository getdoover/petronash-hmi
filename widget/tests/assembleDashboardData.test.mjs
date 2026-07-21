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

// -- volumeUnits ---------------------------------------------------------

test("volumeUnits: GP* -> gal, else units", () => {
  assert.equal(volumeUnits("GPD"), "gal");
  assert.equal(volumeUnits("gph"), "gal");
  assert.equal(volumeUnits("L/min"), "units");
});
