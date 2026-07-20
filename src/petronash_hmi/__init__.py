from typing import Any


def handler(event: dict[str, Any], context):
    """AWS Lambda entry point for the Petronash HMI processor.

    The HMI is a widget-only PRO app: its cloud UI and device-local display are
    both the Module Federation widget (widget/), which reads the device's
    channels directly and assembles its own view. This processor carries the
    app's config schema + widget and has no runtime work, so the Lambda is never
    invoked in practice; the handler exists only to make the package a valid
    processor. Import lazily so cold-start cost is paid only if it ever runs.
    """
    from pydoover.processor import run_app

    from .application import PetronashHmiApp

    run_app(PetronashHmiApp(), event, context)
