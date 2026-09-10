/**
 * Petronash HMI render core.
 *
 * Framework-free ES module shared by BOTH shells:
 *   - the device-local dashboard (static/js/dashboard.js, socket.io fed), and
 *   - the Doover cloud widget (widget/src/PetronashHmiWidget.tsx, doover-js fed).
 *
 * It owns all DOM construction for the HMI tiles and the alert popover, and
 * renders exclusively from the DashboardData v2 dict (the socket.io
 * `data_update` payload contract):
 *
 * {
 *   "pumps":    { "pump_1": {"on": true|false|null}, "pump_2": {"on": ...} },
 *   "pressure": { "value": 3.2|null, "units": "PSI",
 *                 "high_alarm": 1500.0|null, "low_alarm": null,
 *                 "high_alarm_active": true, "low_alarm_active": false },
 *   "flow":     { "value": 26.4|null, "units": "GPD",
 *                 "high_alarm": 63.3|null, "low_alarm": 34.2|null,
 *                 "high_alarm_active": true, "low_alarm_active": true },
 *   "volume":   { "total": 58213.0|null, "segment_total": 12840.0|null,
 *                 "units": "gal" },
 *   "segment":  { "name": "Pipeline A"|null },
 *   "tank":     { "percent": 48.8|null, "level_mm": 19030.0|null,
 *                 "depth_units": "m"|"cm"|"mm"|"in"|"ft",
 *                 "volume": 4880.0|null, "volume_units": "L"|null,
 *                 "volume_precision": 0,
 *                 "capacity": { "value": 100000|null, "units": "L"|"gal"|null },
 *                 "high_alarm": 56.2|null, "low_alarm": null,
 *                 "alarm_units": "%"|"L"|"ft"|null,
 *                 "high_alarm_active": true, "low_alarm_active": false,
 *                 "time_alarm_hours": 24|null,
 *                 "tte_min_flow": 0.1|null,
 *                 "tte_smoothing_seconds": 300|null },
 *   "units":    { "length": "inch"|"mm" },
 *   "alerts":   { "unexpected_flow": false, "low_flow": false,
 *                 "low_tank_time": false },
 *   "system":   { "timestamp": "<iso>", "status": "running" }
 * }
 *
 * null (or a missing key) means "no data" and renders as an em-dash
 * placeholder — never as 0.
 *
 * Deliberately NO socket.io, NO fetch, NO globals, NO controls (read-only).
 * Styling comes from static/css/hmi-core.css — every selector is scoped
 * under the .hmi-root class this module adds to its root element, so the
 * stylesheet is safe to inject into the cloud UI.
 */

const PLACEHOLDER = "—"; // em dash

/** Format a finite number to `digits` decimals, else the placeholder. */
function fmtNumber(value, digits = 1) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        return PLACEHOLDER;
    }
    return value.toFixed(digits);
}

// Multiplier from metres (the sensor's working unit) to each Depth Unit, and
// the decimal places to show for it. The tank depth is shown in the sensor's
// configured Depth Units, not the HMI's own display_units.
const DEPTH_PER_METRE = { m: 1, cm: 100, mm: 1000, in: 39.3700787, ft: 3.2808399 };
const DEPTH_PRECISION = { m: 2, cm: 1, mm: 0, in: 1, ft: 2 };

/** Format a depth given in millimetres into the sensor's Depth Units. */
function fmtDepth(levelMm, depthUnits) {
    const unit = depthUnits || "m";
    if (typeof levelMm !== "number" || !Number.isFinite(levelMm)) {
        return { value: PLACEHOLDER, unit };
    }
    const metres = levelMm / 1000;
    const factor = unit in DEPTH_PER_METRE ? DEPTH_PER_METRE[unit] : 1;
    const precision = unit in DEPTH_PRECISION ? DEPTH_PRECISION[unit] : 2;
    return { value: (metres * factor).toFixed(precision), unit };
}

// ---- Tank time-to-empty ------------------------------------------------
//
// Estimated time until the tank drains at the CURRENT flow rate, computed
// entirely here (both shells' assemblers stay dumb pass-throughs — the tank
// capacity is folded into DashboardData v2 as tank.capacity {value, units}
// and ALL math + unit handling lives in this one place, so the two shells can
// never diverge). Display-only: ignores any inflow.

