from pathlib import Path

from pydoover import config


class PetronashHmiConfig(config.Schema):
    """Config for the read-only HMI.

    The HMI is a pure consumer: it reads the sensor apps' tags and alarm
    setpoints plus the pump controller's state tags, and renders them on the
    local panel. Defaults match the standard solution deployment; every field
    is operator-overridable.
    """

    flow_sensor_app = config.Application(
        "Flow Sensor App",
        default="4_20ma_sensor_1",
        description="The 4-20mA sensor application measuring flow rate",
    )
    pressure_sensor_app = config.Application(
        "Pressure Sensor App",
        default="4_20ma_sensor_2",
        description="The 4-20mA sensor application measuring pressure",
    )
    tank_level_app = config.Application(
        "Tank Level App",
        default="analog_level_sensor_1",
        description="The analog level sensor application measuring tank level",
    )
    pump_controller_app = config.Application(
        "Pump Controller App",
        default="petronash_pump_controller_1",
        description="The Petronash pump controller application (pump states, "
        "volume totaliser and alerts)",
    )
    display_units = config.Enum(
        "Display Units",
        choices=['Inch (")', "Millimeter (mm)"],
        default='Inch (")',
        description="Units used for length readings (e.g. tank level) on the screen",
    )


def export():
    PetronashHmiConfig.export(
        Path(__file__).parents[2] / "doover_config.json", "petronash_hmi"
    )


if __name__ == "__main__":
    export()
