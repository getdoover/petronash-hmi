# Petronash HMI

A Doover device application that serves a local touchscreen HMI for Petronash SIA pump skids
(Aramco). It runs on the Doovit, reads state from the other apps deployed alongside it, drives
the skid's valve output, and serves a real-time web dashboard on port **8091** for the panel
screen mounted on the skid.

This app has no cloud dashboard of its own beyond a small read-only summary — the operator
interface is the local web page, not the Doover web app.

## What it does

- **Reads** pump state, flow and target rate from two pump controller apps; tank level from the
  tank level app; flow and pressure from their sensor apps; and battery/solar figures aggregated
  across any number of solar controller apps.
- **Drives** the valve digital output, gated on a 3-position selector switch read from two analog
  inputs. Start/stop button presses are picked up via digital-input pulse listeners. Pin numbers
  are read out of the pump 1 app's `deployment_config`, not configured separately.
- **Serves** a Flask + Socket.IO dashboard (`src/petronash_hmi/dashboard.py`) that pushes updates
  to the panel over a WebSocket, including an alarm-exceedance popover.
- **Publishes** the state it derives itself (selector position, valve state, the two fault flags)
  as tags, so they are visible from the cloud.

## Structure

```
src/petronash_hmi/
  __init__.py        # Entry point — run_app(PetronashHmiApplication())
  application.py     # Main app class (setup, main_loop, I/O, tag reads)
  app_config.py      # Config schema — class-level declarations
  app_tags.py        # Tags this app derives
  app_ui.py          # Read-only cloud UI bound to those tags
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

`run_local.py` boots just the Flask HMI with representative data, so the panel UI can be viewed
and the alarm popover exercised without the pydoover app or any device:

```bash
uv run python run_local.py                    # dev toolbar on, http://127.0.0.1:8091
PETRONASH_DEV_MODE=0 uv run python run_local.py  # production-like, no toolbar
```

The dev toolbar (for manually triggering alarms) is controlled by the `PETRONASH_DEV_MODE`
environment variable, the same flag the real app reads, so the container can be launched in test
mode without a code change.

## Configuration

| Field | Required | Description |
| --- | --- | --- |
| `pump_1_app` | yes | Pump controller application for pump 1. Also the source of all pin assignments. |
| `pump_2_app` | yes | Pump controller application for pump 2. |
| `solar_controllers` | yes | List of solar controller applications; readings are aggregated. |
| `flow_sensor_app` | yes | Skid flow sensor application. |
| `pressure_sensor_app` | yes | Skid pressure sensor application. |
| `tank_level_app` | yes | Tank level application. |
| `display_units` | no | Length units on screen — inches (default) or millimetres. |
