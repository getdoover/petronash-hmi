/**
 * Pure live-tag helpers (claim list, presence bodies, one-shot overlay, tank
 * volume reconciliation). Run: node --test tests/
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  assembleDashboardData,
  resolvePeerApps,
} from "../src/lib/assembleDashboardData.ts";
import {
  applyLiveValues,
  collectOneShotValues,
  deriveTankVolume,
  isLiveCapableClient,
  liveTagIds,
  overlayLiveValues,
  presenceClaimBody,
  presenceClearBody,
  presenceSlotKey,
  reconcileTankVolume,
} from "../src/lib/liveTags.ts";

const DEFAULT_PEERS = resolvePeerApps("petronash_hmi_1", undefined);

// -- claim list -------------------------------------------------------------

test("liveTagIds: names every tile tag under the resolved peer apps", () => {
  const ids = liveTagIds(DEFAULT_PEERS);
  assert.deepEqual(ids, [
    "4_20ma_sensor_1.value",
    "4_20ma_sensor_2.value",
    "analog_level_sensor_1.level_reading",
    "analog_level_sensor_1.level_filled_percentage",
    "analog_level_sensor_1.level_volume",
    "petronash_pump_controller_1.pump_1_on",
    "petronash_pump_controller_1.pump_2_on",
    "petronash_pump_controller_1.total_volume",
    "petronash_pump_controller_1.selected_segment_volume",
    "petronash_pump_controller_1.selected_segment_name",
    "petronash_pump_controller_1.unexpected_flow_alert",
    "petronash_pump_controller_1.low_flow_alert",
    "petronash_pump_controller_1.low_tank_time_alert",
  ]);
});

test("liveTagIds: every tag the dashboard reads from tag_values is claimed (drift guard)", () => {
  // Record every `<app>.<tag>` the assembler touches by handing it a
  // tag_values whose per-app records are Proxies. Adding a tile tag to
  // assembleDashboardData without adding it to liveTagIds fails here.
  const reads = new Set();
  const recording = (app) =>
    new Proxy(
      {},
      {
        get(_t, prop) {
          if (typeof prop === "string") reads.add(`${app}.${prop}`);
          return undefined;
        },
        has: () => true,
      },
    );
  const tagValues = Object.fromEntries(
    Object.values(DEFAULT_PEERS).map((app) => [app, recording(app)]),
  );
  assembleDashboardData({
    appKey: "petronash_hmi_1",
    deploymentConfig: undefined,
    tagValues,
    uiCmds: undefined,
    lastUpdated: 0,
  });
  assert.ok(reads.size >= 10, `expected the assembler to read tags, saw ${reads.size}`);
  const claimed = new Set(liveTagIds(DEFAULT_PEERS));
  const unclaimed = [...reads].filter((path) => !claimed.has(path));
  assert.deepEqual(unclaimed, [], "tags rendered but not claimed live");
});

test("liveTagIds: follows an install's overridden peer keys, not the defaults", () => {
  const peers = resolvePeerApps("petronash_hmi_1", {
    applications: {
      petronash_hmi_1: {
        flow_sensor_app: "4_20ma_sensor_7",
        tank_level_app: "analog_level_sensor_3",
      },
    },
  });
  const ids = liveTagIds(peers);
  assert.ok(ids.includes("4_20ma_sensor_7.value"));
  assert.ok(ids.includes("analog_level_sensor_3.level_reading"));
  assert.ok(!ids.includes("4_20ma_sensor_1.value"));
  // Unset keys still fall back to the defaults.
  assert.ok(ids.includes("4_20ma_sensor_2.value"));
  assert.ok(ids.includes("petronash_pump_controller_1.pump_1_on"));
});

// -- presence bodies --------------------------------------------------------

test("presence: slot key can never collide with the customer-site's <user>:<session> slot", () => {
  // The customer-site keys its slot `${userId}:${gatewaySessionId}`; a
  // gateway session id is a snowflake (digits). Ours carries a literal
  // prefix after the colon, so no session id can equal it.
  const key = presenceSlotKey("user-1", "abc");
  assert.equal(key, "user-1:hmi-abc");
  assert.match(key.split(":")[1], /^hmi-/);
  assert.doesNotMatch(key.split(":")[1], /^\d+$/);
});

test("presence: claim body is the live_tag_open shape pydoover reads", () => {
  assert.deepEqual(presenceClaimBody("user-1:hmi-abc", ["a.b", "c.d"], 1234), {
    live_tag_open: { "user-1:hmi-abc": { ts: 1234, tags: ["a.b", "c.d"] } },
  });
});

test("presence: clear body nulls only our slot", () => {
  assert.deepEqual(presenceClearBody("user-1:hmi-abc"), {
    live_tag_open: { "user-1:hmi-abc": null },
  });
});

// -- one-shot collection ----------------------------------------------------

test("collectOneShotValues: flattens the nested {app: {tag: value}} payload", () => {
  const entries = collectOneShotValues(
    { analog_level_sensor_1: { level_reading: 0.45 }, x: { y: { z: true } } },
    100,
  );
  assert.deepEqual(entries, [
    ["analog_level_sensor_1.level_reading", { value: 0.45, at: 100 }],
    ["x.y.z", { value: true, at: 100 }],
  ]);
});

test("collectOneShotValues: ignores non-object payloads", () => {
  assert.deepEqual(collectOneShotValues(null, 1), []);
  assert.deepEqual(collectOneShotValues([1, 2], 1), []);
  assert.deepEqual(collectOneShotValues("nope", 1), []);
});

test("applyLiveValues: newest wins, older frames never regress a value", () => {
  let live = applyLiveValues(new Map(), [["a.b", { value: 1, at: 10 }]]);
  live = applyLiveValues(live, [["a.b", { value: 2, at: 20 }]]);
  live = applyLiveValues(live, [["a.b", { value: 0, at: 15 }]]);
  assert.deepEqual(live.get("a.b"), { value: 2, at: 20 });
});

// -- overlay ----------------------------------------------------------------

const AGG = {
  analog_level_sensor_1: { level_reading: 0.4, level_volume: 2400 },
  "4_20ma_sensor_1": { value: 131 },
};

test("overlayLiveValues: writes newer live values over the aggregate, keeps the rest", () => {
  const live = new Map([
    ["analog_level_sensor_1.level_reading", { value: 0.9, at: 200 }],
    ["4_20ma_sensor_2.value", { value: 7, at: 210 }],
  ]);
  const out = overlayLiveValues(AGG, live, 100);
  assert.deepEqual(out.tagValues, {
    analog_level_sensor_1: { level_reading: 0.9, level_volume: 2400 },
    "4_20ma_sensor_1": { value: 131 },
    "4_20ma_sensor_2": { value: 7 },
  });
  assert.equal(out.liveAt, 210);
  assert.deepEqual(
    [...out.applied].sort(),
    ["4_20ma_sensor_2.value", "analog_level_sensor_1.level_reading"],
  );
});

test("overlayLiveValues: a live value older than the aggregate does not override", () => {
  const live = new Map([
    ["analog_level_sensor_1.level_reading", { value: 0.9, at: 50 }],
  ]);
  const out = overlayLiveValues(AGG, live, 100);
  assert.equal(out.tagValues, AGG); // same object: nothing applied
  assert.equal(out.liveAt, null);
  assert.equal(out.applied.size, 0);
});

test("overlayLiveValues: never mutates the aggregate it was given", () => {
  const before = JSON.stringify(AGG);
  overlayLiveValues(
    AGG,
    new Map([["analog_level_sensor_1.level_reading", { value: 1, at: 999 }]]),
    0,
  );
  assert.equal(JSON.stringify(AGG), before);
});

test("overlayLiveValues: works before the aggregate has loaded", () => {
  const out = overlayLiveValues(
    undefined,
    new Map([["4_20ma_sensor_1.value", { value: 3, at: 5 }]]),
    0,
  );
  assert.deepEqual(out.tagValues, { "4_20ma_sensor_1": { value: 3 } });
});

// -- tank volume (port of analog-level-sensor common_app.py _volume) ---------

test("deriveTankVolume: no curve → max_volume × percent", () => {
  assert.equal(deriveTankVolume(0.5, 41.5, { max_volume: 6000, volume_curve: [] }), 2490);
  assert.equal(deriveTankVolume(0.5, 41.5, { max_volume: "6000" }), 2490);
});

test("deriveTankVolume: no curve and no capacity → null", () => {
  assert.equal(deriveTankVolume(0.5, 41.5, {}), null);
  assert.equal(deriveTankVolume(0.5, null, { max_volume: 6000 }), null);
});

test("deriveTankVolume: curve interpolates on level and extrapolates off the ends", () => {
  const cfg = {
    max_volume: 9999, // ignored once a curve is present
    volume_curve: [
      { level: 1.0, volume: 1000 },
      { level: 0.0, volume: 0 }, // unsorted on purpose
      { level: 2.0, volume: 4000 },
    ],
  };
  assert.equal(deriveTankVolume(0.5, 99, cfg), 500);
  assert.equal(deriveTankVolume(1.5, 99, cfg), 2500);
  assert.equal(deriveTankVolume(2.5, 99, cfg), 5500); // off the top segment
  assert.equal(deriveTankVolume(-0.5, 99, cfg), -500); // off the bottom, like the app
  assert.equal(deriveTankVolume(null, 99, cfg), null);
});

test("deriveTankVolume: a one-point curve is ignored, like the app", () => {
  const cfg = { max_volume: 100, volume_curve: [{ level: 1, volume: 50 }] };
  assert.equal(deriveTankVolume(1, 50, cfg), 50);
});

const TANK_CFG = { max_volume: 6000, volume_curve: [] };

test("reconcileTankVolume: re-derives volume when level went live but volume did not", () => {
  const tags = {
    analog_level_sensor_1: {
      level_reading: 0.9,
      level_filled_percentage: 50,
      level_volume: 2400, // stale, from the last 15-minute flush
    },
  };
  const applied = new Set([
    "analog_level_sensor_1.level_reading",
    "analog_level_sensor_1.level_filled_percentage",
  ]);
  const out = reconcileTankVolume(tags, applied, "analog_level_sensor_1", TANK_CFG);
  assert.equal(out.analog_level_sensor_1.level_volume, 3000);
  assert.equal(tags.analog_level_sensor_1.level_volume, 2400); // input untouched
});

test("reconcileTankVolume: leaves a live volume alone", () => {
  const tags = { analog_level_sensor_1: { level_filled_percentage: 50, level_volume: 123 } };
  const applied = new Set([
    "analog_level_sensor_1.level_filled_percentage",
    "analog_level_sensor_1.level_volume",
  ]);
  assert.equal(reconcileTankVolume(tags, applied, "analog_level_sensor_1", TANK_CFG), tags);
});

test("reconcileTankVolume: no-op when nothing live, when volume is hidden, or config is empty", () => {
  const tags = { analog_level_sensor_1: { level_filled_percentage: 50, level_volume: 2400 } };
  assert.equal(reconcileTankVolume(tags, new Set(), "analog_level_sensor_1", TANK_CFG), tags);
  const hidden = { analog_level_sensor_1: { level_filled_percentage: 50 } };
  const applied = new Set(["analog_level_sensor_1.level_filled_percentage"]);
  assert.equal(reconcileTankVolume(hidden, applied, "analog_level_sensor_1", TANK_CFG), hidden);
  assert.equal(reconcileTankVolume(tags, applied, "analog_level_sensor_1", {}), tags);
  assert.equal(reconcileTankVolume(undefined, applied, "analog_level_sensor_1", TANK_CFG), undefined);
});

// -- host detection ---------------------------------------------------------

const cloudClient = () => ({
  clientId: "doover",
  gateway: { on() {}, off() {}, getSession: () => ({ session_id: "1" }) },
  users: { getMe: async () => ({ id: "u" }) },
  aggregates: { patchAggregate: async () => ({}) },
});

test("isLiveCapableClient: true for a doover-js-shaped cloud client", () => {
  assert.equal(isLiveCapableClient(cloudClient()), true);
});

test("isLiveCapableClient: false for the DDA local host client", () => {
  // Shape mirrors dda-agent/widget/src/dda-client.ts: a `users` stub whose
  // every property is a rejecting function, a gateway with no emitter, and
  // the local clientId. Each of those alone must be enough to say no.
  const stubApi = new Proxy({}, { get: () => () => Promise.reject(new Error("unsupported")) });
  const ddaLike = {
    clientId: "local-dda-http",
    gateway: { connect() {}, disconnect() {}, subscribeToChannel() {} },
    users: stubApi,
    aggregates: { patchAggregate: async () => ({}) },
  };
  assert.equal(isLiveCapableClient(ddaLike), false);
  assert.equal(isLiveCapableClient({ ...cloudClient(), clientId: "local-dda-http" }), false);
  assert.equal(isLiveCapableClient({ ...cloudClient(), gateway: ddaLike.gateway }), false);
  assert.equal(isLiveCapableClient(undefined), false);
});
