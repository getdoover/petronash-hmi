from pathlib import Path

from pydoover import ui


class PetronashHmiUI(
    ui.UI,
    # Default to the top of the device page, expanded; both remain
    # per-install overridable via dv_app_position / dv_app_default_open.
    position="$config.app().dv_app_position:number:0",
    default_open="$config.app().dv_app_default_open:boolean:true",
):
    """Cloud UI: a single Module Federation remote component.

    The widget (widget/ — built to a single JS asset and uploaded via the
    `widget:` field in doover_config.json) renders the same HMI as the
    device-local dashboard. `dv_widget_url` is injected into this install's
    deployment config by the platform on every deploy.
    """

    hmi_widget = ui.RemoteComponent(
        "Petronash HMI",
        "$config.app().dv_widget_url",
        name="petronash_hmi_widget",
        scope="PetronashHmiWidget",
        module="./PetronashHmiWidget",
        app_key="$config.app().APP_KEY",
    )


def export():
    PetronashHmiUI(None, None, None).export(
        Path(__file__).parents[2] / "doover_config.json", "petronash_hmi"
    )


if __name__ == "__main__":
    export()
