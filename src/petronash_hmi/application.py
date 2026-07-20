import logging

from pydoover.processor import Application
from pydoover.tags import Tags

from .app_config import PetronashHmiConfig
from .app_ui import PetronashHmiUI

log = logging.getLogger(__name__)


class PetronashHmiApp(Application):
    """Widget-only PRO app — no processor logic.

    The Petronash HMI is rendered entirely by its Module Federation widget
    (widget/), in both the cloud interpreter and the device-agent's local
    widget host. The widget reads the device's ``tag_values`` / ``ui_cmds`` /
    ``deployment_config`` channels directly and assembles its own view (see
    widget/src/lib/assembleDashboardData.ts), so there is nothing for a
    processor to do: this app exists to carry the config schema and the widget
    attachment. It subscribes to no channels and handles no events, so the
    Lambda is never invoked.
    """

    config_cls = PetronashHmiConfig
    tags_cls = Tags
    ui_cls = PetronashHmiUI

    async def setup(self):
        pass
