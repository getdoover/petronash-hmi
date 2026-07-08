#!/usr/bin/env python3
"""Local runner for the SIA dashboard.

Launches the dashboard standalone with representative data so the UI can be
viewed/screenshotted and the alarm popover tested, without the full pydoover app.

Dev mode (the on-screen alarm-testing toolbar) is controlled by the SIA_DEV_MODE
environment variable — the SAME flag the real app uses. This runner defaults it
ON; set `SIA_DEV_MODE=0` to run without the toolbar. Examples:

    uv run python run_local.py            # dev toolbar on
    SIA_DEV_MODE=0 uv run python run_local.py   # production-like, no toolbar
"""
import os
import time

# Default the local runner to dev mode; SIA_DEV_MODE=0 (or the real app's default) overrides.
os.environ.setdefault("SIA_DEV_MODE", "1")

from src.sia_local_control_ui.dashboard import SiaDashboard, DashboardInterface

# dev_mode is resolved from SIA_DEV_MODE inside SiaDashboard
dashboard = SiaDashboard(host="127.0.0.1", port=8091, debug=False)
iface = DashboardInterface(dashboard)
iface.start_dashboard()
time.sleep(1.5)  # let the server bind

# Nominal readings — everything within limits so no alarm shows until you trigger one
dashboard.update_data(
    selector={"state": 3},
    pump={"target_rate": 25.0, "flow_rate": 24.1, "pump_state": "pumping"},
    pump2={"enabled": True, "target_rate": 30.0, "flow_rate": 29.3, "pump_state": "standby"},
    tank={"tank_level_mm": 1450.0, "tank_level_percent": 62.0},
    skid={"skid_flow": 26.4, "skid_pressure": 3.2, "total_flow": 58213.0},
    faults={"hh_pressure": False, "ll_tank_level": False},
)

mode = "dev (toolbar on)" if dashboard.dev_mode else "production-like (no toolbar)"
print(f"Dashboard live at http://127.0.0.1:8091 — {mode}")
while True:
    time.sleep(1)
