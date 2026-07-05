"""Base class for all wAIver levels."""


class Level:
    """A single game level: terrain, spawn, objectives."""

    name = "Unnamed"
    subtitle = ""

    def build(self, grid):
        """Build the level terrain into the voxel grid."""
        raise NotImplementedError

    def spawn_pos(self):
        """Return (x, y) grid coordinates for player spawn."""
        raise NotImplementedError

    def check_complete(self, player, grid):
        """Return True if the player has completed this level."""
        return False

    def get_hint(self):
        """Return objective hint text shown on HUD."""
        return ""

    def enemy_spawns(self):
        """Return list of (x, y, patrol_left, patrol_right) for enemies."""
        return []
