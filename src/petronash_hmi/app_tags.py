from pydoover import tags


class PetronashHmiTags(tags.Tags):
    """The HMI publishes no domain tags.

    It is a pure consumer: every reading it displays belongs to another app
    (sensor apps, pump controller) and is read straight off that app's tags
    or channels. Deliberately empty.
    """
