from pathlib import Path

from pydoover import config


class PetronashHmiConfig(config.Schema):
    pump_1_app = config.Application(
        "Pump 1 App", description="The pump controller application for pump 1"
    )
    pump_2_app = config.Application(
        "Pump 2 App", description="The pump controller application for pump 2"
    )
    solar_controllers = config.Array(
        "Solar Controllers",
        element=config.Application(
            "Solar Controller", description="A solar controller application"
        ),
        description="List of solar controller applications",
    )
    flow_sensor_app = config.Application(
        "Flow Sensor App", description="A flow sensor application"
    )
    pressure_sensor_app = config.Application(
        "Pressure Sensor App", description="A pressure sensor application"
    )
    tank_level_app = config.Application(
        "Tank Level App", description="The tank level application"
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