const LITRES_PER_GALLON = 3.78541; // 1 US gallon

// Flow-rate unit -> multiplier converting flow.value to a per-DAY basis.
// The volume component of every recognised flow unit is US gallons.
const FLOW_PER_DAY_FACTOR = { GPD: 1, GPH: 24, GPM: 1440, GPS: 86400 };

/** Classify a volume-unit string to "L" | "gal" | null (unrecognised). */
function volumeClass(units) {
    const u = typeof units === "string" ? units.trim().toLowerCase() : "";
    if (["l", "litre", "liter", "litres", "liters"].includes(u)) {
        return "L";
    }
    if (["gal", "gallon", "gallons", "g", "us gal"].includes(u)) {
        return "gal";
    }
    return null;
}

/** Multiplier converting a volume in `fromUnits` to `toUnits`.
 *  Identity when the classes match; if either is unrecognised we assume the
 *  same volume unit and skip conversion (multiplier 1). */
function volumeConversion(fromUnits, toUnits) {
    const from = volumeClass(fromUnits);
    const to = volumeClass(toUnits);
    if (from === null || to === null || from === to) {
        return 1;
    }
    return from === "gal" ? LITRES_PER_GALLON : 1 / LITRES_PER_GALLON;
}

/** Format a positive day count as "Xd Yh Zm" (rounded to the nearest minute,
 *  so floating-point drift never turns a clean 1 day into "23h 59m"). */
function formatDHM(days) {
    let minutes = Math.round(days * 24 * 60);
    if (!Number.isFinite(minutes) || minutes < 0) {
        return PLACEHOLDER;
    }
    const d = Math.floor(minutes / (24 * 60));
    minutes -= d * 24 * 60;
    const h = Math.floor(minutes / 60);
    const m = minutes - h * 60;
    return `${d}d ${h}h ${m}m`;
}

/**
 * Estimate the time until the tank empties at the current flow, formatted as
 * "Xd Yh Zm", or the em-dash placeholder when it cannot be computed.
 *
 * Renders the placeholder (never 0 or a bogus number) when: flow.value is null
 * or <= 0 (not draining / pumps off), tank.percent is null, capacity is
 * missing, the flow-rate basis is unrecognised, or the result is non-finite.
 *
 * @param {object} tank - DashboardData v2 `tank` block (percent + capacity)
 * @param {object} flow - DashboardData v2 `flow` block (value + units)
 * @returns {string}
 */
export function formatTimeToEmpty(tank, flow) {
    const capacity = tank && tank.capacity;
    const capValue =
        capacity && typeof capacity.value === "number" && Number.isFinite(capacity.value)
            ? capacity.value
            : null;
    const percent =
        tank && typeof tank.percent === "number" && Number.isFinite(tank.percent)
            ? tank.percent
            : null;
    const flowValue =
        flow && typeof flow.value === "number" && Number.isFinite(flow.value)
            ? flow.value
            : null;

    if (capValue === null || percent === null) {
        return PLACEHOLDER;
    }
    if (flowValue === null || flowValue <= 0) {
        return PLACEHOLDER;
    }

    const flowUnits = flow && typeof flow.units === "string" ? flow.units.trim().toUpperCase() : "";
    const perDayFactor = FLOW_PER_DAY_FACTOR[flowUnits];
    if (!perDayFactor) {
        return PLACEHOLDER; // unrecognised flow-rate basis — cannot estimate
    }

    // current_volume in capacity.units; outflow converted to the same units.
    const currentVolume = capValue * (percent / 100);
    const flowPerDayGal = flowValue * perDayFactor;
    const flowPerDayInCapUnits =
        flowPerDayGal * volumeConversion("gal", capacity.units);

    const daysToEmpty = currentVolume / flowPerDayInCapUnits;
    if (!Number.isFinite(daysToEmpty) || daysToEmpty < 0) {
        return PLACEHOLDER;
    }
    return formatDHM(daysToEmpty);
}

/**
 * Read an optional positive tuning number off the tank block.
 *
 * Both TTE tuning fields are "off" in three interchangeable ways — absent,
 * null, or <= 0 — because an operator zeroing the config field in the Doover
 * UI must mean the same thing as an install that predates the field entirely.
 */
