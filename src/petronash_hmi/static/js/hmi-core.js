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
 *   "tank":     { "percent": 48.8|null, "level_mm": 19030.0|null },
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

    // ---- Pump state tiles ---------------------------------------------
    const pumpStates = [1, 2].map((n) => {
        const display = el("div", "state-display");
        const value = el("span", "state-value unknown", PLACEHOLDER);
        display.append(value);
        const grid = el("div", "controls-grid controls-grid-vertical");
        grid.append(card("Pump State", display));
        return { value, section: section("pump-section", `Pump ${n}`, grid) };
    });

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

    const readouts = el("div", "tank-gauge-readouts");
    readouts.append(tankPercent.root, tankLevel.root);

    const gaugeWrap = el("div", "tank-gauge-wrap");
    gaugeWrap.append(gauge, readouts);
    const tankSection = section("tank-section", "Tank Level", gaugeWrap);

    // ---- Grid -----------------------------------------------------------
    const grid = el("div", "hmi-grid");
    grid.append(pumpStates[0].section, pumpStates[1].section, skidSection, tankSection);

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

    function renderTank(tank, lengthUnit) {
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
        renderTank(data.tank || {}, lengthUnit);

        renderAlerts(data.alerts);
    }

    function destroy() {
        rootEl.innerHTML = "";
        rootEl.classList.remove("hmi-root");
    }

    return { update, destroy };
}
