# Petronash HMI

A read-only HMI for Petronash SIA pump skids (Aramco), delivered as a **Module Federation
widget** (`widget/`). The same widget renders in two hosts: the Doover cloud interpreter, and
the device-agent's **local widget host** on the Doovit (`https://<doovit>:<web_port>/widget/
petronash_hmi_1_widget`) — which replaced the old Flask panel on port 8091.

The app itself is a **widget-only cloud processor (PRO)**: it carries the config schema and the
widget attachment and does no runtime work (its Lambda is never invoked), so there is no device
container. Everything is done client-side by the widget.

The HMI is **strictly read-only**: it displays state but controls nothing. All pump control
lives in the Petronash Pump Controller app's widget.

## What it does

The widget reads the device's channels directly (via the host's `doover-js` client) and
assembles its own view — there is no server-side assembler:

- **Reads** pump states, the volume totaliser and alert flags from the pump controller app's
  tags; flow and pressure from the 4-20mA sensor apps; and tank level from the analog level
  sensor app (all from the `tag_values` aggregate).
- **Reads alarm setpoints** from the `ui_cmds` aggregate, and each sensor's units + alarm type
  + the tank-empty threshold from `deployment_config`.
- **Renders** the DashboardData v2 view entirely in `hmi-core.js`, shared by both hosts.

The Python side (`src/petronash_hmi/`) is now just the PRO app record — a no-op processor plus
the config schema (`app_config.py`) and the widget's `uiRemoteComponent` (`app_ui.py`). The
data-assembly + render logic lives in `widget/` and `static/js/hmi-core.js`.

## DashboardData v2

`hmi-core.js` renders exclusively from the DashboardData v2 dict, which each host's data adapter
assembles from the raw channels (`widget/src/lib/assembleDashboardData.ts`):

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
basis, and the `Xd Yh Zm` formatting) lives solely in `hmi-core.js` so both hosts can never
diverge. It renders "—" whenever flow is null or ≤ 0, the tank percentage is null, capacity is
missing, or the result is non-finite.

## Structure

```
src/petronash_hmi/
  __init__.py        # Lambda handler (no-op processor entry point)
  application.py     # PetronashHmiApp — a no-op pydoover.processor.Application
  app_config.py      # Config schema (which peer apps to read) + PRO plumbing
  app_tags.py        # Empty — the HMI publishes no domain tags
  app_ui.py          # The cloud UI: a single uiRemoteComponent (the widget)
  static/js/         # hmi-core.js — the shared, framework-free render core
  static/css/        #   + hmi-core.css (both imported by the widget)

widget/              # The Module Federation widget (React shell + data adapter)
tests/               # pytest (app-record shape) + tests/js (render-core node tests)
```

## Development

```bash
uv run pytest tests -q              # Python: app-record shape tests
uv run export-config                # Write config_schema into doover_config.json
uv run export-ui                    # Write ui_schema into doover_config.json
sh build.sh                         # Build the processor package.zip (PRO deploy artifact)

nvm use 22                          # the widget toolchain needs node >= 20
npm --prefix widget install
npm --prefix widget run build       # Build the single MF widget asset
npm --prefix widget test            # Widget: data-adapter + render-core node tests
node --test tests/js/               # Render-core (formatTimeToEmpty) tests
```

`doover_config.json`'s `config_schema` / `ui_schema` are generated from `app_config.py` /
`app_ui.py` — never hand-edit them; change the Python and re-export. CI validates that the
committed schemas match the source. `doover app publish` builds + uploads the widget and the
`package.zip`; the app is a widget-only PRO, so there is no container image.

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
