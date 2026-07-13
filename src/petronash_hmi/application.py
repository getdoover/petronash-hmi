import logging
import time
from typing import Any, Dict, Optional, Tuple

from pydoover.docker import Application

from .app_config import PetronashHmiConfig
from .app_tags import PetronashHmiTags
from .app_ui import PetronashHmiUI
from .dashboard import PetronashDashboard, DashboardInterface

log = logging.getLogger(__name__)

# Alarm setpoints move rarely (operator slider drags), so the ui_cmds aggregate
# is refreshed on a slow cadence instead of every 0.5 s main_loop iteration.
UI_CMDS_REFRESH_PERIOD_S = 5.0

# Flow units whose volume component is US gallons; used to label the totaliser.
_GALLON_FLOW_UNITS = {"GPD", "GPH", "GPM", "GPS"}


def resolve_alarm_setpoint(
    aggregate_data: Optional[Dict[str, Any]],
    app_key: str,
    alarm_type: Optional[str],
) -> Tuple[Optional[float], Optional[float]]:
    """Resolve a sensor app's alarm setpoint(s) from the ui_cmds aggregate data.

    Pure function so it is unit-testable without a device agent.

    ``aggregate_data`` is the ``data`` dict of the ``ui_cmds`` channel
    aggregate, shaped ``{app_key: {element_name: value}}``. Setpoints are the
    persisted slider values: ``alarm_range`` (2-list, order NOT guaranteed)
    when the sensor's deployment_config ``alarm_type`` is "Allowed Range",
    else ``alarm_point`` (bare number) for "Greater Than" / "Less Than".
    A slider the operator has never moved has NO entry at all — that means
    "no setpoint", never an error. Stale sibling keys may linger (e.g. an old
    ``alarm_point`` next to the active ``alarm_range``); only the key selected
    by ``alarm_type`` is authoritative.

    Returns ``(low, high)`` where either side is None when unset/inapplicable.
    """
    cmds = ((aggregate_data or {}).get(app_key) or {}) if aggregate_data else {}

    if alarm_type == "Allowed Range":
        alarm_range = cmds.get("alarm_range")
        if (
            isinstance(alarm_range, (list, tuple))
            and len(alarm_range) == 2
            and all(isinstance(v, (int, float)) for v in alarm_range)
        ):
            low, high = sorted(float(v) for v in alarm_range)
            return low, high
        return None, None

    if alarm_type in ("Greater Than", "Less Than"):
        alarm_point = cmds.get("alarm_point")
        if not isinstance(alarm_point, (int, float)):
            return None, None
        point = float(alarm_point)
        if alarm_type == "Greater Than":
            return None, point
        return point, None

    # Unknown or missing alarm_type (e.g. deployment_config unavailable):
    # no authoritative key to read, so report no setpoint.
    return None, None


def alarm_type_from_app_config(app_config: Optional[Dict[str, Any]]) -> Optional[str]:
    """Extract a sensor app's alarm_type from its deployment_config block.

    The 4-20mA sensor app nests alarm config under an ``"alarm"`` object; the
    analog level sensor keeps ``alarm_type`` flat at the config root. An
    explicitly disabled alarm (alarm_enabled: false) yields None so no
    setpoint is rendered — matching both the sensor apps' behaviour and the
    cloud widget's resolver.
    """
    if not app_config:
        return None
    nested = app_config.get("alarm")
    block = nested if isinstance(nested, dict) else app_config
    if block.get("alarm_enabled") is False:
        return None
    if isinstance(nested, dict) and nested.get("alarm_type"):
        return nested["alarm_type"]
    alarm_type = app_config.get("alarm_type")
    return alarm_type if isinstance(alarm_type, str) else None


def volume_units_from_flow_units(flow_units: Optional[str]) -> str:
    """Derive the totaliser's volume unit label from the flow sensor's units."""
    if isinstance(flow_units, str) and flow_units.strip().upper() in _GALLON_FLOW_UNITS:
        return "gal"
    return "units"


