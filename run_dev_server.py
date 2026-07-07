#!/usr/bin/env python3
"""Dev server for testing the alarm popover.

Runs the SIA dashboard standalone in dev mode (dev_mode=True), which renders an
on-screen dev toolbar. Use the toolbar buttons to force a reading past its alarm
setpoint and watch the alarm popover come across the HMI. Not part of the app.
"""
import time

from src.sia_local_control_ui.dashboard import SiaDashboard, DashboardInterface

# dev_mode=True renders the manual alarm-trigger toolbar at the bottom of the screen
dashboard = SiaDashboard(host="127.0.0.1", port=8091, debug=False, dev_mode=True)
iface = DashboardInterface(dashboard)
iface.start_dashboard()
time.sleep(1.5)  # let the server bind

# Nominal readings — everything within limits so no alarm shows until you trigger one
dashboard.update_data(
    selector={"state": 3},
    pump={"target_rate": 25.0, "flow_rate": 24.1, "pump_state": "pumping"},
    pump2={"enabled": True, "target_rate": 30.0, "flow_rate": 29.3, "pump_state": "pumping"},
    tank={"tank_level_mm": 1450.0, "tank_level_percent": 62.0},
    skid={"skid_flow": 26.4, "skid_pressure": 3.2, "total_flow": 58213.0},
    faults={"hh_pressure": False, "ll_tank_level": False},
)

print("Dev dashboard live at http://127.0.0.1:8091 (dev toolbar enabled)")
while True:
    time.sleep(1)