function positiveOrNull(value) {
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

// Once the Time-to-Empty readout is showing, the deadband releases at this
// fraction of tte_min_flow rather than at tte_min_flow itself (hysteresis
// BELOW the threshold — see createTimeToEmptyEstimator). 0.8 clears the
// ±4 % Kalman-filtered jitter measured on the skids with room to spare while
// still blanking well before a stopped pump's noise floor.
const TTE_RELEASE_RATIO = 0.8;

/**
 * Create a stateful Time-to-Empty estimator: a deadband plus a time-based EMA
 * wrapped around the pure formatTimeToEmpty().
 *
 * WHY this exists: tank_volume / flow is a ratio of two noisy sensor readings,
 * so it is far noisier than either. Measured on Solar Skid 11 with both pumps
 * off, the 0-10 GPH flow sensor jitters 0.000..0.011 GPH around its 4 mA floor
 * (about one ADC LSB) — dividing a 1585 gal tank by that made the readout
 * alternate between the em-dash and "13375d 4h 12m" twice a second. With a
 * pump actually running the same jitter still churns the minutes digit at loop
 * rate. Neither is a real reading changing; both are the display shouting the
 * sensor's noise floor at the operator.
 *
 * Two guards, both configured per install and carried on the tank block:
 *   - tank.tte_min_flow — a deadband in the flow's OWN units. Below it there is
 *     no measurable outflow, so no honest estimate exists: show the placeholder
 *     rather than a number with four bogus significant figures.
 *   - tank.tte_smoothing_seconds — the time constant (tau) of an exponential
 *     moving average over the flow AND the tank percentage. Time-based rather
 *     than sample-based so the same tau behaves identically on the kiosk's 2 Hz
 *     loop and the cloud widget's 15-minute aggregate cadence.
 *
 * The deadband is a threshold on the RAW flow. Any reading at or above
 * tte_min_flow ALWAYS renders, whatever happened before — the readout must be
 * a function of the data, not of when the page happened to be mounted, and a
 * re-arm margin ABOVE the threshold would make a steady flow inside that margin
 * permanently invisible (an install left on the 4-20mA app's default 0-100
 * range injecting ~1 GPH would show a dash forever, pump plainly running). The
 * hysteresis therefore sits BELOW the threshold: once showing, the readout only
 * blanks when the raw flow falls under TTE_RELEASE_RATIO x tte_min_flow (or to
 * zero). A flow sitting right on the threshold with sensor jitter either side
 * then stays shown instead of flashing dash/number at loop rate — the exact
 * flicker this estimator exists to remove.
 *
 * Gating on the raw value rather than the smoothed one matters for the same
 * reason: a pump stopping must blank the readout at once (not decay towards it
 * over a time constant), and a pump starting must seed a fresh filter rather
 * than ramp up out of the noise floor it was sitting in.
 *
 * The EMA is the textbook time-based one, alpha = 1 - exp(-dt/tau), with a
 * warm-up: while fewer than about a tau's worth of samples have been folded
 * in, alpha is floored at 1/n so the average is a plain mean of everything
 * since the seed. The seed is the first sample past the deadband, which on a
 * pump start is the flow sensor's own Kalman ramp (K ≈ 0.6: 0 → 3.1 → 4.3 →
 * 4.7 GPH for a 5 GPH step); a pure EMA would carry that seed for a full tau
 * and over-report the time left by 60 %+ after every start, whereas the mean
 * is within a few percent inside 30 s. The cost is that the first seconds
 * after a start visibly settle (steps shrinking as 1/n) — the operator sees a
 * value converging, never one flickering at steady state.
 *
 * Stateful, so it lives in a closure per HMI instance; framework-free and
 * DOM-free like the rest of this module.
 *
 * @returns {{update: (tank: object, flow: object, nowMs: number) => string,
 *            reset: () => void}}
 */
export function createTimeToEmptyEstimator() {
    let lastMs = null;
    let lastUnits = null;
    let smoothedFlow = null;
    let smoothedPercent = null;
    // Samples folded into the current average, for the warm-up window.
    let sampleCount = 0;
    // True while the readout is showing a number: the deadband then releases
    // at TTE_RELEASE_RATIO x tte_min_flow instead of at tte_min_flow itself.
    let showing = false;

    /** Drop the filter state, so the next valid sample seeds a fresh average. */
    function reset() {
        lastMs = null;
        lastUnits = null;
        smoothedFlow = null;
        smoothedPercent = null;
        sampleCount = 0;
        showing = false;
    }

    /**
     * Fold one sample in and return the display string.
     *
     * @param {object} tank - DashboardData v2 `tank` block (percent, capacity,
     *   plus the optional tte_min_flow / tte_smoothing_seconds tuning)
     * @param {object} flow - DashboardData v2 `flow` block (value + units)
     * @param {number} nowMs - sample time, epoch ms (Date.now())
     * @returns {string} "Xd Yh Zm", or the em-dash placeholder
     */
    function update(tank, flow, nowMs) {
        const tankData = tank || {};
        const flowData = flow || {};

        const rawFlow =
            typeof flowData.value === "number" && Number.isFinite(flowData.value)
                ? flowData.value
                : null;
        const minFlow = positiveOrNull(tankData.tte_min_flow);

        // Deadband, on the raw reading — see the note above on why this must
        // not look at the smoothed value. Arms at tte_min_flow, releases at
        // TTE_RELEASE_RATIO x tte_min_flow once showing, so jitter around the
        // threshold cannot flash the readout.
        const blankBelow =
            minFlow === null ? null : showing ? minFlow * TTE_RELEASE_RATIO : minFlow;
        if (rawFlow === null || rawFlow <= 0 || (blankBelow !== null && rawFlow < blankBelow)) {
            reset();
            return PLACEHOLDER;
        }

        const readout = smoothedReadout(tankData, flowData, rawFlow, nowMs);
        // Latch the hysteresis only on a rendered number: a frame that still
        // shows the em-dash (capacity not loaded yet, unknown flow unit) must
        // not lower the bar for a later frame — two browsers on the same data
        // would otherwise disagree depending on when each was opened.
        if (readout !== PLACEHOLDER) {
            showing = true;
        }
        return readout;
    }

    /** The smoothing half of update(): fold the sample in, format the result. */
    function smoothedReadout(tankData, flowData, rawFlow, nowMs) {
        const tau = positiveOrNull(tankData.tte_smoothing_seconds);
        if (tau === null) {
            // Smoothing disabled: behave exactly like the pure helper, and hold
            // no averages so switching it back on seeds rather than resumes.
            // (Only the averages are dropped — the deadband's "showing" state
            // must survive, or the hysteresis would vanish with smoothing off.)
            lastMs = null;
            lastUnits = null;
            smoothedFlow = null;
            smoothedPercent = null;
            sampleCount = 0;
            return formatTimeToEmpty(tankData, flowData);
        }

        const rawPercent =
            typeof tankData.percent === "number" && Number.isFinite(tankData.percent)
                ? tankData.percent
                : null;
        if (rawPercent === null) {
            // No level reading: nothing to average, and formatTimeToEmpty will
            // render the placeholder anyway. Keep the state untouched — a gap
            // in the level tag is not a reason to throw the flow average away,
            // and leaving lastMs alone keeps dt honest across the gap.
            return formatTimeToEmpty(tankData, flowData);
        }

        if (typeof nowMs !== "number" || !Number.isFinite(nowMs)) {
            // No usable clock, so no way to size alpha. Fall back to the raw
            // reading for this sample rather than inventing a dt.
            return formatTimeToEmpty(tankData, flowData);
        }

        const units = typeof flowData.units === "string" ? flowData.units : null;

        if (smoothedFlow === null || lastMs === null || units !== lastUnits) {
            // Seed with the raw sample (never ramp up from zero — the first
            // reading after a start is the best estimate we have). A units
            // change means the previous average is in a different basis
            // entirely, so it is thrown away rather than converted.
            smoothedFlow = rawFlow;
            smoothedPercent = rawPercent;
            sampleCount = 1;
            lastMs = nowMs;
            lastUnits = units;
        } else {
            const dt = (nowMs - lastMs) / 1000;
            if (Number.isFinite(dt) && dt > 0) {
                // Warm-up: until the average holds about one tau of samples
                // it is a plain mean (alpha = 1/n), then the EMA takes over.
                // The seed is the first sample past the deadband — on a pump
                // start that is the sensor's own ramp, the least
                // representative reading there is — and a pure EMA would carry
                // that seed for a full tau, over-reporting the time left by
                // 60 %+ after every start. The mean forgets it in seconds.
                sampleCount += 1;
                const alpha = Math.max(1 - Math.exp(-dt / tau), 1 / sampleCount);
                smoothedFlow += alpha * (rawFlow - smoothedFlow);
                smoothedPercent += alpha * (rawPercent - smoothedPercent);
                lastMs = nowMs;
            } else {
                // dt <= 0: a repeated timestamp, or a wall clock stepped
                // backwards under this long-lived page (an NTP correction on a
                // device with no RTC). Fold nothing in — a negative dt is not a
                // negative-weight sample — but DO re-anchor to the new clock,
                // otherwise every later sample is discarded as "in the past"
                // too and the readout silently freezes for the whole length of
                // the jump while the real flow changes underneath it.
                lastMs = nowMs;
            }
        }

        return formatTimeToEmpty(
            { ...tankData, percent: smoothedPercent },
            { ...flowData, value: smoothedFlow },
        );
    }

    return { update, reset };
}

/** Build an element with class + optional text. */
function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) {
        node.className = className;
    }
    if (text !== undefined) {
        node.textContent = text;
    }
    return node;
}

