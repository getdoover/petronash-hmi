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
  volume: { total: number | null; units: string };
  tank: { percent: number | null; level_mm: number | null };
  units: { length: "inch" | "mm" };
  alerts: { unexpected_flow: boolean; low_flow: boolean };
  system: { timestamp: string; status: string };
}

export interface HmiHandle {
  /** Re-render from a DashboardData v2 dict. Ignores null/undefined. */
  update(data: DashboardDataV2 | null | undefined): void;
  /** Tear the HMI DOM back out of the root element. */
  destroy(): void;
}

export function createHmi(
  rootEl: HTMLElement,
  opts?: Record<string, unknown>,
): HmiHandle;
