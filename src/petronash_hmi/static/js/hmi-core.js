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
 *                 "capacity": { "value": 100000|null, "units": "L"|"gal"|null },
 *                 "high_alarm": 56.2|null, "low_alarm": null,
 *                 "alarm_units": "%"|"L"|"mm"|"\""|null,
 *                 "high_alarm_active": true, "low_alarm_active": false,
 *                 "time_alarm_hours": 24|null },
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

/** Format a millimetre length in the active display unit ("inch" | "mm"). */
function fmtLength(mm, lengthUnit) {
    if (typeof mm !== "number" || !Number.isFinite(mm)) {
        return { value: PLACEHOLDER, unit: lengthUnit === "mm" ? "mm" : '"' };
    }
    if (lengthUnit === "mm") {
        return { value: Math.round(mm).toString(), unit: "mm" };
    }
    return { value: (mm / 25.4).toFixed(1), unit: '"' };
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
    const tankLevel = valueDisplay('"');

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
    readouts.append(
        tankPercent.root,
        tankLevel.root,
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

    function renderTank(tank, lengthUnit, flowData) {
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

        const level = fmtLength(tank ? tank.level_mm : null, lengthUnit);
        tankLevel.value.textContent = level.value;
        tankLevel.unit.textContent = level.unit;

        tteValue.textContent = formatTimeToEmpty(tank || {}, flowData || {});

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

        const lengthUnit = data.units && data.units.length === "mm" ? "mm" : "inch";
        renderTank(data.tank || {}, lengthUnit, flowData);

        renderAlerts(data.alerts);
    }

    function destroy() {
        rootEl.innerHTML = "";
        rootEl.classList.remove("hmi-root");
    }

    return { update, destroy };
}