/** A "big value + unit" readout. Returns {root, value, unit}. */
function valueDisplay(initialUnit) {
    const root = el("div", "value-display");
    const value = el("span", "value", PLACEHOLDER);
    const unit = el("span", "unit", initialUnit || "");
    root.append(value, unit);
    return { root, value, unit };
}

/** An "Alarm: <value> <unit>" setpoint readout. Returns {root, value, unit}. */
function alarmLevel(label, initialUnit) {
    const root = el("div", "alarm-level");
    const value = el("span", "alarm-value", PLACEHOLDER);
    const unit = el("span", "alarm-unit", initialUnit || "");
    root.append(el("span", "alarm-label", label), value, unit);
    return { root, value, unit };
}

/**
 * Render one alarm-setpoint row.
 *
 * Only the bounds a sensor's alarm_type arms are shown: a "Greater Than" alarm
 * has no low bound, so an empty "Low Alarm" row would imply a setpoint that
 * cannot exist. `active` is about CONFIG, not value — an armed bound whose
 * slider was never dragged still shows, as the em-dash. The core cannot infer
 * this from a null value, so the assemblers pass it explicitly.
 */
function renderAlarmRow(row, active, value, units) {
    row.root.style.display = active === true ? "" : "none";
    row.value.textContent = fmtNumber(value);
    row.unit.textContent = units || "";
}

