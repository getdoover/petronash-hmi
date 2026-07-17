/**
 * Petronash HMI — local shell.
 *
 * Thin socket.io bootstrap around the shared render core (hmi-core.js):
 *   - connects to the Flask/Socket.IO server and feeds every `data_update`
 *     event (DashboardData v2 dict) into createHmi().update();
 *   - maintains the header connection indicator + last-update timestamp;
 *   - in dev mode, wires the dev toolbar to inject v2 fixture data and
 *     toggle the two alert flags (alerts.unexpected_flow / alerts.low_flow)
 *     so the alert popover and em-dash placeholders can be exercised
 *     without live hardware.
 *
 * All rendering lives in hmi-core.js — this file owns transport + chrome only.
 * The page is read-only: nothing here emits any mutating socket event.
 */

import { createHmi } from "./hmi-core.js";

// Nominal v2 fixture — mirrors the live test rig (flow GPD, pressure PSI).
function nominalFixture() {
    return {
        pumps: { pump_1: { on: true }, pump_2: { on: false } },
        pressure: {
            value: 3.2, units: "PSI", high_alarm: 1500.0, low_alarm: null,
            high_alarm_active: true, low_alarm_active: false,
        },
        flow: {
            value: 48.6, units: "GPD", high_alarm: 63.3, low_alarm: 34.2,
            high_alarm_active: true, low_alarm_active: true,
        },
        volume: { total: 58213.0, segment_total: 12840.0, units: "gal" },
        segment: { name: "Pipeline A" },
        tank: {
            percent: 48.8,
            level_mm: 19030.0,
            capacity: { value: 100000, units: "L" },
            high_alarm: 56.2,
            low_alarm: null,
            alarm_units: "%",
            high_alarm_active: true,
            low_alarm_active: false,
            time_alarm_hours: 24,
        },
        units: { length: "inch" },
        alerts: { unexpected_flow: false, low_flow: false, low_tank_time: false },
        system: { timestamp: new Date().toISOString(), status: "running" },
    };
}

// All-null v2 fixture — every reading missing; the UI must show em-dashes.
function nullFixture() {
    return {
        pumps: { pump_1: { on: null }, pump_2: { on: null } },
        pressure: {
            value: null, units: "PSI", high_alarm: null, low_alarm: null,
            high_alarm_active: false, low_alarm_active: false,
        },
        flow: {
            value: null, units: "GPD", high_alarm: null, low_alarm: null,
            high_alarm_active: false, low_alarm_active: false,
        },
        volume: { total: null, segment_total: null, units: "gal" },
        segment: { name: null },
        tank: {
            percent: null,
            level_mm: null,
            capacity: { value: null, units: null },
            high_alarm: null,
            low_alarm: null,
            alarm_units: null,
            high_alarm_active: false,
            low_alarm_active: false,
            time_alarm_hours: null,
        },
        units: { length: "inch" },
        alerts: { unexpected_flow: false, low_flow: false, low_tank_time: false },
        system: { timestamp: new Date().toISOString(), status: "running" },
    };
}

class DashboardShell {
    constructor() {
        this.hmi = createHmi(document.getElementById("hmi-root"));
        this.connectionStatus = document.getElementById("connection-status");
        this.lastUpdate = document.getElementById("last-update");
        this.loadingOverlay = document.getElementById("loading-overlay");

        this.isConnected = false;
        this.serverData = null; // last payload received from the server
        this.devData = null; // dev-toolbar override; null = render server data

        this.initializeSocket();
        this.setupDevToolbar();
    }

