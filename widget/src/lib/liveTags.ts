/**
 * Live-tag support for the cloud widget — the pure part.
 *
 * Why this exists: the sensor apps only publish their `tag_values` aggregate
 * to the cloud every 15 minutes unless *their own* card is expanded on the
 * device page (pydoover's presence-gated `max_age_secs`). Expanding the
 * Petronash HMI card claims nothing on the peer apps' behalf, so in the cloud
 * the tiles were rendering 15-minute-old readings.
 *
 * pydoover has a second, ephemeral path for exactly this: tags declared
 * `live=True` are re-sent every main-loop iteration as a one-shot message on
 * `tag_values` while some browser has claimed `"<app_key>.<tag_name>"` in the
 * device's `dv-ui-sub.live_tag_open` presence bucket. One-shots are never
 * persisted — no aggregate write, no message row, no alarm evaluation — so the
 * cloud copy keeps its 15-minute cadence while this widget sees fresh values.
 *
 * The React side (useLiveTags.ts) claims and listens; everything here is
 * hook-free and unit-tested (tests/liveTags.test.mjs).
 */

import type { PeerApps } from "./assembleDashboardData";

type JsonRecord = Record<string, unknown>;

/** Presence channel and bucket pydoover reads (`pydoover/tags/manager.py`). */
export const PRESENCE_CHANNEL = "dv-ui-sub";
export const PRESENCE_BUCKET = "live_tag_open";
/** The channel `flush_live_tags` publishes one-shots on (LIVE_TAG_CHANNEL_NAME). */
export const LIVE_CHANNEL = "tag_values";

/**
 * Re-stamp period for our claim. The device treats a stamp as gone at
 * exactly 120 s (`UI_SUB_FRESH_MS`); the customer-site's own presence
 * heartbeat re-stamps at 120 s plus jitter and so lapses briefly every cycle.
 * 50 s keeps us well inside the window even with a slow PATCH.
 */
export const RESTAMP_MS = 50_000;

/** Batch window for folding one-shot frames into React state. */
export const LIVE_FLUSH_MS = 250;

/**
 * The tags each tile renders, per peer app, in the qualified
 * `<app_key>.<tag_name>` form the device matches on (exact string, against
 * the tag's registered name, not any UI element name).
 *
 * Every one of these is declared `live=True` in its app EXCEPT the level
 * sensor's `level_volume`. The device streams nothing for a claimed tag that
 * is not live, so until that app marks it live the widget re-derives the
 * volume from the live level itself (`reconcileTankVolume`); the claim is
 * kept so the derived value is replaced by the real one the moment the app
 * ships that change, with no widget release.
 */
export function liveTagIds(peers: PeerApps): string[] {
  const { flowApp, pressureApp, tankApp, pumpApp } = peers;
  return [
    `${flowApp}.value`,
    `${pressureApp}.value`,
    `${tankApp}.level_reading`,
    `${tankApp}.level_filled_percentage`,
    `${tankApp}.level_volume`,
    `${pumpApp}.pump_1_on`,
    `${pumpApp}.pump_2_on`,
    `${pumpApp}.total_volume`,
    `${pumpApp}.selected_segment_volume`,
    `${pumpApp}.selected_segment_name`,
    `${pumpApp}.unexpected_flow_alert`,
    `${pumpApp}.low_flow_alert`,
    `${pumpApp}.low_tank_time_alert`,
  ];
}

/**
 * The slot our claim lives under. The customer-site keys its own slots as
 * `<userId>:<gateway session id>` and a patch replaces the whole slot value,
 * so sharing that key would clobber e.g. a plot's live mode in the same tab.
 * pydoover iterates the bucket's values and never parses keys, so any
 * per-mount-unique key is fine.
 */
export function presenceSlotKey(userId: string, mountId: string): string {
  return `${userId}:hmi-${mountId}`;
}

/** PATCH body that (re-)stamps our claim. */
export function presenceClaimBody(
  slotKey: string,
  tags: readonly string[],
  ts: number,
): JsonRecord {
  return { [PRESENCE_BUCKET]: { [slotKey]: { ts, tags: [...tags] } } };
}

