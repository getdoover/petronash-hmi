"""
Basic tests for the widget-only PRO app.

Ensures the processor + its schemas are importable and valid. The HMI's actual
logic lives in the widget (widget/), tested under tests/js and the widget's own
node tests; this file only guards the app record's shape.
"""

import json

from pydoover.config import Schema
from pydoover.processor import Application
from pydoover.tags import Tags
from pydoover.ui import UI

# The widget reads these five out of deployment_config to know which peer apps
# to render. The dv_proc_* keys below are PRO plumbing, added by the processor
# config helpers.
CONFIG_FIELDS = (
    "flow_sensor_app",
    "pressure_sensor_app",
    "tank_level_app",
    "pump_controller_app",
    "display_units",
)
PROC_FIELDS = ("dv_proc_subscriptions",)


def test_import_app():
    from petronash_hmi.application import PetronashHmiApp

    # It is a cloud processor (PRO), not a device docker app.
    assert issubclass(PetronashHmiApp, Application)
    assert PetronashHmiApp.config_cls is not None
    assert PetronashHmiApp.ui_cls is not None


def test_handler_entrypoint_exists():
    # The Lambda handler is what makes the package a valid processor.
    from petronash_hmi import handler

    assert callable(handler)


def test_config_schema():
    from petronash_hmi.app_config import PetronashHmiConfig

    assert issubclass(PetronashHmiConfig, Schema)
    schema = PetronashHmiConfig.to_schema()
    assert schema["type"] == "object"

    props = set(schema["properties"])
    assert set(CONFIG_FIELDS) <= props  # the app fields
    assert set(PROC_FIELDS) <= props  # the PRO plumbing

    # Every app field carries a default, so nothing is required of the operator.
    for name in CONFIG_FIELDS:
        assert name not in schema.get("required", [])

    # Defaults match the standard solution deployment.
    assert schema["properties"]["flow_sensor_app"]["default"] == "4_20ma_sensor_1"
    assert schema["properties"]["pressure_sensor_app"]["default"] == "4_20ma_sensor_2"
    assert schema["properties"]["tank_level_app"]["default"] == "analog_level_sensor_1"
    assert (
        schema["properties"]["pump_controller_app"]["default"]
        == "petronash_pump_controller_1"
    )


def test_no_subscriptions_wired():
    """A widget-only app subscribes to nothing, so the Lambda is never invoked."""
    from petronash_hmi.app_config import PetronashHmiConfig

    schema = PetronashHmiConfig.to_schema()
    assert schema["properties"]["dv_proc_subscriptions"].get("default", []) == []


def test_tags_and_ui():
    from petronash_hmi.app_tags import PetronashHmiTags
    from petronash_hmi.app_ui import PetronashHmiUI

    assert issubclass(PetronashHmiTags, Tags)
    assert issubclass(PetronashHmiUI, UI)


def test_config_export(tmp_path):
    from petronash_hmi.app_config import PetronashHmiConfig

    fp = tmp_path / "doover_config.json"
    PetronashHmiConfig.export(fp, "petronash_hmi")

    data = json.loads(fp.read_text())
    props = set(data["petronash_hmi"]["config_schema"]["properties"])
    assert set(CONFIG_FIELDS) <= props


def test_ui_export(tmp_path):
    from petronash_hmi.app_ui import PetronashHmiUI

    fp = tmp_path / "doover_config.json"
    PetronashHmiUI(None, None, None).export(fp, "petronash_hmi")

    data = json.loads(fp.read_text())
    ui_schema = data["petronash_hmi"]["ui_schema"]
    assert ui_schema["type"] == "uiApplication"
    # The HMI's cloud UI is exactly one Module Federation remote component.
    assert set(ui_schema["children"]) == {"petronash_hmi_widget"}
    widget = ui_schema["children"]["petronash_hmi_widget"]
    assert widget["type"] == "uiRemoteComponent"
    assert widget["componentUrl"] == "$config.app().dv_widget_url"
    # Scope/module must stay in sync with widget/rsbuild.config.ts.
    assert widget["scope"] == "PetronashHmiWidget"
    assert widget["module"] == "./PetronashHmiWidget"
    assert ui_schema["position"] == "$config.app().dv_app_position:number:0"
    assert ui_schema["defaultOpen"] == "$config.app().dv_app_default_open:boolean:true"