    initializeSocket() {
        // socket.io client auto-reconnects; we just reflect state in the header.
        this.socket = io();

        this.socket.on("connect", () => {
            this.isConnected = true;
            this.updateConnectionStatus(true);
            this.hideLoadingOverlay();
            this.socket.emit("request_data");
        });

        this.socket.on("disconnect", () => {
            this.isConnected = false;
            this.updateConnectionStatus(false);
        });

        this.socket.on("connect_error", (error) => {
            console.error("Connection error:", error);
            this.updateConnectionStatus(false);
        });

        this.socket.on("data_update", (data) => {
            this.serverData = data;
            if (this.devData === null) {
                this.render(data);
            }
            this.updateLastUpdateTime(data && data.system ? data.system.timestamp : null);
        });

        this.socket.on("heartbeat", (data) => {
            this.updateLastUpdateTime(data ? data.timestamp : null);
        });
    }

    render(data) {
        this.hmi.update(data);
    }

    // ---- Dev toolbar -----------------------------------------------------
    //
    // Buttons (only rendered server-side when PETRONASH_DEV_MODE is on):
    //   fixture           — inject the nominal v2 fixture
    //   nulls             — inject the all-null fixture (placeholder check)
    //   toggle-unexpected — toggle alerts.unexpected_flow on the shown data
    //   toggle-low        — toggle alerts.low_flow on the shown data
    //   toggle-tank       — toggle alerts.low_tank_time on the shown data
    //   clear             — drop the override, back to live server data

    setupDevToolbar() {
        const buttons = document.querySelectorAll(".dev-btn[data-dev]");
        buttons.forEach((button) => {
            button.addEventListener("click", (e) => {
                this.devAction(e.currentTarget.getAttribute("data-dev"));
            });
        });
    }

    devAction(kind) {
        switch (kind) {
            case "fixture":
                this.devData = nominalFixture();
                break;
            case "nulls":
                this.devData = nullFixture();
                break;
            case "toggle-unexpected":
            case "toggle-low":
            case "toggle-tank": {
                // Toggle one alert flag on top of whatever is currently displayed
                const flagByKind = {
                    "toggle-unexpected": "unexpected_flow",
                    "toggle-low": "low_flow",
                    "toggle-tank": "low_tank_time",
                };
                const flag = flagByKind[kind];
                const base = this.devData || this.serverData || nominalFixture();
                const alerts = {
                    unexpected_flow: false,
                    low_flow: false,
                    low_tank_time: false,
                    ...(base.alerts || {}),
                };
                alerts[flag] = !alerts[flag];
                this.devData = { ...base, alerts };
                break;
            }
            case "clear":
                this.devData = null;
                if (this.serverData) {
                    this.render(this.serverData);
                }
                if (this.isConnected) {
                    this.socket.emit("request_data");
                }
                return;
            default:
                return;
        }
        this.render(this.devData);
    }

    // ---- Chrome ------------------------------------------------------------

    updateConnectionStatus(connected) {
        if (!this.connectionStatus) {
            return;
        }
        if (connected) {
            this.connectionStatus.innerHTML = '<i class="fas fa-circle"></i> Connected';
            this.connectionStatus.className = "status-connected";
        } else {
            this.connectionStatus.innerHTML = '<i class="fas fa-circle"></i> Disconnected';
            this.connectionStatus.className = "status-disconnected";
        }
    }

    updateLastUpdateTime(timestamp) {
        if (!this.lastUpdate) {
            return;
        }
        const time = timestamp ? new Date(timestamp) : new Date();
        if (isNaN(time.getTime())) {
            console.warn("Invalid timestamp received:", timestamp);
            return;
        }
        this.lastUpdate.textContent = time.toLocaleTimeString("en-US", {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hour12: false,
        });
    }

    hideLoadingOverlay() {
        if (!this.loadingOverlay) {
            return;
        }
        setTimeout(() => {
            this.loadingOverlay.classList.add("hidden");
        }, 500);
    }

    requestData() {
        if (this.isConnected) {
            this.socket.emit("request_data");
        }
    }
}

window.dashboard = new DashboardShell();

// Refresh when the page becomes visible again
document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
        window.dashboard.requestData();
    }
});

window.addEventListener("beforeunload", () => {
    if (window.dashboard && window.dashboard.socket) {
        window.dashboard.socket.disconnect();
    }
});
