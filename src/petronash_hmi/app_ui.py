from pathlib import Path

from pydoover import ui

from .app_tags import PetronashHmiTags

_SELECTOR_LABELS = ["None", "Pump 1", "Pump 2", "Valve"]


class PetronashHmiUI(ui.UI):
    selector_state = ui.NumericVariable(
        "Selector",
        value=PetronashHmiTags.selector_state,
        name="selector_state",
        precision=0,
        ranges=[
            ui.Range(label, i, i + 1, ui.Colour.blue)
            for i, label in enumerate(_SELECTOR_LABELS)
        ],
    )
    valve_open = ui.BooleanVariable(
        "Valve Open", value=PetronashHmiTags.valve_open, name="valve_open"
    )

    hh_pressure_fault = ui.BooleanVariable(
        "High Pressure Alarm",
        value=PetronashHmiTags.hh_pressure_fault,
        name="hh_pressure_fault",
    )
    ll_tank_level_fault = ui.BooleanVariable(
        "Low Tank Level Alarm",
        value=PetronashHmiTags.ll_tank_level_fault,
        name="ll_tank_level_fault",
    )


def export():
    PetronashHmiUI(None, None, None).export(
        Path(__file__).parents[2] / "doover_config.json", "petronash_hmi"
    )


if __name__ == "__main__":
    export()
