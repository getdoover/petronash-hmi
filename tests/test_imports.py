"""
Basic tests for an application.

This ensures all modules are importable and that the config and UI schemas are valid.
"""

import json

from pydoover.config import Schema
from pydoover.tags import Tags
from pydoover.ui import UI

CONFIG_FIELDS = (
    "flow_sensor_app",
    "pressure_sensor_app",
    "tank_level_app",
    "pump_controller_app",
    "display_units",
)


def test_import_app():
    from petronash_hmi.application import PetronashHmiApplication

    assert PetronashHmiApplication.config_cls is not None
    assert PetronashHmiApplication.tags_cls is not None
    assert PetronashHmiApplication.ui_cls is not None


def test_config_schema():
    from petronash_hmi.app_config import PetronashHmiConfig

    assert issubclass(PetronashHmiConfig, Schema)

    schema = PetronashHmiConfig.to_schema()
    assert isinstance(schema, dict)
    assert schema["type"] == "object"

    # Exactly the v2 config surface — no genealogical debris.
    assert set(schema["properties"]) == set(CONFIG_FIELDS)

    # Every field carries a default, so nothing is required.
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


def test_tags():
    from petronash_hmi.app_tags import PetronashHmiTags

    assert issubclass(PetronashHmiTags, Tags)


def test_ui():
    from petronash_hmi.app_ui import PetronashHmiUI

    assert issubclass(PetronashHmiUI, UI)


def test_dashboard():
    from petronash_hmi.dashboard import DashboardData, PetronashDashboard

    assert PetronashDashboard
    assert isinstance(DashboardData().to_dict(), dict)


def test_dashboard_is_read_only():
    """The HMI is strictly read-only — no socket handler may mutate anything."""
    from petronash_hmi.dashboard import PetronashDashboard

    dashboard = PetronashDashboard(host="127.0.0.1", port=0)
    handlers = dashboard.socketio.server.handlers.get("/", {})
    assert "set_pump_state" not in handlers
    assert set(handlers) <= {"connect", "disconnect", "request_data"}


def test_config_export(tmp_path):
    from petronash_hmi.app_config import PetronashHmiConfig

    fp = tmp_path / "doover_config.json"
    PetronashHmiConfig.export(fp, "petronash_hmi")

    data = json.loads(fp.read_text())
    assert "config_schema" in data["petronash_hmi"]
    properties = data["petronash_hmi"]["config_schema"]["properties"]
    assert set(properties) == set(CONFIG_FIELDS)


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
    # The app defaults to the top of the device page, expanded.
    assert ui_schema["position"] == "$config.app().dv_app_position:number:0"
    assert ui_schema["defaultOpen"] == "$config.app().dv_app_default_open:boolean:true"
