# Petronash HMI — cloud widget

A Doover cloud remote component that renders the SAME HMI as the device-local
dashboard, at the top of the pump-skid device's page in the regular Doover UI.

## How it works

- `src/PetronashHmiWidget.tsx` — a thin React shell (required at the Module
  Federation boundary: the host `React.lazy`-renders the exposed module's
  default export, wrapped in `customer_site/RemoteComponentWrapper`).
- It reads the device agent's `tag_values`, `ui_cmds` and `deployment_config`
  channel aggregates via `doover-js/react` hooks (shared singletons with the
  host, so data arrives over the host's existing gateway WebSocket).
- `src/lib/assembleDashboardData.ts` folds those aggregates into the binding
  **DashboardData v2** dict — the same payload the device-local Flask server
  emits as the socket.io `data_update` event.
- The dict is fed into `createHmi()` from
  `../src/petronash_hmi/static/js/hmi-core.js` — the framework-free render
  core shared verbatim with the local dashboard (mounted into a ref'd div).
  Its stylesheet (`../src/petronash_hmi/static/css/hmi-core.css`) is scoped
  under `.hmi-root` and inlined into the bundle (`injectStyles`).

Configured peer app keys (`flow_sensor_app`, `pressure_sensor_app`,
`tank_level_app`, `pump_controller_app`) and `display_units` are read from
this install's own block of the `deployment_config` aggregate
(`applications.<app_key>.…`); the install's app key reaches the widget via
the `app_key` kwarg on the ui element (`$config.app().APP_KEY`, resolved
server-side at deploy). Sensor `measurement_units` and `alarm_type` come from
each sensor app's own `deployment_config` block; alarm setpoints come from
`ui_cmds` (absent until an operator first moves the slider = "no setpoint").

## Build

```bash
npm install
npm run build       # -> assets/PetronashHmiWidget.js (single file)
```

The build is rsbuild + rspack Module Federation with
`chunkSplit: all-in-one`, `injectStyles: true` and a ConcatenatePlugin that
merges every emitted chunk (minus `main.js`) into ONE file:
`assets/PetronashHmiWidget.js`. It must stay a single file — the platform
serves it as a single channel attachment.

MF naming contract (must stay in sync with the ui_schema below):

| rsbuild.config.ts | ui_schema element |
|---|---|
| `name: 'PetronashHmiWidget'` | `"scope": "PetronashHmiWidget"` |
| `exposes: { './PetronashHmiWidget': … }` | `"module": "./PetronashHmiWidget"` |

## Deployment wiring (for the integrator — doover_config.json)

The widget ships with the petronash_hmi app itself (a DEV/docker app can
carry a widget — `handle_ui_schema` runs for all app types). Add to the
`petronash_hmi` block of `doover_config.json`:

```json
"build_widget_command": "npm --prefix widget run build",
"widget": "widget/assets/PetronashHmiWidget.js",
```

`doover app publish` then uploads the file to the Application's `widget`
field; on every install deploy the platform attaches it to a
`<install_name>_widget` channel on the agent and injects
`dv_widget_url = "<install_name>_widget"` into the app's deployment_config.

The app's static `ui_schema` must contain a `uiRemoteComponent` child that
references it. Declared in python (`app_ui.py`) as:

```python
ui.RemoteComponent(
    name="petronash_hmi_widget",
    display_name="Petronash HMI",
    component_url="$config.app().dv_widget_url",
    scope="PetronashHmiWidget",
    module="./PetronashHmiWidget",
    app_key="$config.app().APP_KEY",
)
```

which exports (via `uv run export-ui`) to ui_schema JSON of the shape:

```json
"children": {
  "petronash_hmi_widget": {
    "name": "petronash_hmi_widget",
    "type": "uiRemoteComponent",
    "displayString": "Petronash HMI",
    "componentUrl": "$config.app().dv_widget_url",
    "scope": "PetronashHmiWidget",
    "module": "./PetronashHmiWidget",
    "app_key": "$config.app().APP_KEY",
    "children": {}
  }
}
```

To sit at the top of the device page, give the app container a small
position via the hidden `dv_app_position` config element (the app container's
`"position"` resolves from `$config.app().dv_app_position:number:100`;
smaller = closer to the top — e.g. default it to `0`), and set
`defaultOpen: true` on the app container so the widget renders expanded.

## Local iteration

`npm run serve` hosts `assets/` on :8003; point the customer-site
remote-component URL override at it to iterate without republishing
(see dashboard-template DEVELOPMENT.md). Pushing the file to GitHub Pages and
using the full URL as `componentUrl` also works (zamil-dashboard pattern).