/** A titled control card. Returns the card element (children appended). */
function card(title, ...children) {
    const root = el("div", "control-card");
    root.append(el("h3", "", title), ...children);
    return root;
}

/** A titled column section. */
function section(extraClass, heading, ...children) {
    const root = el("section", `control-section ${extraClass}`);
    root.append(el("h2", "", heading), ...children);
    return root;
}

/** Build a logo <img> with its src, alt text and class. */
function logoImg(src, alt, className) {
    const img = el("img", className);
    img.src = src;
    img.alt = alt;
    return img;
}

/**
 * Build the branded header bar shown ABOVE the alert banner and tiles:
 * Petronash · Remote-Command wordmark · "SIA Remote Command" · Aramco, in one
 * centred title row. Rendered only when the embedder supplies opts.logos (the
 * render core is framework-free and cannot import images itself), so a non-logo
 * embedder gets no header. Both widget hosts — the Doover cloud UI and the DDA
 * local widget host — pass the logos in.
 *
 * @param {{petronash: string, remoteCommand: string, aramco: string}} logos
 * @returns {HTMLElement}
 */
function buildHeader(logos) {
    const title = el("h1", "hmi-header-title");
    title.append(
        logoImg(logos.petronash, "Petronash", "hmi-title-logo hmi-title-logo-left"),
        logoImg(logos.remoteCommand, "SIA Remote Command", "hmi-header-logo"),
        document.createTextNode("SIA Remote Command"),
        logoImg(logos.aramco, "Aramco", "hmi-title-logo hmi-title-logo-right"),
    );
    const header = el("header", "hmi-header");
    header.append(title);
    return header;
}

