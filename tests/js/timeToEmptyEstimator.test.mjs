/**
 * Node tests for the stateful Time-to-Empty estimator in the shared render
 * core.
 *
 * hmi-core.js is framework-free and touches `document` only inside createHmi(),
 * so `createTimeToEmptyEstimator` imports and runs cleanly under `node --test`
 * with no DOM. The filter is the ONLY defence against the tank/flow ratio
 * shouting sensor noise at the operator (both shells render this same core), so
 * the fixtures below are the real readings measured on doovit-a0418e / "Solar
 * Skid 11" on 2026-09-10.
 *
 * Run: node --test tests/js/
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  createTimeToEmptyEstimator,
  formatTimeToEmpty,
} from "../../src/petronash_hmi/static/js/hmi-core.js";

const PLACEHOLDER = "—";
const T0 = Date.UTC(2026, 8, 10, 0, 0, 0); // 2026-09-10, the measurement day

/** Parse an "Xd Yh Zm" readout back into whole minutes, for spread asserts. */
function minutesOf(readout) {
  const parts = readout.match(/^(\d+)d (\d+)h (\d+)m$/);
  assert.ok(parts, `expected a d/h/m readout, got ${readout}`);
  return Number(parts[1]) * 24 * 60 + Number(parts[2]) * 60 + Number(parts[3]);
}

// The Skid 11 storage tank: 1585 gal capacity, sitting at ~81% with both
// pumps off. The flow sensor is a 0-10 GPH 4-20mA channel, so its 4 mA floor
// jitters by about one ADC LSB (~0.004 GPH).
const SKID11_CAPACITY = { value: 1585, units: "gal" };
const SKID11_NOISE_GPH = [
  0.0073, 0.0037, 0.0011, 0.0037, 0, 0, 0.0045, 0.0104, 0.0113,
];
// 1% of the sensor's 0-10 GPH range — the schema default.
const SKID11_MIN_FLOW = 0.1;

test("deadband blanks the readout for the measured pumps-off noise floor", () => {
  const estimator = createTimeToEmptyEstimator();
  const tank = {
    percent: 81,
    capacity: SKID11_CAPACITY,
    tte_min_flow: SKID11_MIN_FLOW,
    tte_smoothing_seconds: 300,
  };

  SKID11_NOISE_GPH.forEach((value, i) => {
    const readout = estimator.update(tank, { value, units: "GPH" }, T0 + i * 500);
    assert.equal(readout, PLACEHOLDER, `sample ${i} (${value} GPH) rendered ${readout}`);
  });
});

test("WITHOUT the deadband the same noise floor renders wildly different times", () => {
  // Documents the bug this filter exists to kill: at 2 Hz the readout
  // alternated between the em-dash and five-figure day counts.
  const estimator = createTimeToEmptyEstimator();
  const tank = {
    percent: 81,
    capacity: SKID11_CAPACITY,
    tte_min_flow: null,
    tte_smoothing_seconds: null,
  };

  const readouts = SKID11_NOISE_GPH.map((value, i) =>
    estimator.update(tank, { value, units: "GPH" }, T0 + i * 500),
  );

  // The two exact-zero samples blank; every other sample renders a number, and
  // those numbers are nowhere near each other.
  assert.ok(readouts.includes(PLACEHOLDER), "expected the zero samples to blank");
  const days = readouts
    .filter((r) => r !== PLACEHOLDER)
    .map((r) => minutesOf(r) / (24 * 60));
  assert.ok(days.length >= 6, `expected most samples to render, got ${days.length}`);
  assert.ok(
    Math.max(...days) / Math.min(...days) > 5,
    `expected a >5x spread across ${days.length} samples, got ${days.join(", ")}`,
  );
  // Every one of them is an absurd answer for a 1585 gal tank.
  assert.ok(Math.min(...days) > 1000, `expected thousands of days, got ${days.join(", ")}`);
});

test("the first sample after a reset seeds the average (no ramp from zero)", () => {
  const estimator = createTimeToEmptyEstimator();
  const tank = {
    percent: 60,
    capacity: SKID11_CAPACITY,
    tte_min_flow: SKID11_MIN_FLOW,
    tte_smoothing_seconds: 300,
  };
  const flow = { value: 5, units: "GPH" };

  assert.equal(estimator.update(tank, flow, T0), formatTimeToEmpty(tank, flow));
});

