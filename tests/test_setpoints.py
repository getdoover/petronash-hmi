"""Tests for the pure alarm-setpoint resolution helpers in application.py."""

import pytest

from petronash_hmi.application import (
    alarm_type_from_app_config,
    resolve_alarm_setpoint,
    tank_alarm_display,
    volume_units_from_flow_units,
)


class TestTankAlarmDisplay:
    """The level sensor's alarm_source sets the setpoint's units."""

    def test_filled_percentage_is_a_percentage(self):
        # The live test rig: Greater Than @ 56.2 on "Filled Percentage".
        assert tank_alarm_display(None, 56.2, "Filled Percentage", "L", "inch") == (
            None,
            56.2,
            "%",
        )

    def test_volume_uses_the_sensors_volume_units(self):
        assert tank_alarm_display(None, 1000.0, "Volume", "L", "inch") == (
            None,
            1000.0,
            "L",
        )

    def test_level_reading_converts_metres_to_inches(self):
        low, high, units = tank_alarm_display(None, 1.0, "Level Reading", "L", "inch")
        assert low is None
        assert high == pytest.approx(1000.0 / 25.4)  # 1 m in inches
        assert units == '"'

    def test_level_reading_converts_metres_to_mm(self):
        _, high, units = tank_alarm_display(None, 1.5, "Level Reading", "L", "mm")
        assert high == pytest.approx(1500.0)
        assert units == "mm"

    def test_allowed_range_carries_both_bounds(self):
        assert tank_alarm_display(20.0, 80.0, "Filled Percentage", "L", "inch") == (
            20.0,
            80.0,
            "%",
        )

    def test_unknown_source_yields_no_setpoint(self):
        # Better no reading than a number labelled with the wrong units.
        assert tank_alarm_display(1.0, 2.0, None, "L", "inch") == (None, None, None)
        assert tank_alarm_display(1.0, 2.0, "Something Else", "L", "inch") == (
            None,
            None,
            None,
        )


# Shaped like the live test rig's ui_cmds aggregate data: flow has BOTH a stale
# alarm_point and the active alarm_range (stored high-first to prove sorting);
# pressure has no entry at all (slider never touched); level has a bare point.
UI_CMDS = {
    "4_20ma_sensor_1": {"alarm_point": 20, "alarm_range": [63.3, 34.2]},
    "analog_level_sensor_1": {"alarm_point": 39},
    "hi": "junk-from-other-test-apps",
}


def test_allowed_range_sorted():
    low, high = resolve_alarm_setpoint(UI_CMDS, "4_20ma_sensor_1", "Allowed Range")
    assert (low, high) == (34.2, 63.3)


def test_allowed_range_ignores_stale_alarm_point():
    """Stale sibling alarm_point must not leak into an Allowed Range read."""
    low, high = resolve_alarm_setpoint(
        {"4_20ma_sensor_1": {"alarm_point": 20}}, "4_20ma_sensor_1", "Allowed Range"
    )
    assert (low, high) == (None, None)


def test_greater_than():
    low, high = resolve_alarm_setpoint(UI_CMDS, "analog_level_sensor_1", "Greater Than")
    assert (low, high) == (None, 39.0)


def test_less_than():
    low, high = resolve_alarm_setpoint(
        {"some_app": {"alarm_point": 7.5}}, "some_app", "Less Than"
    )
    assert (low, high) == (7.5, None)


def test_app_key_absent_from_ui_cmds():
    """Slider never touched → app key absent entirely → no setpoint, no error."""
    low, high = resolve_alarm_setpoint(UI_CMDS, "4_20ma_sensor_2", "Greater Than")
    assert (low, high) == (None, None)


def test_ui_cmds_aggregate_absent():
    """No ui_cmds data at all (empty or None aggregate) → no setpoint."""
    assert resolve_alarm_setpoint({}, "4_20ma_sensor_1", "Allowed Range") == (
        None,
        None,
    )
    assert resolve_alarm_setpoint(None, "4_20ma_sensor_1", "Allowed Range") == (
        None,
        None,
    )
    assert resolve_alarm_setpoint(None, "4_20ma_sensor_2", "Greater Than") == (
        None,
        None,
    )


def test_unknown_alarm_type():
    """No alarm_type (deployment_config unavailable) → no authoritative key."""
    assert resolve_alarm_setpoint(UI_CMDS, "4_20ma_sensor_1", None) == (None, None)
    assert resolve_alarm_setpoint(UI_CMDS, "4_20ma_sensor_1", "Bogus") == (None, None)


def test_malformed_values_are_no_setpoint():
    assert resolve_alarm_setpoint(
        {"a": {"alarm_range": [1.0]}}, "a", "Allowed Range"
    ) == (None, None)
    assert resolve_alarm_setpoint(
        {"a": {"alarm_range": "34,63"}}, "a", "Allowed Range"
    ) == (None, None)
    assert resolve_alarm_setpoint(
        {"a": {"alarm_point": "high"}}, "a", "Greater Than"
    ) == (None, None)
    assert resolve_alarm_setpoint({"a": {"alarm_point": None}}, "a", "Less Than") == (
        None,
        None,
    )


def test_alarm_type_from_app_config():
    # 4-20mA app: nested under "alarm".
    assert (
        alarm_type_from_app_config({"alarm": {"alarm_type": "Allowed Range"}})
        == "Allowed Range"
    )
    # Analog level sensor: flat at the config root.
    assert alarm_type_from_app_config({"alarm_type": "Greater Than"}) == "Greater Than"
    assert alarm_type_from_app_config({}) is None
    assert alarm_type_from_app_config(None) is None


def test_volume_units_from_flow_units():
    assert volume_units_from_flow_units("GPD") == "gal"
    assert volume_units_from_flow_units("gph") == "gal"
    assert volume_units_from_flow_units("L/min") == "units"
    assert volume_units_from_flow_units(None) == "units"


def test_alarm_type_suppressed_when_alarm_disabled():
    """alarm_enabled: false yields no alarm_type — matching the cloud widget."""
    from petronash_hmi.application import alarm_type_from_app_config

    # 4-20mA shape: nested alarm block
    nested = {"alarm": {"alarm_enabled": False, "alarm_type": "Allowed Range"}}
    assert alarm_type_from_app_config(nested) is None

    # level-sensor shape: flat keys
    flat = {"alarm_enabled": False, "alarm_type": "Greater Than"}
    assert alarm_type_from_app_config(flat) is None

    # enabled (or unspecified) still resolves
    assert (
        alarm_type_from_app_config(
            {"alarm": {"alarm_enabled": True, "alarm_type": "Allowed Range"}}
        )
        == "Allowed Range"
    )
    assert alarm_type_from_app_config({"alarm_type": "Less Than"}) == "Less Than"
