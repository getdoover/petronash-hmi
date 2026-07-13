#!/usr/bin/env python3
"""Local runner for the Petronash HMI dashboard.

Launches the dashboard standalone with representative data so the UI can be
viewed/screenshotted and the alarm popover tested, without the full pydoover app.

Dev mode (the on-screen alarm-testing toolbar) is controlled by the PETRONASH_DEV_MODE
environment variable — the SAME flag the real app uses. This runner defaults it
ON; set `PETRONASH_DEV_MODE=0` to run without the toolbar. Examples:

    uv run python run_local.py            # dev toolbar on
    PETRONASH_DEV_MODE=0 uv run python run_local.py   # production-like, no toolbar
"""

import os
import time

# Default the local runner to dev mode; PETRONASH_DEV_MODE=0 (or the real app's default) overrides.
os.environ.setdefault("PETRONASH_DEV_MODE", "1")

from src.petronash_hmi.dashboard import DashboardInterface, PetronashDashboard

# PETRONASH_DASHBOARD_PORT lets a second local instance run alongside a demo on 8091.
port = int(os.environ.get("PETRONASH_DASHBOARD_PORT", "8091"))

# dev_mode is resolved from PETRONASH_DEV_MODE inside PetronashDashboard
dashboard = PetronashDashboard(host="127.0.0.1", port=port, debug=False)
iface = DashboardInterface(dashboard)
iface.start_dashboard()
time.sleep(1.5)  # let the server bind

# Nominal DashboardData v2 readings — everything within limits so no alarm shows
# until you trigger one. Mirrors the test rig: pressure setpoint never touched
# (None), flow uses an Allowed Range pair.
dashboard.update_data(
    pumps={"pump_1": {"on": True}, "pump_2": {"on": False}},
    pressure={"value": 3.2, "units": "PSI", "high_alarm": None},
    flow={"value": 42.7, "units": "GPD", "high_alarm": 63.3, "low_alarm": 34.2},
    volume={"total": 58213.0, "units": "gal"},
    tank={"percent": 62.0, "level_mm": 1450.0},
    units={"length": "inch"},
    alerts={"unexpected_flow": False, "low_flow": False},
)

mode = "dev (toolbar on)" if dashboard.dev_mode else "production-like (no toolbar)"
print(f"Dashboard live at http://127.0.0.1:{port} — {mode}")
while True:
    time.sleep(1)
