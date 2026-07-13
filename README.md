# Petronash HMI

A Doover device application that serves a local touchscreen HMI for Petronash SIA pump skids
(Aramco). It runs on the Doovit, reads state from the other apps deployed alongside it, and
serves a real-time web dashboard on port **8091** for the panel screen mounted on the skid.

The HMI is **strictly read-only**: it displays state but controls nothing. All pump control
lives in the Petronash Pump Controller app's cloud UI. This app publishes no domain tags and
no socket event mutates anything.

## What it does

- **Reads** pump states, the volume totaliser and alert flags from the pump controller app's
  tags; flow and pressure from the 4-20mA sensor apps; and tank level from the analog level
  sensor app.
- **Reads alarm setpoints** (the sensor apps' slider values) from the `ui_cmds` channel
  aggregate on a slow cadence, and sensor display units from `deployment_config`.
- **Serves** a Flask + Socket.IO dashboard (`src/petronash_hmi/dashboard.py`) that pushes
  `data_update` events to the panel over a WebSocket.

## DashboardData v2

The socket.io `data_update` payload (and `/api/data` response) is the DashboardData v2 dict:

```json
{
  "pumps": { "pump_1": {"on": true}, "pump_2": {"on": false} },
  "pressure": { "value": 3.2, "units": "PSI", "high_alarm": 1500.0 },
  "flow": { "value": 26.4, "units": "GPD", "high_alarm": 63.3, "low_alarm": 34.2 },
  "volume": { "total": 58213.0, "units": "gal" },
  "tank": {
    "percent": 48.8,
    "level_mm": 19030.0,
    "capacity": { "value": 100000, "units": "L" }
  },
  "units": { "length": "inch" },
  "alerts": { "unexpected_flow": false, "low_flow": false },
  "system": { "timestamp": "<iso>", "status": "running" }
}
```

`null` means "no data" — the UI renders a placeholder (e.g. "—"), never 0. A setpoint slider
the operator has never moved has no `ui_cmds` entry and resolves to `null`.

`tank.capacity` is a dumb pass-through of the level sensor app's own
`deployment_config` (`max_volume` + `volume_units`); it feeds the Tank Level tile's estimated
time-to-empty readout. All of that math (current volume, gallon↔litre conversion, per-day flow
basis, and the `Xd Yh Zm` formatting) lives solely in `hmi-core.js` so the local dashboard and
the cloud widget can never diverge. It renders "—" whenever flow is null or ≤ 0, the tank
percentage is null, capacity is missing, or the result is non-finite.

## Structure

```
src/petronash_hmi/
  __init__.py        # Entry point — run_app(PetronashHmiApplication())
  application.py     # Main app class (setup, main_loop, channel/tag reads)
  app_config.py      # Config schema — class-level declarations
  app_tags.py        # Empty — the HMI publishes no domain tags
  app_ui.py          # Empty — the cloud UI is a Module Federation widget
  dashboard.py       # Flask + Socket.IO server for the local panel
  templates/         # dashboard.html
  static/            # css, js, logos

simulators/          # Sample configuration and docker-compose for local runs
tests/               # pytest suite
```

## Development

```bash
uv run pytest tests -v     # Run tests
uv run export-config       # Write config_schema into doover_config.json
uv run export-ui           # Write ui_schema into doover_config.json (required to publish)
doover app run             # Run app + simulator locally via docker-compose
```

`doover_config.json` is generated from `app_config.py` and `app_ui.py`. Never hand-edit the
`config_schema` or `ui_schema` blocks — change the Python and re-export. CI validates that the
committed schemas match the source.

### Viewing the dashboard without a Doovit

`run_local.py` boots just the Flask HMI with representative DashboardData v2 seed data, so the
panel UI can be viewed and the alarm popover exercised without the pydoover app or any device:

```bash
uv run python run_local.py                    # dev toolbar on, http://127.0.0.1:8091
PETRONASH_DEV_MODE=0 uv run python run_local.py  # production-like, no toolbar
PETRONASH_DASHBOARD_PORT=8092 uv run python run_local.py  # alternate port
```

The dev toolbar (for manually triggering alarms) is controlled by the `PETRONASH_DEV_MODE`
environment variable, the same flag the real app reads, so the container can be launched in test
mode without a code change.

## Configuration

Every field has a default matching the standard solution deployment, so a fresh install works
without configuration.

| Field | Default | Description |
| --- | --- | --- |
| `flow_sensor_app` | `4_20ma_sensor_1` | 4-20mA sensor application measuring flow rate. |
| `pressure_sensor_app` | `4_20ma_sensor_2` | 4-20mA sensor application measuring pressure. |
| `tank_level_app` | `analog_level_sensor_1` | Analog level sensor application. |
| `pump_controller_app` | `petronash_pump_controller_1` | Petronash pump controller application. |
| `display_units` | `Inch (")` | Length units on screen — inches or millimetres. |
