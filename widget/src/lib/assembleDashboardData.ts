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
 *                           display units, each sensor app's
 *                           measurement_units / alarm_type, and the level
 *                           sensor's tank capacity (max_volume / volume_units)
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
 * A sensor's configured alarm type, or null when it has none / is disabled.
 * The 4-20mA apps nest alarm config under an `alarm` object; the analog level
 * sensor keeps it flat at the config root. Mirrors alarm_type_from_app_config()
 * in application.py.
 */
export function resolveAlarmType(sensorConfig: JsonRecord): string | null {
  const alarmBlock =
    "alarm" in sensorConfig ? asRecord(sensorConfig.alarm) : sensorConfig;
  if (alarmBlock.alarm_enabled === false) {
    return null;
  }
  return asString(alarmBlock.alarm_type);
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
  const alarmType = resolveAlarmType(sensorConfig);
  if (alarmType === null) {
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

const MM_PER_METRE = 1000;
const MM_PER_INCH = 25.4;

/**
 * Which of a sensor's alarm bounds the config arms: { low, high }.
 *
 * Only the bounds the sensor's alarm_type puts in play are rendered — a
 * "Greater Than" alarm has no low bound, so an empty "Low Alarm" row would
 * imply a setpoint that cannot exist. Separate from whether a bound has a
 * value: an armed-but-never-dragged bound still shows, with an em-dash.
 * Applies to flow, pressure and tank alike. Mirrors alarm_active() in
 * application.py.
 */
export function alarmActive(alarmType: string | null): {
  low: boolean;
  high: boolean;
} {
  if (alarmType === "Allowed Range") return { low: true, high: true };
  if (alarmType === "Less Than") return { low: true, high: false };
  if (alarmType === "Greater Than") return { low: false, high: true };
  return { low: false, high: false };
}

/**
 * Render the level sensor's alarm setpoint(s) as a display value + unit.
 *
 * The sensor's `alarm_source` picks which reading the alarm tracks, and that
 * sets the setpoint's units: "Filled Percentage" -> %, "Volume" -> the
 * sensor's volume_units, "Level Reading" -> metres converted to the panel's
 * length unit. An unknown source yields no setpoint rather than a mislabelled
 * number. Mirrors tank_alarm_display() in application.py.
 */
export function tankAlarmDisplay(
  low: number | null,
  high: number | null,
  alarmSource: string | null,
  volumeUnitsLabel: string | null,
  lengthUnit: "inch" | "mm",
): { low: number | null; high: number | null; units: string | null } {
  if (alarmSource === "Filled Percentage") {
    return { low, high, units: "%" };
  }
  if (alarmSource === "Volume") {
    return { low, high, units: volumeUnitsLabel };
  }
  if (alarmSource === "Level Reading") {
    const factor =
      lengthUnit === "mm" ? MM_PER_METRE : MM_PER_METRE / MM_PER_INCH;
    const unit = lengthUnit === "mm" ? "mm" : '"';
    return {
      low: low === null ? null : low * factor,
      high: high === null ? null : high * factor,
      units: unit,
    };
  }
  return { low: null, high: null, units: null };
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
  const tankConfig = asRecord(applications[tankApp]);

  const flowUnits = asString(flowConfig.measurement_units) ?? "";
  const pressureUnits = asString(pressureConfig.measurement_units) ?? "";

  const flowAlarms = resolveAlarmSetpoints(flowConfig, asRecord(cmds[flowApp]));
  const flowActive = alarmActive(resolveAlarmType(flowConfig));
  const pressureAlarms = resolveAlarmSetpoints(
    pressureConfig,
    asRecord(cmds[pressureApp]),
  );
  const pressureActive = alarmActive(resolveAlarmType(pressureConfig));

  // Tank level_reading is metres; the v2 contract carries millimetres.
  const levelMetres = asNumber(tankTags.level_reading);

  // display_units config values look like `Inch (")` / `Millimeter (mm)`.
  const displayUnits = asString(hmiConfig.display_units) ?? "Inch";
  const lengthUnit: "inch" | "mm" = /inch/i.test(displayUnits) ? "inch" : "mm";

  const tankAlarms = resolveAlarmSetpoints(tankConfig, asRecord(cmds[tankApp]));
  const tankAlarm = tankAlarmDisplay(
    tankAlarms.low,
    tankAlarms.high,
    asString(tankConfig.alarm_source),
    asString(tankConfig.volume_units),
    lengthUnit,
  );
  const tankActive = alarmActive(resolveAlarmType(tankConfig));

  return {
    pumps: {
      pump_1: { on: asBool(pumpTags.pump_1_on) },
      pump_2: { on: asBool(pumpTags.pump_2_on) },
    },
    pressure: {
      value: asNumber(pressureTags.value),
      units: pressureUnits,
      high_alarm: pressureAlarms.high,
      low_alarm: pressureAlarms.low,
      high_alarm_active: pressureActive.high,
      low_alarm_active: pressureActive.low,
    },
    flow: {
      value: asNumber(flowTags.value),
      units: flowUnits,
      high_alarm: flowAlarms.high,
      low_alarm: flowAlarms.low,
      high_alarm_active: flowActive.high,
      low_alarm_active: flowActive.low,
    },
    volume: {
      total: asNumber(pumpTags.total_volume),
      segment_total: asNumber(pumpTags.selected_segment_volume),
      units: volumeUnits(flowUnits),
    },
    segment: {
      name: asString(pumpTags.selected_segment_name),
    },
    tank: {
      percent: asNumber(tankTags.level_filled_percentage),
      level_mm: levelMetres === null ? null : levelMetres * 1000,
      // Dumb pass-through: capacity from the level sensor's own
      // deployment_config (max_volume + volume_units). All time-to-empty math
      // lives in hmi-core.js so the two shells cannot diverge.
      capacity: {
        value: asNumber(tankConfig.max_volume),
        units: asString(tankConfig.volume_units),
      },
      high_alarm: tankAlarm.high,
      low_alarm: tankAlarm.low,
      alarm_units: tankAlarm.units,
      high_alarm_active: tankActive.high,
      low_alarm_active: tankActive.low,
    },
    units: { length: lengthUnit },
    alerts: {
      unexpected_flow: pumpTags.unexpected_flow_alert === true,
      low_flow: pumpTags.low_flow_alert === true,
      low_tank_time: pumpTags.low_tank_time_alert === true,
    },
    system: {
      timestamp: new Date(inputs.lastUpdated ?? Date.now()).toISOString(),
      status: "running",
    },
  };
}
