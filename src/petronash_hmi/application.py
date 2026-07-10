import logging
import time

from pydoover.docker import Application

from .app_config import PetronashHmiConfig
from .app_tags import PetronashHmiTags
from .app_ui import PetronashHmiUI
from .dashboard import PetronashDashboard, DashboardInterface

log = logging.getLogger(__name__)

# Selector reads are analog; anything below this counts as "selected".
SELECTOR_THRESHOLD = 5


class PetronashHmiApplication(Application):
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

        await self.setup_selector()
        await self.setup_valve_control()

        log.info("Dashboard started on port 8091")

    async def setup_selector(self):
        aggregate = await self.device_agent.fetch_channel_aggregate("deployment_config")
        self._deployment_config = aggregate.data["applications"]

        pump_1 = self._deployment_config[self.config.pump_1_app.value]
        pump_2 = self._deployment_config[self.config.pump_2_app.value]

        self.pump_1_selector = pump_1["local_control"][0]["pump_selector_pin"]
        self.pump_2_selector = pump_2["local_control"][0]["pump_selector_pin"]

        self.selector_state = None
        await self.refresh_selector_state()
        self.dashboard_interface.update_selector_state(self.selector_state)

    async def setup_valve_control(self):
        pump_1 = self._deployment_config[self.config.pump_1_app.value]

        self.start_btn_pin = pump_1["local_control"][0]["start_button_pin"]
        self.stop_btn_pin = pump_1["local_control"][0]["stop_button_pin"]
        self.valve_control_pin = pump_1["calibration_output_pin"]

        self.start_btn_lstn = self.platform_iface.start_di_pulse_listener(
            self.start_btn_pin, self.start_btn_callback, edge="rising"
        )
        self.stop_btn_lstn = self.platform_iface.start_di_pulse_listener(
            self.stop_btn_pin, self.stop_btn_callback, edge="rising"
        )

        self.valve_control_state = await self.platform_iface.fetch_do(
            self.valve_control_pin
        )

    async def refresh_selector_state(self):
        """Derive the 3-position selector state from the two pump selector AIs."""
        p1_sel, p2_sel = await self.platform_iface.fetch_ai(
            self.pump_1_selector, self.pump_2_selector
        )

        p1_low = p1_sel < SELECTOR_THRESHOLD
        p2_low = p2_sel < SELECTOR_THRESHOLD

        if p1_low and p2_low:
            self.selector_state = 3
        elif p1_low:
            self.selector_state = 2
        elif p2_low:
            self.selector_state = 1
        else:
            self.selector_state = 0

        return self.selector_state

    def _pumps_calibrating(self) -> bool:
        states = (
            self.get_tag("AppState", self.config.pump_1_app.value),
            self.get_tag("AppState", self.config.pump_2_app.value),
        )
        return "calibration" in states

    async def _set_valve(self, value: int, action: str):
        if self.selector_state != 3:
            return

        if self._pumps_calibrating():
            await self.dashboard_interface.valve_control_popup()
            return

        log.info("%s valve", action)
        await self.platform_iface.set_do(self.valve_control_pin, value)

    async def start_btn_callback(self, di, val, dt_secs, counter, edge):
        log.info("Start button pressed")
        await self._set_valve(0, "Opening")

    async def stop_btn_callback(self, di, val, dt_secs, counter, edge):
        log.info("Stop button pressed")
        await self._set_valve(1, "Closing")

    async def main_loop(self):
        await self.update_dashboard_data()

    async def update_dashboard_data(self):
        update_data = {}

        await self.refresh_selector_state()
        update_data["selector"] = {"state": self.selector_state}

        update_data["pump"] = {
            "target_rate": self.get_tag("TargetRate", self.config.pump_1_app.value),
            "flow_rate": self.get_tag("FlowRate", self.config.pump_1_app.value),
            "pump_state": self.get_tag("StateString", self.config.pump_1_app.value),
        }

        # "enabled" tells the dashboard to render the Pump 2 card.
        update_data["pump2"] = {
            "enabled": True,
            "target_rate": self.get_tag("TargetRate", self.config.pump_2_app.value),
            "flow_rate": self.get_tag("FlowRate", self.config.pump_2_app.value),
            "pump_state": self.get_tag("StateString", self.config.pump_2_app.value),
        }

        valve_state = await self.platform_iface.fetch_do(self.valve_control_pin)
        if valve_state is not None:
            self.valve_control_state = valve_state
        update_data["valve"] = {"state": self.valve_control_state}

        pump_states = (
            self.get_tag("AppState", self.config.pump_1_app.value),
            self.get_tag("AppState", self.config.pump_2_app.value),
        )
        update_data["faults"] = {
            "ll_tank_level": "tank_level_low_low_level" in pump_states,
            "hh_pressure": "pressure_high_high_level" in pump_states,
        }

        solar_data = self.aggregate_solar_data()
        if solar_data:
            update_data["solar"] = solar_data

        tank_data = {}
        if self.config.tank_level_app:
            # level_reading is published in metres; the dashboard works in mm.
            level = self.get_tag("level_reading", self.config.tank_level_app.value)
            percent = self.get_tag(
                "level_filled_percentage", self.config.tank_level_app.value
            )
            if level is not None:
                tank_data["tank_level_mm"] = level * 1000
            if percent is not None:
                tank_data["tank_level_percent"] = percent
        if tank_data:
            update_data["tank"] = tank_data

        length_unit = "inch" if "Inch" in str(self.config.display_units.value) else "mm"
        update_data["units"] = {"length": length_unit}

        skid_data = {}
        if self.config.flow_sensor_app:
            skid_flow = self.get_tag("value", self.config.flow_sensor_app.value)
            if skid_flow is not None:
                skid_data["skid_flow"] = skid_flow
        if self.config.pressure_sensor_app:
            skid_pressure = self.get_tag("value", self.config.pressure_sensor_app.value)
            if skid_pressure is not None:
                skid_data["skid_pressure"] = skid_pressure
        if skid_data:
            update_data["skid"] = skid_data

        self.dashboard.update_data(**update_data)
        await self.publish_tags(update_data)

    def aggregate_solar_data(self) -> dict:
        """Average battery voltage/percentage/panel power and sum remaining amp-hours."""
        if not self.config.solar_controllers:
            return {}

        readings = {
            "b_voltage": [],
            "b_percent": [],
            "panel_power": [],
            "remaining_ah": [],
        }
        for controller in self.config.solar_controllers.elements:
            for tag_name in readings:
                value = self.get_tag(tag_name, controller.value)
                if value is not None:
                    readings[tag_name].append(value)

        def mean(values):
            return sum(values) / len(values) if values else None

        def total(values):
            return sum(values) if values else None

        solar_data = {
            "battery_voltage": mean(readings["b_voltage"]),
            "battery_percentage": mean(readings["b_percent"]),
            "panel_power": mean(readings["panel_power"]),
            "battery_ah": total(readings["remaining_ah"]),
        }
        return {k: v for k, v in solar_data.items() if v is not None}

    async def publish_tags(self, update_data: dict):
        """Mirror the state this app derives onto its own tags, for the cloud UI."""
        await self.tags.selector_state.set(self.selector_state)
        await self.tags.valve_open.set(not self.valve_control_state)

        faults = update_data["faults"]
        await self.tags.hh_pressure_fault.set(faults["hh_pressure"])
        await self.tags.ll_tank_level_fault.set(faults["ll_tank_level"])
