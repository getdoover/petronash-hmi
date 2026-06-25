from pathlib import Path

from pydoover import config


class SiaLocalControlUiConfig(config.Schema):
    def __init__(self):
        self.pump_controllers = config.Array(
            "Pump Controllers",
            element=config.Application("Pump Controller", description="A pump controller application"),
            description="List of pump controller applications"
        )
        
        self.solar_controllers = config.Array(
            "Solar Controllers", 
            element=config.Application("Solar Controller", description="A solar controller application"),
            description="List of solar controller applications"
        )
        
        self.flow_sensor_app = config.Application("Flow Sensor App", description="A flow sensor application")
        
        self.pressure_sensor_app = config.Application("Pressure Sensor App", description="A pressure sensor application")
            
        self.tank_level_app = config.Application("Tank Level App", description="The tank level application")

        self.display_units = config.Enum(
            "Display Units",
            choices=['Millimeter (mm)', 'Inch (")'],
            default='Millimeter (mm)',
            description="Units used for length readings (e.g. tank level) on the screen",
        )

def export():
    SiaLocalControlUiConfig().export(Path(__file__).parents[2] / "doover_config.json", "sia_local_control_ui")

if __name__ == "__main__":
    export()
