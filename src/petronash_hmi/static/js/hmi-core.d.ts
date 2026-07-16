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
  pressure: { value: number | null; units: string; high_alarm: number | null };
  flow: {
    value: number | null;
    units: string;
    high_alarm: number | null;
    low_alarm: number | null;
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
    capacity: { value: number | null; units: string | null };
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

export interface CreateHmiOptions {
  /**
   * How the alert window is presented.
   * - "overlay" (default, local panel): floats over the tiles on the z-axis,
   *   dimming them.
   * - "inline" (cloud widget): a banner stacked above the tiles on the y-axis,
   *   pushing them down rather than covering them.
   */
  alertLayout?: "overlay" | "inline";
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
