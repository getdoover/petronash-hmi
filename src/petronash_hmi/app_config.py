from pathlib import Path

from pydoover import config
from pydoover.processor.config import ManySubscriptionConfig


class PetronashHmiConfig(config.Schema):
    """Config for the read-only HMI.

    The HMI is a widget-only PRO app: the widget reads the sensor apps' tags
    and alarm setpoints plus the pump controller's state tags and renders them.
    These fields tell the widget which peer apps to read; every field has a
    default matching the standard solution deployment and is operator-
    overridable. The widget reads them straight from deployment_config, so a
    change takes effect on its next render without redeploying anything.
    """

    flow_sensor_app = config.Application(
        "Flow Sensor App",
        default="4_20ma_sensor_1",
        description="The 4-20mA sensor application measuring flow rate",
        hidden=True,
    )
    pressure_sensor_app = config.Application(
        "Pressure Sensor App",
        default="4_20ma_sensor_2",
        description="The 4-20mA sensor application measuring pressure",
        hidden=True,
    )
    tank_level_app = config.Application(
        "Tank Level App",
        default="analog_level_sensor_1",
        description="The analog level sensor application measuring tank level",
        hidden=True,
    )
    pump_controller_app = config.Application(
        "Pump Controller App",
        default="petronash_pump_controller_1",
        description="The Petronash pump controller application (pump states, "
        "volume totaliser and alerts)",
        hidden=True,
    )
    display_units = config.Enum(
        "Display Units",
        choices=['Inch (")', "Millimeter (mm)"],
        default='Inch (")',
        description="Units used for length readings (e.g. tank level) on the screen",
    )
    # The Time to Empty readout divides the tank volume by the flow, so it
    # inherits the noise of BOTH sensors and shows far more of it than either
    # tile does. These two fields tune the widget-side filter (see
    # createTimeToEmptyEstimator in static/js/hmi-core.js). Their runtime keys
    # are derived from the DISPLAY NAMES above them, not these attribute names,
    # so the two are kept identical on purpose.
    time_to_empty_smoothing_s = config.Number(
        "Time to Empty Smoothing (s)",
        default=300.0,
        minimum=0.0,
        description="Time constant, in seconds, of the smoothing applied to the "
        "flow and tank level feeding the Time to Empty readout. 0 disables "
        "smoothing. Only affects the readout, not alarms.",
    )
    time_to_empty_min_flow_percent = config.Number(
        "Time to Empty Min Flow Percent",
        default=1.0,
        minimum=0.0,
        maximum=100.0,
        description="Below this percentage of the flow sensor's range the Time "
        "to Empty readout shows a dash instead of a number, so the 4 mA noise "
        "floor with the pumps off does not render as thousands of days.",
    )

    # --- processor plumbing ---------------------------------------------
    # The HMI does no processor work, so it subscribes to nothing: an EMPTY
    # subscriptions default means the deployer wires no SNS trigger and the
    # Lambda is never invoked (the opposite of the segmenter, which needs
    # "dv-rpc"). Deliberately NO ScheduleConfig/TimezoneConfig: those make the
    # deployer create an AWS EventBridge schedule, which fails for an app that
    # has no valid schedule expression ("Invalid Schedule Expression").
    subscriptions = ManySubscriptionConfig(default=[])


def export():
    PetronashHmiConfig.export(
        Path(__file__).parents[2] / "doover_config.json", "petronash_hmi"
    )


if __name__ == "__main__":
    export()
