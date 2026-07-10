from pydoover import tags


class PetronashHmiTags(tags.Tags):
    """State this app derives itself.

    Readings that belong to another app (tank level, solar, flow, pressure) are
    read straight off that app's tags and are deliberately not mirrored here.
    """

    # 0 = none, 1 = pump 1, 2 = pump 2, 3 = valve
    selector_state = tags.Number(default=None, live=True)
    valve_open = tags.Boolean(default=False, live=True)

    hh_pressure_fault = tags.Boolean(default=False, live=True)
    ll_tank_level_fault = tags.Boolean(default=False, live=True)