/**
 * Create the HMI inside rootEl.
 *
 * @param {HTMLElement} rootEl - container the HMI is built into (emptied first)
 * @param {object} [opts]
 * @param {"overlay"|"inline"} [opts.alertLayout="overlay"] - how the alert
 *   window is presented. "overlay" (local panel): floats over the tiles on the
 *   z-axis, dimming them. "inline" (cloud widget): a banner stacked ABOVE the
 *   tiles on the y-axis, pushing them down rather than covering them, so it
 *   never obscures content in the host UI's variable-height column.
 * @param {{petronash: string, remoteCommand: string, aramco: string}} [opts.logos]
 *   Brand logos (img srcs — the cloud widget passes inlined data URIs). When
 *   given, a frosted header bar is built as the FIRST child of rootEl, above
 *   the alert banner and grid. Omit for no header.
 * @returns {{update: (data: object|null|undefined) => void, destroy: () => void}}
 */
export function createHmi(rootEl, opts = {}) {
    rootEl.innerHTML = "";
    rootEl.classList.add("hmi-root");

    // One Time-to-Empty filter per HMI instance: it carries the EMA state
    // across renders, so it belongs to the instance, not to renderTank().
    const tteEstimator = createTimeToEmptyEstimator();

    const inlineAlert = opts.alertLayout === "inline";
    if (inlineAlert) {
        rootEl.classList.add("hmi-alert-inline");
    }

    // ---- Pumps tile: pump states, selected pipeline, then the volume
    // totals (this segment's, then the grand total across all pipelines) -----
    const pumpStates = [1, 2].map((n) => {
        const display = el("div", "state-display");
        const value = el("span", "state-value unknown", PLACEHOLDER);
        display.append(value);
        return { value, card: card(`Pump ${n} State`, display) };
    });

    // Per-segment running total; its title names the selected pipeline
    // ("<name> Volume Pumped"), so no separate pipeline-name tile is needed.
    const segmentVolume = valueDisplay("");
    const segmentVolumeTitle = el("h3", "", "Pipeline Volume Pumped");
    const segmentVolumeCard = el("div", "control-card");
    segmentVolumeCard.append(segmentVolumeTitle, segmentVolume.root);

    const pumpGrid = el("div", "controls-grid controls-grid-vertical");
    pumpGrid.append(pumpStates[0].card, pumpStates[1].card, segmentVolumeCard);
    const pumpSection = section("pump-section", "Pumps", pumpGrid);

    // ---- Skid column: shared pressure, flow, total volume ---------------
    const pressure = valueDisplay("");
    const pressureHigh = alarmLevel("High Alarm:", "");
    const pressureLow = alarmLevel("Low Alarm:", "");
    const pressureCard = card(
        "Pressure",
        pressure.root,
        pressureHigh.root,
        pressureLow.root,
    );

    const flow = valueDisplay("");
    const flowHigh = alarmLevel("High Alarm:", "");
    const flowLow = alarmLevel("Low Alarm:", "");
    const flowCard = card("Flow", flow.root, flowHigh.root, flowLow.root);

    // Grand total across all pipelines (volume.total).
    const volume = valueDisplay("");
    const volumeCard = card("Total Volume Pumped", volume.root);

    const skidGrid = el("div", "controls-grid controls-grid-vertical");
    skidGrid.append(pressureCard, flowCard, volumeCard);
    const skidSection = section("skid-section", "Skid", skidGrid);

    // ---- Tank tile ------------------------------------------------------
    const gauge = el("div", "tank-gauge");
    const gaugeFill = el("div", "tank-gauge-fill");
    gauge.append(gaugeFill);

    const tankPercent = valueDisplay("%");
    // Depth and volume units are set at render time from the sensor's config.
    const tankLevel = valueDisplay("m");
    const tankVolume = valueDisplay("");

    const tankTimeToEmpty = el("div", "tank-tte");
    const tteValue = el("span", "tank-tte-value", PLACEHOLDER);
    tankTimeToEmpty.append(el("span", "tank-tte-label", "Time to Empty"), tteValue);

    // Alarm setpoint(s), rendered like the Pressure/Flow tiles. The level
    // sensor's alarm_source decides the units (%, a volume, or a length), so
    // the assembler hands them over display-ready.
    const tankHigh = alarmLevel("High Alarm:", "");
    const tankLow = alarmLevel("Low Alarm:", "");
    // The pump controller's tank-empty alert threshold, stated the same way as
    // the level sensor's own alarm point so the tile shows BOTH of the tank's
    // alarms — the level one and the remaining-time one.
    const tankTimeAlarm = alarmLevel("Time Alarm:", "h");

    const readouts = el("div", "tank-gauge-readouts");
    // Depth on top, the percentage in the middle, volume below.
    readouts.append(
        tankLevel.root,
        tankPercent.root,
        tankVolume.root,
        tankTimeToEmpty,
        tankHigh.root,
        tankLow.root,
        tankTimeAlarm.root,
    );

    const gaugeWrap = el("div", "tank-gauge-wrap");
    gaugeWrap.append(gauge, readouts);
    const tankSection = section("tank-section", "Tank Level", gaugeWrap);

    // ---- Grid -----------------------------------------------------------
    const grid = el("div", "hmi-grid");
    grid.append(pumpSection, skidSection, tankSection);

    // ---- Alert popover (driven by alerts.unexpected_flow / low_flow) -----
    const alertDim = el("div", "hmi-alert-dim");
    const alertPopover = el("div", "hmi-alert-popover hidden");
    const alertContent = el("div", "hmi-alert-content");
    const alertList = el("ul", "hmi-alert-list");
    alertContent.append(
        el("h2", "", "Alert"),
        alertList,
        el("p", "hmi-alert-instructions", "Investigate and correct the condition to clear the alert."),
    );
    alertPopover.append(alertContent);

    // Inline: banner above the tiles (no dim backdrop). Overlay: dim + popover
    // layered over the grid. See opts.alertLayout in the createHmi docstring.
    if (inlineAlert) {
        rootEl.append(alertPopover, grid);
    } else {
        rootEl.append(grid, alertDim, alertPopover);
    }

    // ---- Branded header (opts.logos) ------------------------------------
    // Prepended so it sits above the alert banner and the tiles, regardless of
    // the alert layout. No logos → no header, leaving other embedders untouched.
    if (opts.logos) {
        rootEl.prepend(buildHeader(opts.logos));
    }

    // ---- Render ----------------------------------------------------------

    function renderPumpState(target, pump) {
        const on = pump && typeof pump.on === "boolean" ? pump.on : null;
        if (on === true) {
            // Wording matches the pump controller widget's own indicator
            // ("Pumping"/"Stopped"; both stylesheets uppercase it).
            target.textContent = "PUMPING";
            target.className = "state-value on";
        } else if (on === false) {
            target.textContent = "STOPPED";
            target.className = "state-value off";
        } else {
            target.textContent = PLACEHOLDER;
            target.className = "state-value unknown";
        }
    }

    function renderTank(tank, flowData) {
        const percent = tank && typeof tank.percent === "number" && Number.isFinite(tank.percent)
            ? tank.percent
            : null;
        if (percent === null) {
            tankPercent.value.textContent = PLACEHOLDER;
            gaugeFill.style.height = "0%";
            gaugeFill.className = "tank-gauge-fill";
        } else {
            const pct = Math.max(0, Math.min(100, percent));
            tankPercent.value.textContent = Math.round(pct).toString();
            gaugeFill.style.height = `${pct}%`;
            gaugeFill.className = "tank-gauge-fill";
            if (pct < 5) {
                gaugeFill.classList.add("low");
            } else if (pct < 25) {
                gaugeFill.classList.add("medium");
            }
        }

        const depth = fmtDepth(
            tank ? tank.level_mm : null,
            tank ? tank.depth_units : "m",
        );
        tankLevel.value.textContent = depth.value;
        tankLevel.unit.textContent = depth.unit;

        const volume =
            tank && typeof tank.volume === "number" && Number.isFinite(tank.volume)
                ? tank.volume
                : null;
        const volumePrecision =
            tank && typeof tank.volume_precision === "number"
                ? tank.volume_precision
                : 0;
        tankVolume.value.textContent =
            volume === null ? PLACEHOLDER : volume.toFixed(volumePrecision);
        tankVolume.unit.textContent = (tank && tank.volume_units) || "";

        tteValue.textContent = tteEstimator.update(tank || {}, flowData || {}, Date.now());

        const alarmUnits = (tank && tank.alarm_units) || "";
        renderAlarmRow(
            tankHigh,
            tank && tank.high_alarm_active,
            tank ? tank.high_alarm : null,
            alarmUnits,
        );
        renderAlarmRow(
            tankLow,
            tank && tank.low_alarm_active,
            tank ? tank.low_alarm : null,
            alarmUnits,
        );
        // The remaining-time alarm is always armed by the pump controller, so
        // it shows whenever we can read its threshold; a threshold we cannot
        // read is hidden rather than shown as a dangling em-dash.
        const timeAlarmHours =
            tank && typeof tank.time_alarm_hours === "number" ? tank.time_alarm_hours : null;
        renderAlarmRow(tankTimeAlarm, timeAlarmHours !== null, timeAlarmHours, "h");
    }

    function renderAlerts(alerts) {
        const messages = [];
        if (alerts && alerts.unexpected_flow === true) {
            messages.push("Unexpected Flow — flow or pressure detected while both pumps are off");
        }
        if (alerts && alerts.low_flow === true) {
            messages.push("Low Flow — low flow or pressure while a pump is running");
        }
        if (alerts && alerts.low_tank_time === true) {
            messages.push("Low Tank — storage tank predicted to empty soon at the current flow");
        }

        alertList.innerHTML = "";
        if (messages.length > 0) {
            for (const message of messages) {
                alertList.append(el("li", "", message));
            }
            alertPopover.classList.remove("hidden");
            alertDim.classList.add("active");
        } else {
            alertPopover.classList.add("hidden");
            alertDim.classList.remove("active");
        }
    }

    function update(data) {
        if (!data || typeof data !== "object") {
            return;
        }

        renderPumpState(pumpStates[0].value, data.pumps ? data.pumps.pump_1 : null);
        renderPumpState(pumpStates[1].value, data.pumps ? data.pumps.pump_2 : null);

        // Selected pipeline name titles the per-segment volume tile
        // ("<name> Volume Pumped").
        const segmentName =
            data.segment && typeof data.segment.name === "string" && data.segment.name
                ? data.segment.name
                : null;
        segmentVolumeTitle.textContent = segmentName
            ? `${segmentName} Volume Pumped`
            : "Pipeline Volume Pumped";

        const pressureData = data.pressure || {};
        pressure.value.textContent = fmtNumber(pressureData.value);
        pressure.unit.textContent = pressureData.units || "";
        renderAlarmRow(
            pressureHigh,
            pressureData.high_alarm_active,
            pressureData.high_alarm,
            pressureData.units,
        );
        renderAlarmRow(
            pressureLow,
            pressureData.low_alarm_active,
            pressureData.low_alarm,
            pressureData.units,
        );

        const flowData = data.flow || {};
        flow.value.textContent = fmtNumber(flowData.value);
        flow.unit.textContent = flowData.units || "";
        renderAlarmRow(
            flowHigh,
            flowData.high_alarm_active,
            flowData.high_alarm,
            flowData.units,
        );
        renderAlarmRow(
            flowLow,
            flowData.low_alarm_active,
            flowData.low_alarm,
            flowData.units,
        );

        const volumeData = data.volume || {};
        segmentVolume.value.textContent = fmtNumber(volumeData.segment_total);
        segmentVolume.unit.textContent = volumeData.units || "";
        volume.value.textContent = fmtNumber(volumeData.total);
        volume.unit.textContent = volumeData.units || "";

        renderTank(data.tank || {}, flowData);

        renderAlerts(data.alerts);
    }

    function destroy() {
        // Drop the Time-to-Empty filter state too: a torn-down HMI that is
        // rebuilt later must seed from live readings, not resume an average
        // from before whatever gap the teardown covered.
        tteEstimator.reset();
        rootEl.innerHTML = "";
        rootEl.classList.remove("hmi-root");
    }

    return { update, destroy };
}
