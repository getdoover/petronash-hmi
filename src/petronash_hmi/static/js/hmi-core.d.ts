/**
 * Type declarations for hmi-core.js — the framework-free shared render core.
 * Consumed by the cloud widget's TypeScript (widget/src/PetronashHmiWidget.tsx);
 * TypeScript picks this file up automatically for imports of "./hmi-core.js".
 *
 * DashboardDataV2 is the binding socket.io `data_update` payload contract —
 * null means "no data" and renders as an em-dash placeholder, never 0.
 */

export interface PumpStateV2 {
  on: boolean | null;
}

export interface DashboardDataV2 {
  pumps: { pump_1: PumpStateV2; pump_2: PumpStateV2 };
  /** *_alarm_active say which bounds the sensor's alarm_type arms; only those
   *  rows render. An armed bound with a null value shows as an em-dash. */
  pressure: {
    value: number | null;
    units: string;
    high_alarm: number | null;
    low_alarm: number | null;
    high_alarm_active: boolean;
    low_alarm_active: boolean;
  };
  flow: {
    value: number | null;
    units: string;
    high_alarm: number | null;
    low_alarm: number | null;
    high_alarm_active: boolean;
    low_alarm_active: boolean;
  };
  volume: {
    total: number | null;
    segment_total: number | null;
    units: string;
  };
  segment: { name: string | null };
  tank: {
    percent: number | null;
    level_mm: number | null;
    /** The sensor's configured Depth Units (m/cm/mm/in/ft); level_mm converts
     *  to this for display. */
    depth_units: string;
    /** Current tank volume from the sensor's level_volume tag, in volume_units. */
    volume: number | null;
    volume_units: string | null;
    /** Decimal places for the volume readout (sensor's volume precision). */
    volume_precision: number;
    capacity: { value: number | null; units: string | null };
    /** Alarm setpoint(s), already in display units (see alarm_units). */
    high_alarm: number | null;
    low_alarm: number | null;
    /** Units of the alarm setpoint — the level sensor's alarm_source decides
     *  whether that is a percentage, a volume or a length. */
    alarm_units: string | null;
    /** Which bounds the sensor's alarm_type arms; only these are rendered. An
     *  armed-but-never-dragged bound is active with a null value (em-dash). */
    high_alarm_active: boolean;
    low_alarm_active: boolean;
    /** The pump controller's tank-empty alert threshold, in hours. */
    time_alarm_hours: number | null;
  };
  units: { length: "inch" | "mm" };
  alerts: {
    unexpected_flow: boolean;
    low_flow: boolean;
    low_tank_time: boolean;
  };
  system: { timestamp: string; status: string };
}

export interface HmiHandle {
  /** Re-render from a DashboardData v2 dict. Ignores null/undefined. */
  update(data: DashboardDataV2 | null | undefined): void;
  /** Tear the HMI DOM back out of the root element. */
  destroy(): void;
}

/**
 * Brand logos for the header bar. Each value is an `<img>` src — the cloud
 * widget passes inlined data URIs (imported with the `?inline` suffix) so the
 * single-file bundle never depends on a separately-emitted image file.
 */
export interface HmiLogos {
  /** Petronash wordmark (leftmost). */
  petronash: string;
  /** Remote-Command wordmark, left of the "SIA Remote Command" title text. */
  remoteCommand: string;
  /** Aramco wordmark (rightmost). */
  aramco: string;
}

export interface CreateHmiOptions {
  /**
   * How the alert window is presented.
   * - "overlay" (default, local panel): floats over the tiles on the z-axis,
   *   dimming them.
   * - "inline" (cloud widget): a banner stacked above the tiles on the y-axis,
   *   pushing them down rather than covering them.
   */
  alertLayout?: "overlay" | "inline";
  /**
   * Brand logos for the header bar. When provided, createHmi builds a frosted
   * header (Petronash · Remote-Command wordmark · "SIA Remote Command" ·
   * Aramco) as the first child of the root, above the alert banner and tiles.
   * Omit for no header (keeps non-logo embedders unchanged).
   */
  logos?: HmiLogos;
}

export function createHmi(
  rootEl: HTMLElement,
  opts?: CreateHmiOptions,
): HmiHandle;

/**
 * Estimate the time until the tank empties at the current flow, formatted as
 * "Xd Yh Zm", or an em-dash placeholder when it cannot be computed (flow null
 * or <= 0, percent null, capacity missing, or a non-finite result).
 */
export function formatTimeToEmpty(
  tank: DashboardDataV2["tank"] | null | undefined,
  flow: DashboardDataV2["flow"] | null | undefined,
): string;