// A running pump on the kiosk's 2 Hz loop: 5 GPH ± 0.15 with the tank level
// jittering ± 0.3%, sampled for 5 minutes (600 samples).
function noisyRunningSample(i, seedSign) {
  const sign = i % 2 === 0 ? seedSign : -seedSign;
  return {
    flow: { value: 5 + 0.15 * sign, units: "GPH" },
    percent: 60 - 0.3 * sign,
  };
}

function noisyRunningTank(percent) {
  return {
    percent,
    capacity: SKID11_CAPACITY,
    tte_min_flow: SKID11_MIN_FLOW,
    tte_smoothing_seconds: 300,
  };
}

test("smoothing holds a noisy running flow steady (raw moves by hours)", () => {
  // Seeded at the centre of the noise band, which is where a seed lands on
  // average: the readout must then simply not move, while the same samples
  // unfiltered swing by the better part of half a day. That swing, twice a
  // second, is what the operator was watching.
  const estimator = createTimeToEmptyEstimator();
  const smoothed = [];
  const raw = [];

  smoothed.push(
    minutesOf(
      estimator.update(noisyRunningTank(60), { value: 5, units: "GPH" }, T0),
    ),
  );
  for (let i = 1; i < 600; i += 1) {
    const { flow, percent } = noisyRunningSample(i, 1);
    const tank = noisyRunningTank(percent);
    smoothed.push(minutesOf(estimator.update(tank, flow, T0 + i * 500)));
    raw.push(minutesOf(formatTimeToEmpty(tank, flow)));
  }

  // The first 30 s are the warm-up mean (1/n), which is still averaging the
  // alternating samples in pairs; from then on the readout must not move.
  const settled = smoothed.slice(60);
  const spread = Math.max(...settled) - Math.min(...settled);
  assert.ok(spread < 10, `smoothed readout moved ${spread} min across 5 minutes`);

  const rawSpread = Math.max(...raw) - Math.min(...raw);
  assert.ok(
    rawSpread > 300,
    `expected the raw readout to swing by hours, got ${rawSpread} min`,
  );
});

test("a seed on a noise extreme walks to the truth, settling within 30 s", () => {
  // The seed is ONE raw sample, so in the field it lands on a noise extreme
  // half the time and the average has to walk off it. The warm-up mean (1/n)
  // does that walk in seconds — the first few frames after a seed visibly
  // settle, with steps shrinking as 1/n — and from 30 s on the readout must
  // be calm: nothing that reads as a flicker between consecutive 2 Hz frames.
  for (const seedSign of [1, -1]) {
    const estimator = createTimeToEmptyEstimator();
    const smoothed = [];
    for (let i = 0; i < 600; i += 1) {
      const { flow, percent } = noisyRunningSample(i, seedSign);
      smoothed.push(
        minutesOf(estimator.update(noisyRunningTank(percent), flow, T0 + i * 500)),
      );
    }

    // Once the warm-up mean holds a minute of samples (the alternating ±3 %
    // pair-averaging step has shrunk to a few minutes), no step between
    // consecutive frames may read as a flicker.
    const settled = smoothed.slice(120);
    const biggestStep = Math.max(
      ...settled.slice(1).map((v, i) => Math.abs(v - settled[i])),
    );
    assert.ok(
      biggestStep < 5,
      `seed ${seedSign}: readout jumped ${biggestStep} min between 2 Hz samples`,
    );

    // And the walk goes the right way, fast: the seed is hours off the truth
    // and 30 s later the readout is within a few minutes of it.
    const truth = minutesOf(
      formatTimeToEmpty(noisyRunningTank(60), { value: 5, units: "GPH" }),
    );
    const seedError = Math.abs(smoothed[0] - truth);
    const errorAt30s = Math.abs(smoothed[60] - truth);
    assert.ok(
      seedError > 300,
      `seed ${seedSign}: expected the raw seed to be hours off, got ${seedError} min`,
    );
    assert.ok(
      errorAt30s < 15,
      `seed ${seedSign}: 30 s after the seed the error was still ${errorAt30s} min`,
    );
  }
});

