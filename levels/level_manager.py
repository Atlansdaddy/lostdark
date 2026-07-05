"""Manages level progression."""
from .level_01_awakening import LevelAwakening
from .level_02_depths import LevelDepths


class LevelManager:
    """Tracks current level, handles advancement."""

    def __init__(self):
        self.levels = [
            LevelAwakening(),
            LevelDepths(),
        ]
        self.current_index = 0

    def current_level(self):
        """Return the current Level object."""
        if self.current_index < len(self.levels):
            return self.levels[self.current_index]
        return None

    def advance(self):
        """Move to the next level. Returns False if no more levels."""
        self.current_index += 1
        return self.current_index < len(self.levels)

    def reset_current(self):
        """Reset progress on the current level (re-build terrain)."""
        pass

    @property
    def is_final(self):
        return self.current_index >= len(self.levels) - 1
