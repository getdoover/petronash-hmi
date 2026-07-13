from pathlib import Path

from pydoover import ui


class PetronashHmiUI(ui.UI):
    """Minimal cloud UI.

    The HMI's cloud presence is a Module Federation widget declared via the
    `widget:` field in doover_config.json (owned by the deployment integrator),
    not pydoover UI elements. This class stays empty so the exported ui_schema
    remains a valid, bare uiApplication node.
    """


def export():
    PetronashHmiUI(None, None, None).export(
        Path(__file__).parents[2] / "doover_config.json", "petronash_hmi"
    )


if __name__ == "__main__":
    export()