/** PATCH body that drops our claim (null deletes the key on merge). */
export function presenceClearBody(slotKey: string): JsonRecord {
  return { [PRESENCE_BUCKET]: { [slotKey]: null } };
}

export interface LiveValue {
  value: unknown;
  /** Local clock time the one-shot arrived, for ordering against the aggregate. */
  at: number;
}

export type LiveValues = ReadonlyMap<string, LiveValue>;

function isPlainObject(value: unknown): value is JsonRecord {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Flatten a one-shot payload — the same nested `{ app_key: { tag: value } }`
 * shape as the aggregate — into dotted-path leaves stamped with arrival time.
 * Anything that is not a plain object yields nothing.
 */
export function collectOneShotValues(
  data: unknown,
  at: number,
  prefix: string[] = [],
): [string, LiveValue][] {
  if (!isPlainObject(data)) return [];
  const out: [string, LiveValue][] = [];
  for (const [key, value] of Object.entries(data)) {
    const path = [...prefix, key];
    if (isPlainObject(value)) {
      out.push(...collectOneShotValues(value, at, path));
    } else {
      out.push([path.join("."), { value, at }]);
    }
  }
  return out;
}

/** Fold a batch of one-shot leaves into the overlay, newest winning. */
export function applyLiveValues(
  prev: LiveValues,
  entries: readonly [string, LiveValue][],
): Map<string, LiveValue> {
  const next = new Map(prev);
  for (const [path, live] of entries) {
    const existing = next.get(path);
    if (!existing || live.at >= existing.at) next.set(path, live);
  }
  return next;
}

export interface OverlayResult {
  /** `tag_values` with live values written over the aggregate snapshot. */
  tagValues: JsonRecord | undefined;
  /** Arrival time of the newest live value applied, or null if none applied. */
  liveAt: number | null;
  /** Dotted paths that were actually written over the aggregate. */
  applied: Set<string>;
}

/**
 * Write live values over the aggregate snapshot. A live value only overrides
 * while it is at least as new as the aggregate we hold (`aggregateAt` is the
 * local time that aggregate object arrived): once streaming stops — claim
 * lapsed, app restarted, uplink down — the next 15-minute flush must win over
 * a frozen live value. Never mutates the input.
 */
export function overlayLiveValues(
  tagValues: JsonRecord | undefined,
  live: LiveValues,
  aggregateAt: number,
): OverlayResult {
  let out: JsonRecord | undefined;
  let liveAt: number | null = null;
  const applied = new Set<string>();
  for (const [path, entry] of live) {
    if (entry.at < aggregateAt) continue;
    const segments = path.split(".");
    if (segments.length < 2) continue;
    out ??= { ...(tagValues ?? {}) };
    let cursor: JsonRecord = out;
    for (let i = 0; i < segments.length - 1; i++) {
      const seg = segments[i];
      const existing = cursor[seg];
      const copy: JsonRecord = isPlainObject(existing) ? { ...existing } : {};
      cursor[seg] = copy;
      cursor = copy;
    }
    cursor[segments[segments.length - 1]] = entry.value;
    applied.add(path);
    liveAt = liveAt === null ? entry.at : Math.max(liveAt, entry.at);
  }
  return { tagValues: out ?? tagValues, liveAt, applied };
}

function asNumber(value: unknown): number | null {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

/**
 * The level sensor's own volume model (`analog-level-sensor
 * src/common/common_app.py`, `_volume` / `_get_volume`), ported so the widget
 * can keep the tank's volume in step with a live level:
 *
 *  - with a `volume_curve` of two or more `{level, volume}` points: linear
 *    interpolation on the level (metres), extrapolating off the nearest end
 *    segment outside the curve, exactly as the app does;
 *  - otherwise `max_volume * filled_percentage / 100`.
 *
 * Returns null when the config cannot yield a volume.
 */
export function deriveTankVolume(
  levelMetres: number | null,
  filledPercentage: number | null,
  tankConfig: JsonRecord,
): number | null {
  const curve = Array.isArray(tankConfig.volume_curve) ? tankConfig.volume_curve : [];
  const points = curve
    .map((p) => {
      const rec = isPlainObject(p) ? p : {};
      return [asNumber(rec.level), asNumber(rec.volume)] as const;
    })
    .filter((p): p is readonly [number, number] => p[0] !== null && p[1] !== null)
    .sort((a, b) => a[0] - b[0]);

  if (points.length >= 2) {
    if (levelMetres === null) return null;
    for (let i = 0; i + 1 < points.length; i++) {
      const [x1, y1] = points[i];
      const [x2, y2] = points[i + 1];
      if (x1 <= levelMetres && levelMetres <= x2) {
        return y1 + ((levelMetres - x1) * (y2 - y1)) / (x2 - x1);
      }
    }
    const [[x1, y1], [x2, y2]] =
      levelMetres < points[0][0]
        ? [points[0], points[1]]
        : [points[points.length - 2], points[points.length - 1]];
    return y1 + ((levelMetres - x1) * (y2 - y1)) / (x2 - x1);
  }

  const maxVolume = asNumber(tankConfig.max_volume);
  if (maxVolume === null || filledPercentage === null) return null;
  return maxVolume * (filledPercentage / 100);
}

/**
 * Keep the tank's volume consistent with a live level. The level sensor does
 * not (yet) declare `level_volume` live, so after an overlay the tile would
 * show a seconds-fresh gauge beside a volume from the last 15-minute flush.
 * When a live level or percentage was applied but no live volume was, the
 * volume is re-derived from the sensor's own config. Left alone when the
 * aggregate carries no volume (the operator hid it) or the config cannot
 * produce one. Never mutates the input.
 */
export function reconcileTankVolume(
  tagValues: JsonRecord | undefined,
  applied: ReadonlySet<string>,
  tankApp: string,
  tankConfig: JsonRecord,
): JsonRecord | undefined {
  if (!tagValues) return tagValues;
  if (applied.has(`${tankApp}.level_volume`)) return tagValues;
  const levelLive = applied.has(`${tankApp}.level_reading`);
  const percentLive = applied.has(`${tankApp}.level_filled_percentage`);
  if (!levelLive && !percentLive) return tagValues;
  const tank = isPlainObject(tagValues[tankApp]) ? tagValues[tankApp] : {};
  if (asNumber(tank.level_volume) === null) return tagValues;
  const derived = deriveTankVolume(
    asNumber(tank.level_reading),
    asNumber(tank.level_filled_percentage),
    tankConfig,
  );
  if (derived === null) return tagValues;
  return { ...tagValues, [tankApp]: { ...tank, level_volume: derived } };
}

/**
 * Feature-detect a doover-js cloud client. The device-agent local widget
 * host (the on-skid kiosk) injects its own `DdaDataClient` — `clientId`
 * "local-dda-http", a gateway with no event emitter or session, and stub
 * `users` — so there every live-tag step is skipped: the kiosk already
 * renders at loop rate from local state and cannot receive one-shots anyway.
 * (The local host DOES supply `uiElement.app_key`, so that is not a usable
 * signal.)
 */
export interface LiveCapableClient {
  clientId?: string;
  gateway: {
    on: (event: "oneShotMessage", listener: (event: OneShotEvent) => void) => unknown;
    off: (event: "oneShotMessage", listener: (event: OneShotEvent) => void) => unknown;
    getSession: () => unknown;
  };
  users: { getMe: () => Promise<{ id: string }> };
  aggregates: {
    patchAggregate: (
      id: { agentId: string; channelName: string },
      body: JsonRecord,
    ) => Promise<unknown>;
  };
}

export interface OneShotEvent {
  channel: { agent_id: string; name: string };
  data: unknown;
}

export const LOCAL_HOST_CLIENT_ID = "local-dda-http";

export function isLiveCapableClient(client: unknown): client is LiveCapableClient {
  const c = client as Partial<LiveCapableClient> | null | undefined;
  return (
    c?.clientId !== LOCAL_HOST_CLIENT_ID &&
    typeof c?.gateway?.on === "function" &&
    typeof c?.gateway?.off === "function" &&
    typeof c?.gateway?.getSession === "function" &&
    typeof c?.users?.getMe === "function" &&
    typeof c?.aggregates?.patchAggregate === "function"
  );
}
