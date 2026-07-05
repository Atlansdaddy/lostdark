"""Level 1: The Reek. First awakening and pulse-driven exploration."""
from .. import config, materials
from .level_base import Level


class LevelAwakening(Level):
    """
    Opening level for the current vertical-slice direction.
    The player wakes in a sealed chamber, breaks through glass, traverses
    a glowing cavern, and reaches the first beacon-like objective.
    """

    name = "The Reek"
    subtitle = "Awaken and see"

    def __init__(self):
        self._exit_x = 0
        self._exit_y = 0

    def build(self, grid):
        W, H = config.GRID_W, config.GRID_H
        wall = 8

        # --- Outer enclosure ---
        grid.set_rect(0, 0, W, wall, materials.STONE)
        grid.set_rect(0, H - wall, W, wall, materials.STONE)
        grid.set_rect(0, 0, wall, H, materials.STONE)
        grid.set_rect(W - wall, 0, wall, H, materials.STONE)

        # Ground (dirt over stone)
        ground_y = H - wall - 25
        grid.set_rect(wall, ground_y, W - 2 * wall, 10, materials.DIRT)
        grid.set_rect(wall, ground_y + 10, W - 2 * wall, 15, materials.STONE)

        # === Starting Chamber (sealed, left side) ===
        cx, cy = wall + 6, ground_y - 28
        cw, ch = 38, 32
        grid.set_rect(cx, cy, cw, ch, materials.STONE)
        grid.set_rect(cx + 4, cy + 4, cw - 8, ch - 4, materials.AIR)
        # Glass wall exit (breakable!)
        grid.set_rect(cx + cw - 4, cy + 8, 4, 18, materials.GLASS)

        # === Cavern section ===
        # Stalactites from ceiling
        for i in range(5):
            sx = wall + 55 + i * 25
            sh = 15 + (i * 11) % 20
            sw = 3 + (i * 2) % 3
            if sx + sw < W // 2:
                grid.set_rect(sx, wall, sw, sh, materials.STONE)

        # Stone pillars
        grid.set_rect(wall + 100, ground_y - 30, 6, 30, materials.STONE)
        grid.set_rect(wall + 155, ground_y - 40, 5, 40, materials.STONE)

        # === Platform crossing ===
        # Scale platform positions proportionally to available width
        mid_x = W // 2 - 30
        platforms = [
            (mid_x - 20, ground_y - 15, 22, 3),
            (mid_x + 10, ground_y - 30, 20, 3),
            (mid_x + 45, ground_y - 45, 22, 3),
            (mid_x + 80, ground_y - 30, 20, 3),
            (mid_x + 110, ground_y - 15, 22, 3),
        ]
        for px, py, pw, ph in platforms:
            if wall < px and px + pw < W - wall:
                grid.set_rect(px, py, pw, ph, materials.WOOD)

        # Support pillars for platforms
        if mid_x + 18 < W - wall:
            grid.set_rect(mid_x + 18, ground_y - 30, 3, 30, materials.WOOD)
        if mid_x + 54 < W - wall:
            grid.set_rect(mid_x + 54, ground_y - 45, 3, 45, materials.WOOD)

        # === Glass crystal formation ===
        import math
        crystal_x = W - wall - 120
        crystal_y = H // 2
        if crystal_x > W // 2:
            for angle_deg in range(0, 360, 45):
                angle = math.radians(angle_deg)
                length = 8 + (angle_deg * 3) % 6
                for r in range(length):
                    gx = int(crystal_x + r * math.cos(angle))
                    gy = int(crystal_y + r * math.sin(angle))
                    if wall < gx < W - wall and wall + 10 < gy < ground_y - 5:
                        grid.set_rect(max(wall, gx - 1), max(wall, gy - 1),
                                      3, 3, materials.GLASS)

        # === Final approach (stone ledges) ===
        grid.set_rect(W - wall - 130, ground_y - 25, 30, 3, materials.STONE)
        grid.set_rect(W - wall - 90, ground_y - 40, 25, 3, materials.STONE)

        # === Exit Beacon ===
        ex = W - wall - 45
        ey = ground_y - 28
        self._exit_x = ex
        self._exit_y = ey
        # Base platform
        grid.set_rect(ex - 10, ground_y - 4, 28, 4, materials.METAL)
        # Vertical pole
        grid.set_rect(ex, ey, 4, 24, materials.METAL)
        # Glass cap
        grid.set_rect(ex - 1, ey - 3, 6, 3, materials.GLASS)
        # Base detail
        grid.set_rect(ex - 2, ey + 21, 8, 3, materials.METAL)

        # === Sand deposits ===
        grid.set_rect(wall + 30, ground_y - 3, 40, 3, materials.SAND)
        grid.set_rect(W // 2 - 15, ground_y - 2, 30, 2, materials.SAND)

        # === Ceiling stalactites (throughout) ===
        for i in range(8):
            sx = wall + 30 + i * (W // 10)
            sh = 10 + (i * 7) % 15
            sw = 3 + (i * 2) % 3
            if sx + sw < W - wall:
                grid.set_rect(sx, wall, sw, sh, materials.STONE)

    def spawn_pos(self):
        wall = 8
        H = config.GRID_H
        ground_y = H - wall - 25
        return wall + 20, ground_y - 15

    def check_complete(self, player, grid):
        dx = abs(player.center_x - (self._exit_x + 2))
        dy = abs(player.center_y - (self._exit_y + 12))
        return dx < 12 and dy < 20

    def get_hint(self):
        return "Follow the glow. Waves reveal the path."

    def enemy_spawns(self):
        wall = 8
        W = config.GRID_W
        H = config.GRID_H
        ground_y = H - wall - 25
        mid_x = W // 2 - 30
        return [
            # One patrolling the main cavern floor
            (wall + 80, ground_y - 5, wall + 50, wall + 160),
            # One near the exit beacon
            (W - wall - 80, ground_y - 5, W - wall - 120, W - wall - 30),
        ]
