"""
Basic tests for an application.

This ensures all modules are importable and that the config is valid.
"""

def test_import_app():
    from petronash_hmi.application import SiaLocalControlUiApplication
    assert SiaLocalControlUiApplication

def test_config():
    from petronash_hmi.app_config import SiaLocalControlUiConfig

    config = SiaLocalControlUiConfig()
    assert isinstance(config.to_dict(), dict)