class PetronashHmiApplication(Application):
    """Read-only HMI: assembles DashboardData v2 from other apps' channels.

    No socket handler, tag, or output of this app mutates anything — the pump
    controller app owns all control.
    """

    config_cls = PetronashHmiConfig
    tags_cls = PetronashHmiTags
    ui_cls = PetronashHmiUI

    config: PetronashHmiConfig
    tags: PetronashHmiTags

    async def setup(self):
        # Suppress platform interface INFO logs
        logging.getLogger("pydoover.docker.platform.platform").setLevel(logging.WARNING)

        self.started: float = time.time()
        self.loop_target_period = 0.5

        # Dev toolbar toggles via the PETRONASH_DEV_MODE env flag.
        self.dashboard = PetronashDashboard(host="0.0.0.0", port=8091, debug=False)
        self.dashboard_interface = DashboardInterface(self.dashboard)
        self.dashboard_interface.start_dashboard()

        # Sensor display units + alarm types: fetched once from deployment_config.
        self._measurement_units: Dict[str, Optional[str]] = {}
        self._alarm_types: Dict[str, Optional[str]] = {}
        await self._load_deployment_config()

        # Alarm setpoints: cached ui_cmds aggregate, refreshed on a slow cadence.
        self._ui_cmds_data: Dict[str, Any] = {}
        self._ui_cmds_fetched_at: Optional[float] = None
        await self._refresh_ui_cmds()

        log.info("Dashboard started on port 8091")

    async def _load_deployment_config(self):
        """Read sensor units + alarm types from deployment_config (tolerate absence)."""
        try:
            aggregate = await self.device_agent.fetch_channel_aggregate(
                "deployment_config"
            )
            applications = (aggregate.data or {}).get("applications") or {}
        except Exception as e:
            log.warning("Could not fetch deployment_config: %s", e)
            applications = {}

        flow_app = self.config.flow_sensor_app.value
        pressure_app = self.config.pressure_sensor_app.value

        for app_key in (flow_app, pressure_app):
            app_config = applications.get(app_key) or {}
            self._measurement_units[app_key] = app_config.get("measurement_units")
            self._alarm_types[app_key] = alarm_type_from_app_config(app_config)

    async def _refresh_ui_cmds(self):
        """Refresh the cached ui_cmds aggregate if the cache is stale."""
        now = time.monotonic()
        if (
            self._ui_cmds_fetched_at is not None
            and now - self._ui_cmds_fetched_at < UI_CMDS_REFRESH_PERIOD_S
        ):
            return

        self._ui_cmds_fetched_at = now
        try:
            aggregate = await self.device_agent.fetch_channel_aggregate("ui_cmds")
            self._ui_cmds_data = aggregate.data or {}
        except Exception as e:
            # Keep serving the previous cache; setpoints go stale, not wrong.
            log.warning("Could not fetch ui_cmds aggregate: %s", e)

    async def main_loop(self):
        await self._refresh_ui_cmds()
        self.dashboard.update_data(**self.assemble_dashboard_data())

    def assemble_dashboard_data(self) -> Dict[str, Any]:
        """Assemble the DashboardData v2 update dict from cached channel state.

        None always means "no data" — the UI renders a placeholder, never 0.
        """
        flow_app = self.config.flow_sensor_app.value
        pressure_app = self.config.pressure_sensor_app.value
        tank_app = self.config.tank_level_app.value
        pump_app = self.config.pump_controller_app.value

        flow_value = self.get_tag("value", app_key=flow_app, default=None)
        pressure_value = self.get_tag("value", app_key=pressure_app, default=None)

        tank_percent = self.get_tag(
            "level_filled_percentage", app_key=tank_app, default=None
        )
        # level_reading is published in metres; the dashboard works in mm.
        level_m = self.get_tag("level_reading", app_key=tank_app, default=None)
        level_mm = level_m * 1000 if level_m is not None else None

        flow_low, flow_high = resolve_alarm_setpoint(
            self._ui_cmds_data, flow_app, self._alarm_types.get(flow_app)
        )
        _, pressure_high = resolve_alarm_setpoint(
            self._ui_cmds_data, pressure_app, self._alarm_types.get(pressure_app)
        )

        flow_units = self._measurement_units.get(flow_app)
        length_unit = "inch" if "Inch" in str(self.config.display_units.value) else "mm"

        return {
            "pumps": {
                "pump_1": {
                    "on": self.get_tag("pump_1_on", app_key=pump_app, default=None)
                },
                "pump_2": {
                    "on": self.get_tag("pump_2_on", app_key=pump_app, default=None)
                },
            },
            "pressure": {
                "value": pressure_value,
                "units": self._measurement_units.get(pressure_app),
                "high_alarm": pressure_high,
            },
            "flow": {
                "value": flow_value,
                "units": flow_units,
                "high_alarm": flow_high,
                "low_alarm": flow_low,
            },
            "volume": {
                "total": self.get_tag("total_volume", app_key=pump_app, default=None),
                "units": volume_units_from_flow_units(flow_units),
            },
            "tank": {
                "percent": tank_percent,
                "level_mm": level_mm,
            },
            "units": {"length": length_unit},
            "alerts": {
                "unexpected_flow": bool(
                    self.get_tag(
                        "unexpected_flow_alert", app_key=pump_app, default=False
                    )
                ),
                "low_flow": bool(
                    self.get_tag("low_flow_alert", app_key=pump_app, default=False)
                ),
            },
        }
