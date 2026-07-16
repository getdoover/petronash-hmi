"""Tests for the DashboardData v2 payload container."""

from petronash_hmi.dashboard import DashboardData

# Test-rig-shaped full update (flow Allowed Range set, pressure setpoint never set).
FULL_UPDATE = {
    "pumps": {"pump_1": {"on": True}, "pump_2": {"on": False}},
    "pressure": {"value": 3.2, "units": "PSI", "high_alarm": None},
    "flow": {"value": 42.7, "units": "GPD", "high_alarm": 63.3, "low_alarm": 34.2},
    "volume": {"total": 58213.0, "units": "gal"},
    "tank": {
        "percent": 48.8,
        "level_mm": 19030.0,
        "capacity": {"value": 100000.0, "units": "L"},
    },
    "units": {"length": "inch"},
    "alerts": {"unexpected_flow": False, "low_flow": True, "low_tank_time": True},
    "system": {"status": "running"},
}


def test_to_dict_v2_shape():
    """to_dict must produce exactly the binding DashboardData v2 shape."""
    d = DashboardData().to_dict()

    assert set(d) == {
        "pumps",
        "pressure",
        "flow",
        "volume",
        "tank",
        "units",
        "alerts",
        "system",
    }
    assert set(d["pumps"]) == {"pump_1", "pump_2"}
    assert set(d["pumps"]["pump_1"]) == {"on"}
    assert set(d["pumps"]["pump_2"]) == {"on"}
    assert set(d["pressure"]) == {"value", "units", "high_alarm"}
    assert set(d["flow"]) == {"value", "units", "high_alarm", "low_alarm"}
    assert set(d["volume"]) == {"total", "units"}
    assert set(d["tank"]) == {"percent", "level_mm", "capacity"}
    assert set(d["tank"]["capacity"]) == {"value", "units"}
    assert set(d["units"]) == {"length"}
    assert set(d["alerts"]) == {"unexpected_flow", "low_flow", "low_tank_time"}
    assert set(d["system"]) == {"timestamp", "status"}

    # No legacy v1 keys — clean break.
    for legacy in (
        "pump",
        "pump2",
        "skid",
        "solar",
        "selector",
        "valve",
        "faults",
        "alarms",
    ):
        assert legacy not in d


def test_defaults_are_no_data():
    """Fresh container: every reading is None ("no data"), never 0."""
    d = DashboardData().to_dict()

    assert d["pumps"]["pump_1"]["on"] is None
    assert d["pumps"]["pump_2"]["on"] is None
    assert d["pressure"]["value"] is None
    assert d["pressure"]["units"] is None
    assert d["pressure"]["high_alarm"] is None
    assert d["flow"]["value"] is None
    assert d["flow"]["high_alarm"] is None
    assert d["flow"]["low_alarm"] is None
    assert d["volume"]["total"] is None
    assert d["tank"]["percent"] is None
    assert d["tank"]["level_mm"] is None
    assert d["tank"]["capacity"] == {"value": None, "units": None}
    # Non-reading fields have real defaults.
    assert d["volume"]["units"] == "units"
    assert d["units"]["length"] == "inch"
    assert d["alerts"] == {
        "unexpected_flow": False,
        "low_flow": False,
        "low_tank_time": False,
    }
    assert d["system"]["status"] == "running"


def test_update_from_dict_round_trip():
    data = DashboardData()
    data.update_from_dict(FULL_UPDATE)
    d = data.to_dict()

    assert d["pumps"]["pump_1"]["on"] is True
    assert d["pumps"]["pump_2"]["on"] is False
    assert d["pressure"] == {"value": 3.2, "units": "PSI", "high_alarm": None}
    assert d["flow"] == {
        "value": 42.7,
        "units": "GPD",
        "high_alarm": 63.3,
        "low_alarm": 34.2,
    }
    assert d["volume"] == {"total": 58213.0, "units": "gal"}
    assert d["tank"] == {
        "percent": 48.8,
        "level_mm": 19030.0,
        "capacity": {"value": 100000.0, "units": "L"},
    }
    assert d["units"] == {"length": "inch"}
    assert d["alerts"] == {
        "unexpected_flow": False,
        "low_flow": True,
        "low_tank_time": True,
    }
    assert d["system"]["status"] == "running"


def test_tank_capacity_passthrough_and_clear():
    """tank.capacity is a dumb pass-through: set, kept when absent, cleared by None."""
    data = DashboardData()
    data.update_from_dict(FULL_UPDATE)
    assert data.to_dict()["tank"]["capacity"] == {"value": 100000.0, "units": "L"}

    # An update that omits capacity leaves it untouched.
    data.update_from_dict({"tank": {"percent": 10.0}})
    assert data.to_dict()["tank"]["capacity"] == {"value": 100000.0, "units": "L"}

    # An explicit None clears the reading.
    data.update_from_dict({"tank": {"capacity": {"value": None, "units": None}}})
    assert data.to_dict()["tank"]["capacity"] == {"value": None, "units": None}


def test_explicit_none_clears_reading():
    """A key present with None clears the reading (sensor went offline)."""
    data = DashboardData()
    data.update_from_dict(FULL_UPDATE)

    data.update_from_dict(
        {
            "flow": {"value": None},
            "pumps": {"pump_1": {"on": None}},
        }
    )
    d = data.to_dict()
    assert d["flow"]["value"] is None
    assert d["pumps"]["pump_1"]["on"] is None
    # Sibling keys absent from the update are untouched.
    assert d["flow"]["units"] == "GPD"
    assert d["flow"]["high_alarm"] == 63.3
    assert d["pumps"]["pump_2"]["on"] is False


def test_low_tank_time_alert_updates_independently():
    """The low_tank_time flag round-trips and toggles without disturbing siblings."""
    data = DashboardData()
    data.update_from_dict(FULL_UPDATE)
    assert data.to_dict()["alerts"]["low_tank_time"] is True

    # Clearing just this flag leaves the other two alerts untouched.
    data.update_from_dict({"alerts": {"low_tank_time": False}})
    alerts = data.to_dict()["alerts"]
    assert alerts == {
        "unexpected_flow": False,
        "low_flow": True,
        "low_tank_time": False,
    }


def test_absent_keys_keep_current_values():
    data = DashboardData()
    data.update_from_dict(FULL_UPDATE)

    data.update_from_dict({"tank": {"percent": 50.1}})
    d = data.to_dict()
    assert d["tank"] == {
        "percent": 50.1,
        "level_mm": 19030.0,
        "capacity": {"value": 100000.0, "units": "L"},
    }
    assert d["pressure"]["value"] == 3.2
