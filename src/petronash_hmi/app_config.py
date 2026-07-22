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