test("a pump start converges within seconds despite seeding on the sensor's ramp", () => {
  // The first sample past the deadband on a pump start is the 4-20mA app's
  // own Kalman ramp (K ≈ 0.62 towards the true flow), the least representative
  // reading there is. A pure EMA would carry that seed for a full tau and
  // over-report the time left by 60 %+ for minutes after every start; the
  // warm-up mean forgets it in seconds. Numbers from the Skid 11 fixture.
  const tank = {
    percent: 81,
    capacity: SKID11_CAPACITY,
    tte_min_flow: SKID11_MIN_FLOW,
    tte_smoothing_seconds: 300,
  };
  const truth = minutesOf(formatTimeToEmpty(tank, { value: 5, units: "GPH" }));
  const estimator = createTimeToEmptyEstimator();
  const errorAt = {};
  let kalman = 0;
  for (let i = 0; i <= 120; i += 1) {
    kalman += 0.618 * (5 - kalman);
    const flow = { value: kalman * (1 + (i % 2 ? 0.002 : -0.002)), units: "GPH" };
    const readout = estimator.update(tank, flow, T0 + i * 500);
    if (readout !== PLACEHOLDER) {
      errorAt[i / 2] = Math.abs(minutesOf(readout) / truth - 1);
    }
  }
  assert.ok(errorAt[0] > 0.3, `the ramp seed should be far off, got ${errorAt[0]}`);
  assert.ok(errorAt[10] < 0.04, `10 s after the start the error was ${errorAt[10]}`);
  assert.ok(errorAt[30] < 0.02, `30 s after the start the error was ${errorAt[30]}`);
  assert.ok(errorAt[60] < 0.01, `60 s after the start the error was ${errorAt[60]}`);
});

test("dropping below the deadband resets, so the next valid sample re-seeds", () => {
  const estimator = createTimeToEmptyEstimator();
  const tank = {
    percent: 60,
    capacity: SKID11_CAPACITY,
    tte_min_flow: SKID11_MIN_FLOW,
    tte_smoothing_seconds: 300,
  };

  for (let i = 0; i < 20; i += 1) {
    estimator.update(tank, { value: 5, units: "GPH" }, T0 + i * 500);
  }
  const atFive = formatTimeToEmpty(tank, { value: 5, units: "GPH" });

  // Pump stops: the noise floor is below the deadband, so the readout blanks
  // immediately rather than decaying towards it.
  assert.equal(
    estimator.update(tank, { value: 0.004, units: "GPH" }, T0 + 20 * 500),
    PLACEHOLDER,
  );

  // Pump restarts at a different rate: a fresh seed, NOT a slow decay from 5.
  const restart = { value: 1, units: "GPH" };
  const after = estimator.update(tank, restart, T0 + 21 * 500);
  assert.equal(after, formatTimeToEmpty(tank, restart));
  assert.notEqual(after, atFive);
});

test("a steady flow just above the deadband renders, whatever the page history", () => {
  // Any flow at or above the threshold renders, always. A "re-arm only with
  // clear margin" hysteresis ABOVE the threshold reads as sensible
  // anti-chatter until you price it: any steady flow inside the margin becomes
  // permanently invisible. A channel left on the 4-20mA app's default 0-100
  // range with the 1% default deadband sits at 1.0 GPH, so a real 1.2 GPH
  // injection would render an em-dash all shift with the pump plainly running
  // — and, because the margin is carried in filter state, an operator who had
  // F5'd would see a different answer from one who had not. The hysteresis
  // therefore lives BELOW the threshold (next test).
  const tank = {
    percent: 81,
    capacity: SKID11_CAPACITY,
    tte_min_flow: 1.0,
    tte_smoothing_seconds: 300,
  };
  const flow = { value: 1.2, units: "GPH" };
  const expected = formatTimeToEmpty(tank, flow);
  assert.notEqual(expected, PLACEHOLDER);

  // Cold mount: rendered from the very first sample and every one after.
  const fresh = createTimeToEmptyEstimator();
  for (let i = 0; i < 600; i += 1) {
    const readout = fresh.update(tank, flow, T0 + i * 500);
    assert.equal(readout, expected, `sample ${i} rendered ${readout}`);
  }

  // And after a blanking event (pump off, or a dropped flow tag), the same
  // steady flow comes straight back rather than needing to clear a margin.
  const blanked = createTimeToEmptyEstimator();
  blanked.update(tank, { value: 5, units: "GPH" }, T0);
  assert.equal(blanked.update(tank, { value: null, units: "GPH" }, T0 + 500), PLACEHOLDER);
  assert.equal(blanked.update(tank, flow, T0 + 1000), expected);
});

