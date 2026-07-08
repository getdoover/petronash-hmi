from pydoover.docker import run_app

from .application import SiaLocalControlUiApplication
from .app_config import SiaLocalControlUiConfig

def main():
    """
    Run the application.
    """
    run_app(SiaLocalControlUiApplication(config=SiaLocalControlUiConfig()))
