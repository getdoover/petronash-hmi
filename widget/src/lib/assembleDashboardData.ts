/**
 * Cloud-side data adapter: assemble a DashboardData v2 dict (the same
 * contract the device-local Flask/Socket.IO server emits as `data_update`)
 * from the raw Doover channel aggregates the widget reads via doover-js:
 *
 *   - `tag_values`        — sensor readings, pump state tags, volume, alerts
 *                           ({ <app_key>: { <tag>: value } })
 *   - `ui_cmds`           — alarm setpoints (persisted slider values,
 *                           { <app_key>: { alarm_point | alarm_range } })
 *   - `deployment_config` — this HMI install's configured peer app keys +
 *                           display units, and each sensor app's
 *                           measurement_units / alarm_type
 *                           ({ applications: { <app_key>: {...} } })
 *
 * Mirrors the python side (src/petronash_hmi/application.py) so hmi-core.js
 * renders identically in both shells. Pure module — unit-testable, no hooks.
 */

import type { DashboardDataV2 } from "../../../src/petronash_hmi/static/js/hmi-core.js";

type JsonRecord = Record<string, unknown>;

export interface AssembleInputs {
  /** This HMI install's app key (uiElement.app_key / $config.app().APP_KEY). */
  appKey: string;
  /** `deployment_config` aggregate data. */
  deploymentConfig: JsonRecord | undefined;
  /** `tag_values` aggregate data. */
  tagValues: JsonRecord | undefined;
  /** `ui_cmds` aggregate data. */
  uiCmds: JsonRecord | undefined;
  /** Epoch-ms of the last tag_values update (for system.timestamp). */
  lastUpdated: number | null | undefined;
}

// Defaults match the solution's doover_config defaults (and the live test
// rig): flow = sensor_1, pressure = sensor_2.
const DEFAULT_FLOW_APP = "4_20ma_sensor_1";
const DEFAULT_PRESSURE_APP = "4_20ma_sensor_2";
const DEFAULT_TANK_APP = "analog_level_sensor_1";
const DEFAULT_PUMP_CONTROLLER_APP = "petronash_pump_controller_1";

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asBool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * Resolve the active high/low alarm setpoints for one sensor app.
 *
 * Which ui_cmds key is authoritative depends on the sensor's configured
 * alarm_type (4-20mA apps nest it under an `alarm` object; the analog level
 * sensor keeps it flat):
 *   - "Allowed Range" -> `alarm_range` ([low, high] — sorted defensively,
 *     order is not guaranteed)
 *   - "Greater Than"  -> `alarm_point` is a HIGH alarm
 *   - "Less Than"     -> `alarm_point` is a LOW alarm
 *
 * A slider the operator has never moved has NO entry in ui_cmds — that means
 * "no setpoint" (null), never 0. Stale sibling keys (e.g. a hidden
 * alarm_point next to an active alarm_range) are ignored.
 */
export function resolveAlarmSetpoints(
  sensorConfig: JsonRecord,
  sensorCmds: JsonRecord,
): { high: number | null; low: number | null } {
  const alarmBlock =
    "alarm" in sensorConfig ? asRecord(sensorConfig.alarm) : sensorConfig;
  const alarmType = asString(alarmBlock.alarm_type);
  if (alarmBlock.alarm_enabled === false) {
    return { high: null, low: null };
  }

  if (alarmType === "Allowed Range") {
    const range = sensorCmds.alarm_range;
    if (Array.isArray(range) && range.length === 2) {
      const low = asNumber(range[0]);
      const high = asNumber(range[1]);
      if (low !== null && high !== null) {
        return low <= high ? { low, high } : { low: high, high: low };
      }
    }
    return { high: null, low: null };
  }

  const point = asNumber(sensorCmds.alarm_point);
  if (alarmType === "Less Than") {
    return { high: null, low: point };
  }
  if (alarmType === "Greater Than") {
    return { high: point, low: null };
  }
  // Unknown or missing alarm_type (e.g. deployment_config still loading):
  // there is no authoritative key to read — a stale alarm_point must not
  // render as a phantom high alarm. Mirrors the python resolver.
  return { high: null, low: null };
}

/** Derive the volume unit label from the flow sensor's units (GPD -> gal). */
export function volumeUnits(flowUnits: string): string {
  return /^gp/i.test(flowUnits.trim()) ? "gal" : "units";
}

export function assembleDashboardData(inputs: AssembleInputs): DashboardDataV2 {
  const applications = asRecord(asRecord(inputs.deploymentConfig).applications);
  const hmiConfig = asRecord(applications[inputs.appKey]);

  const flowApp = asString(hmiConfig.flow_sensor_app) ?? DEFAULT_FLOW_APP;
  const pressureApp =
    asString(hmiConfig.pressure_sensor_app) ?? DEFAULT_PRESSURE_APP;
  const tankApp = asString(hmiConfig.tank_level_app) ?? DEFAULT_TANK_APP;
  const pumpApp =
    asString(hmiConfig.pump_controller_app) ?? DEFAULT_PUMP_CONTROLLER_APP;

  const tags = asRecord(inputs.tagValues);
  const cmds = asRecord(inputs.uiCmds);

  const flowTags = asRecord(tags[flowApp]);
  const pressureTags = asRecord(tags[pressureApp]);
  const tankTags = asRecord(tags[tankApp]);
  const pumpTags = asRecord(tags[pumpApp]);

  const flowConfig = asRecord(applications[flowApp]);
  const pressureConfig = asRecord(applications[pressureApp]);

  const flowUnits = asString(flowConfig.measurement_units) ?? "";
  const pressureUnits = asString(pressureConfig.measurement_units) ?? "";

  const flowAlarms = resolveAlarmSetpoints(flowConfig, asRecord(cmds[flowApp]));
  const pressureAlarms = resolveAlarmSetpoints(
    pressureConfig,
    asRecord(cmds[pressureApp]),
  );

  // Tank level_reading is metres; the v2 contract carries millimetres.
  const levelMetres = asNumber(tankTags.level_reading);

  // display_units config values look like `Inch (")` / `Millimeter (mm)`.
  const displayUnits = asString(hmiConfig.display_units) ?? "Inch";
  const lengthUnit: "inch" | "mm" = /inch/i.test(displayUnits) ? "inch" : "mm";

  return {
    pumps: {
      pump_1: { on: asBool(pumpTags.pump_1_on) },
      pump_2: { on: asBool(pumpTags.pump_2_on) },
    },
    pressure: {
      value: asNumber(pressureTags.value),
      units: pressureUnits,
      high_alarm: pressureAlarms.high,
    },
    flow: {
      value: asNumber(flowTags.value),
      units: flowUnits,
      high_alarm: flowAlarms.high,
      low_alarm: flowAlarms.low,
    },
    volume: {
      total: asNumber(pumpTags.total_volume),
      units: volumeUnits(flowUnits),
    },
    tank: {
      percent: asNumber(tankTags.level_filled_percentage),
      level_mm: levelMetres === null ? null : levelMetres * 1000,
    },
    units: { length: lengthUnit },
    alerts: {
      unexpected_flow: pumpTags.unexpected_flow_alert === true,
      low_flow: pumpTags.low_flow_alert === true,
    },
    system: {
      timestamp: new Date(inputs.lastUpdated ?? Date.now()).toISOString(),
      status: "running",
    },
  };
}