test("a backwards clock step does not freeze the readout", () => {
  // A kiosk page lives for weeks and update() is fed Date.now(), so an NTP
  // correction on a device with no RTC can hand the filter a timestamp in the
  // past. Discarding those samples is right; discarding every sample until the
  // clock catches up is not — the readout looked live while sitting on a value
  // half an hour stale.
  const estimator = createTimeToEmptyEstimator();
  const tank = {
    percent: 60,
    capacity: SKID11_CAPACITY,
    tte_min_flow: SKID11_MIN_FLOW,
    tte_smoothing_seconds: 300,
  };

  const seeded = estimator.update(tank, { value: 5, units: "GPH" }, T0);
  const stepped = { value: 10, units: "GPH" };
  const truth = minutesOf(formatTimeToEmpty(tank, stepped));

  // The clock jumps 30 minutes backwards, then the flow doubles. Six time
  // constants of 2 Hz samples later the average must have followed it.
  const back = T0 - 30 * 60_000;
  let readout = null;
  for (let i = 0; i < 3600; i += 1) {
    readout = estimator.update(tank, stepped, back + i * 500);
  }

  assert.notEqual(readout, seeded, "readout froze on the pre-jump value");
  assert.ok(
    Math.abs(minutesOf(readout) - truth) / truth < 0.05,
    `expected within 5% of ${truth} min after the step, got ${minutesOf(readout)} min`,
  );
});

test("tau null or 0 behaves exactly like formatTimeToEmpty", () => {
  for (const tau of [null, 0]) {
    const estimator = createTimeToEmptyEstimator();
    for (let i = 0; i < 20; i += 1) {
      const { flow, percent } = noisyRunningSample(i, 1);
      const tank = {
        percent,
        capacity: SKID11_CAPACITY,
        tte_min_flow: SKID11_MIN_FLOW,
        tte_smoothing_seconds: tau,
      };
      assert.equal(
        estimator.update(tank, flow, T0 + i * 500),
        formatTimeToEmpty(tank, flow),
        `tau=${tau} sample ${i} did not pass the raw value through`,
      );
    }
  }
});

test("cloud cadence (dt 900 s, tau 300) tracks a step change essentially fully", () => {
  // The 15-minute persisted-aggregate path: alpha = 1 - exp(-3) = 0.95, so one
  // update lands within a few percent of the new reading instead of lagging it
  // by hours. Same tau, very different sample rate — that is why the EMA is
  // time-based rather than per-sample.
  const estimator = createTimeToEmptyEstimator();
  const tank = {
    percent: 60,
    capacity: SKID11_CAPACITY,
    tte_min_flow: SKID11_MIN_FLOW,
    tte_smoothing_seconds: 300,
  };

  estimator.update(tank, { value: 5, units: "GPH" }, T0);
  const stepped = { value: 10, units: "GPH" };
  const after = minutesOf(estimator.update(tank, stepped, T0 + 900_000));
  const target = minutesOf(formatTimeToEmpty(tank, stepped));

  assert.ok(
    Math.abs(after - target) / target < 0.05,
    `expected within 5% of ${target} min, got ${after} min`,
  );
});

test("a change of flow units resets and re-seeds (the old average is a different basis)", () => {
  const estimator = createTimeToEmptyEstimator();
  const tank = {
    percent: 60,
    capacity: SKID11_CAPACITY,
    tte_min_flow: null,
    tte_smoothing_seconds: 300,
  };

  for (let i = 0; i < 20; i += 1) {
    estimator.update(tank, { value: 5, units: "GPH" }, T0 + i * 500);
  }

  // 30 GPD is a far SLOWER drain than 5 GPH; averaging the two numbers would
  // be meaningless, so the switch seeds afresh.
  const perDay = { value: 30, units: "GPD" };
  assert.equal(
    estimator.update(tank, perDay, T0 + 20 * 500),
    formatTimeToEmpty(tank, perDay),
  );
});

