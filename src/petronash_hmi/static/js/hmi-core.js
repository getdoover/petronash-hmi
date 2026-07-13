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
 *   "pressure": { "value": 3.2|null, "units": "PSI", "high_alarm": 1500.0|null },
 *   "flow":     { "value": 26.4|null, "units": "GPD",
 *                 "high_alarm": 63.3|null, "low_alarm": 34.2|null },
 *   "volume":   { "total": 58213.0|null, "units": "gal" },
 *   "tank":     { "percent": 48.8|null, "level_mm": 19030.0|null,
 *                 "capacity": { "value": 100000|null, "units": "L"|"gal"|null } },
 *   "units":    { "length": "inch"|"mm" },
 *   "alerts":   { "unexpected_flow": false, "low_flow": false },
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

/**
 * Create the HMI inside rootEl.
 *
 * @param {HTMLElement} rootEl - container the HMI is built into (emptied first)
 * @param {object} [opts] - reserved for future shell-specific options
 * @returns {{update: (data: object|null|undefined) => void, destroy: () => void}}
 */
export function createHmi(rootEl, _opts = {}) {
    rootEl.innerHTML = "";
    rootEl.classList.add("hmi-root");

    // ---- Pumps tile: both pump states stacked in one card ---------------
    const pumpStates = [1, 2].map((n) => {
        const display = el("div", "state-display");
        const value = el("span", "state-value unknown", PLACEHOLDER);
        display.append(value);
        return { value, card: card(`Pump ${n} State`, display) };
    });
    const pumpGrid = el("div", "controls-grid controls-grid-vertical");
    pumpGrid.append(pumpStates[0].card, pumpStates[1].card);
    const pumpSection = section("pump-section", "Pumps", pumpGrid);

    // ---- Skid column: shared pressure, flow, total volume --------------
    const pressure = valueDisplay("");
    const pressureHigh = alarmLevel("High Alarm:", "");
    const pressureCard = card("Pressure", pressure.root, pressureHigh.root);

    const flow = valueDisplay("");
    const flowHigh = alarmLevel("High Alarm:", "");
    const flowLow = alarmLevel("Low Alarm:", "");
    const flowCard = card("Flow", flow.root, flowHigh.root, flowLow.root);

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

    const readouts = el("div", "tank-gauge-readouts");
    readouts.append(tankPercent.root, tankLevel.root, tankTimeToEmpty);

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

    rootEl.append(grid, alertDim, alertPopover);

    // ---- Render ----------------------------------------------------------

    function renderPumpState(target, pump) {
        const on = pump && typeof pump.on === "boolean" ? pump.on : null;
        if (on === true) {
            target.textContent = "RUNNING";
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
    }

    function renderAlerts(alerts) {
        const messages = [];
        if (alerts && alerts.unexpected_flow === true) {
            messages.push("Unexpected Flow — flow or pressure detected while both pumps are off");
        }
        if (alerts && alerts.low_flow === true) {
            messages.push("Low Flow — low flow or pressure while a pump is running");
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

        const pressureData = data.pressure || {};
        pressure.value.textContent = fmtNumber(pressureData.value);
        pressure.unit.textContent = pressureData.units || "";
        pressureHigh.value.textContent = fmtNumber(pressureData.high_alarm);
        pressureHigh.unit.textContent = pressureData.units || "";

        const flowData = data.flow || {};
        flow.value.textContent = fmtNumber(flowData.value);
        flow.unit.textContent = flowData.units || "";
        flowHigh.value.textContent = fmtNumber(flowData.high_alarm);
        flowHigh.unit.textContent = flowData.units || "";
        flowLow.value.textContent = fmtNumber(flowData.low_alarm);
        flowLow.unit.textContent = flowData.units || "";

        const volumeData = data.volume || {};
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
