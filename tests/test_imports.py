"""
Basic tests for an application.

This ensures all modules are importable and that the config and UI schemas are valid.
"""

import json

from pydoover.config import Schema
from pydoover.tags import Tags
from pydoover.ui import UI


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

    # The app has nothing to display without these, so they stay required.
    for name in (
        "pump_1_app",
        "pump_2_app",
        "solar_controllers",
        "flow_sensor_app",
        "pressure_sensor_app",
        "tank_level_app",
    ):
        assert name in schema["properties"]
        assert name in schema["required"]

    # display_units has a default, so it must not be required.
    assert "display_units" in schema["properties"]
    assert "display_units" not in schema["required"]


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


def test_config_export(tmp_path):
    from petronash_hmi.app_config import PetronashHmiConfig

    fp = tmp_path / "doover_config.json"
    PetronashHmiConfig.export(fp, "petronash_hmi")

    data = json.loads(fp.read_text())
    assert "config_schema" in data["petronash_hmi"]
    assert "properties" in data["petronash_hmi"]["config_schema"]


def test_ui_export(tmp_path):
    from petronash_hmi.app_ui import PetronashHmiUI

    fp = tmp_path / "doover_config.json"
    PetronashHmiUI(None, None, None).export(fp, "petronash_hmi")

    data = json.loads(fp.read_text())
    assert data["petronash_hmi"]["ui_schema"]["type"] == "uiApplication"
    assert "selector_state" in data["petronash_hmi"]["ui_schema"]["children"]