test("a non-finite nowMs falls back to the unsmoothed reading", () => {
  const tank = {
    percent: 60,
    capacity: SKID11_CAPACITY,
    tte_min_flow: SKID11_MIN_FLOW,
    tte_smoothing_seconds: 300,
  };

  const fresh = createTimeToEmptyEstimator();
  const flow = { value: 5.15, units: "GPH" };
  assert.equal(fresh.update(tank, flow, NaN), formatTimeToEmpty(tank, flow));

  // Also mid-stream: with no usable clock there is no way to size alpha, so the
  // raw reading is shown rather than a dt being invented.
  const seeded = createTimeToEmptyEstimator();
  seeded.update(tank, { value: 5, units: "GPH" }, T0);
  const jumped = { value: 8, units: "GPH" };
  assert.equal(seeded.update(tank, jumped, undefined), formatTimeToEmpty(tank, jumped));
});

test("reset() drops the state, so the next sample seeds", () => {
  const estimator = createTimeToEmptyEstimator();
  const tank = {
    percent: 60,
    capacity: SKID11_CAPACITY,
    tte_min_flow: null,
    tte_smoothing_seconds: 300,
  };

  for (let i = 0; i < 20; i += 1) {
    estimator.update(tank, { value: 5, units: "GPH" }, T0 + i * 500);
  }
  estimator.reset();

  const restart = { value: 1, units: "GPH" };
  assert.equal(
    estimator.update(tank, restart, T0 + 20 * 500),
    formatTimeToEmpty(tank, restart),
  );
});

test("jitter on the deadband threshold does not flash the readout (release at 0.8x)", () => {
  // A dosing pump running right at the deadband — 1.00 ± 0.04 GPH against a
  // 1.0 GPH threshold, the Kalman-filtered jitter measured on the skids — must
  // not alternate dash/number at loop rate: that is the exact flicker this
  // estimator exists to remove. Once showing, the readout releases only when
  // the raw flow falls under 0.8x the threshold.
  const tank = {
    percent: 81,
    capacity: SKID11_CAPACITY,
    tte_min_flow: 1.0,
    tte_smoothing_seconds: 300,
  };
  const est = createTimeToEmptyEstimator();
  // Arm on the first at-threshold sample.
  assert.notEqual(est.update(tank, { value: 1.0, units: "GPH" }, T0), PLACEHOLDER);
  let shown = 0;
  for (let i = 1; i <= 600; i += 1) {
    const value = i % 2 === 0 ? 1.04 : 0.96; // straddles the threshold every sample
    const readout = est.update(tank, { value, units: "GPH" }, T0 + i * 500);
    if (readout !== PLACEHOLDER) shown += 1;
  }
  assert.equal(shown, 600, "the readout blanked while the flow straddled the threshold");

  // Below the release point it blanks at once, and a flow in the release band
  // is NOT enough to bring it back — only the full threshold re-arms.
  assert.equal(est.update(tank, { value: 0.79, units: "GPH" }, T0 + 400_000), PLACEHOLDER);
  assert.equal(est.update(tank, { value: 0.9, units: "GPH" }, T0 + 400_500), PLACEHOLDER);
  assert.notEqual(est.update(tank, { value: 1.0, units: "GPH" }, T0 + 401_000), PLACEHOLDER);

  // Cold mount inside the release band stays blank: history never lowers the
  // bar for a readout that was not already showing.
  const cold = createTimeToEmptyEstimator();
  for (let i = 0; i < 20; i += 1) {
    assert.equal(cold.update(tank, { value: 0.9, units: "GPH" }, T0 + i * 500), PLACEHOLDER);
  }

  // The hysteresis is a property of the deadband, not of the smoothing: it
  // holds with tau off too.
  const noTau = createTimeToEmptyEstimator();
  const raw = { ...tank, tte_smoothing_seconds: null };
  assert.notEqual(noTau.update(raw, { value: 1.0, units: "GPH" }, T0), PLACEHOLDER);
  assert.notEqual(noTau.update(raw, { value: 0.96, units: "GPH" }, T0 + 500), PLACEHOLDER);
  assert.equal(noTau.update(raw, { value: 0.79, units: "GPH" }, T0 + 1000), PLACEHOLDER);
});
