"""Level 2: First Bastion. Early build-and-hold-light pressure."""
import math
from .. import config, materials
from .level_base import Level


class LevelDepths(Level):
    """
    Multi-section cave (~2 screens wide) focused on early building pressure.
    Gaps require bridge building while the player pushes toward beacon goals.
    """

    name = "First Bastion"
    subtitle = "Build to hold light"

    def __init__(self):
        self._beacons = []
        self._beacons_reached = set()

    def build(self, grid):
        W, H = config.GRID_W, config.GRID_H
        wall = 8

        # Outer enclosure
        grid.set_rect(0, 0, W, wall, materials.STONE)
        grid.set_rect(0, H - wall, W, wall, materials.STONE)
        grid.set_rect(0, 0, wall, H, materials.STONE)
        grid.set_rect(W - wall, 0, wall, H, materials.STONE)

        ground_y = H - wall - 25

        # === Section 1: Start (left) ===
        sec1_end = W // 4 + 10  # ~130 at W=480
        grid.set_rect(wall, ground_y, sec1_end - wall, 10, materials.DIRT)
        grid.set_rect(wall, ground_y + 10, sec1_end - wall, 15, materials.STONE)

        # Stone pillars in start area
        grid.set_rect(wall + 25, ground_y - 20, 5, 20, materials.STONE)
        grid.set_rect(wall + 65, ground_y - 28, 6, 28, materials.STONE)

        # Ceiling stalactites (start area)
        for i in range(3):
            sx = wall + 15 + i * 30
            sh = 12 + (i * 9) % 15
            sw = 3 + (i * 2) % 3
            grid.set_rect(sx, wall, sw, sh, materials.STONE)

        # === Gap 1 (~30 wide) - needs bridge! ===
        gap1_start = sec1_end
        gap1_end = gap1_start + 30

        # === Section 2: Bunker area ===
        sec2_start = gap1_end
        sec2_end = W * 3 // 5  # ~288 at W=480
        grid.set_rect(sec2_start, ground_y, sec2_end - sec2_start, 10, materials.DIRT)
        grid.set_rect(sec2_start, ground_y + 10, sec2_end - sec2_start, 15, materials.STONE)

        # Metal bunker
        bx = sec2_start + 20
        by = ground_y - 48
        bw, bh_b = 55, 52
        grid.set_rect(bx, by, bw, bh_b, materials.METAL)
        grid.set_rect(bx + 3, by + 3, bw - 6, 20, materials.AIR)      # upper room
        grid.set_rect(bx + 3, by + 27, bw - 6, 21, materials.AIR)     # lower room
        grid.set_rect(bx + 3, by + 23, bw - 6, 4, materials.METAL)    # mid floor
        # Windows
        for wy in [by + 6, by + 30]:
            grid.set_rect(bx + 8, wy, 8, 7, materials.GLASS)
            grid.set_rect(bx + 28, wy, 10, 7, materials.GLASS)
        # Door
        grid.set_rect(bx + 20, by + 40, 14, 16, materials.AIR)
        # Roof hatch
        grid.set_rect(bx + 22, by - 3, 8, 3, materials.AIR)

        # Support pillar left of bunker
        grid.set_rect(sec2_start + 5, ground_y - 32, 5, 32, materials.STONE)
        # Pillar right of bunker
        grid.set_rect(bx + bw + 10, ground_y - 25, 5, 25, materials.STONE)

        # === Gap 2 (~35 wide) - needs bridge! ===
        gap2_start = sec2_end
        gap2_end = gap2_start + 35

        # === Section 3: Crystal cave + vertical climb ===
        sec3_start = gap2_end
        grid.set_rect(sec3_start, ground_y - 3, W - wall - sec3_start, 13, materials.STONE)
        grid.set_rect(sec3_start, ground_y - 8, W - wall - sec3_start, 5, materials.DIRT)

        # Crystal formations
        cx1 = sec3_start + 30
        cx2 = sec3_start + 70
        for cx_c, cy_c in [(cx1, H // 2 + 5), (cx2, H // 2 - 15)]:
            for angle_deg in range(0, 360, 45):
                angle = math.radians(angle_deg)
                length = 7 + (angle_deg * 3) % 6
                for r in range(length):
                    gx = int(cx_c + r * math.cos(angle))
                    gy = int(cy_c + r * math.sin(angle))
                    if wall < gx < W - wall and wall + 12 < gy < ground_y - 8:
                        grid.set_rect(max(wall, gx - 1), max(wall, gy - 1),
                                      3, 3, materials.GLASS)

        # Vertical climb (right side)
        climb_x = W - wall - 80
        climb_platforms = [
            (climb_x, ground_y - 18, 22, 3),
            (climb_x + 20, ground_y - 38, 18, 3),
            (climb_x - 5, ground_y - 58, 22, 3),
            (climb_x + 15, ground_y - 78, 18, 3),
            (climb_x - 10, ground_y - 98, 22, 3),
        ]
        for px, py, pw, ph in climb_platforms:
            if py > wall + 8 and px > wall and px + pw < W - wall:
                grid.set_rect(px, py, pw, ph, materials.WOOD)

        # Tall climb pillar
        pillar_x = climb_x + 30
        if pillar_x < W - wall:
            grid.set_rect(pillar_x, wall + 25, 5, ground_y - wall - 30, materials.STONE)

        # Climb support ladders (wood verticals)
        grid.set_rect(climb_x + 8, ground_y - 38, 3, 38, materials.WOOD)
        if climb_x + 24 < W - wall:
            grid.set_rect(climb_x + 24, ground_y - 78, 3, 60, materials.WOOD)

        # High shelf near ceiling
        shelf_x = W - wall - 110
        grid.set_rect(shelf_x, wall + 18, 80, 4, materials.STONE)

        # Ceiling stalactites (throughout)
        for i in range(12):
            sx = wall + 20 + i * (W // 13)
            sh = 12 + (i * 9) % 16
            sw = 3 + (i * 2) % 3
            if sx + sw < W - wall:
                grid.set_rect(sx, wall, sw, sh, materials.STONE)

        # === Beacons ===
        self._beacons = []

        # Beacon 1: Bunker roof
        b1x, b1y = bx + 22, by - 16
        grid.set_rect(b1x, b1y, 4, 13, materials.METAL)
        grid.set_rect(b1x - 1, b1y - 3, 6, 3, materials.GLASS)
        self._beacons.append((b1x + 2, b1y + 6))

        # Beacon 2: Crystal cave ground
        b2x = sec3_start + 50
        b2y = ground_y - 18
        grid.set_rect(b2x, b2y, 4, 10, materials.METAL)
        grid.set_rect(b2x - 1, b2y - 3, 6, 3, materials.GLASS)
        self._beacons.append((b2x + 2, b2y + 5))

        # Beacon 3: High shelf (hardest - requires vertical climb)
        b3x = shelf_x + 30
        b3y = wall + 5
        grid.set_rect(b3x, b3y, 4, 13, materials.METAL)
        grid.set_rect(b3x - 1, b3y - 3, 6, 3, materials.GLASS)
        self._beacons.append((b3x + 2, b3y + 6))

        # Sand deposits
        grid.set_rect(wall + 20, ground_y - 2, 35, 2, materials.SAND)
        grid.set_rect(sec2_start + 10, ground_y - 2, 40, 2, materials.SAND)
        grid.set_rect(sec3_start + 5, ground_y - 10, 30, 2, materials.SAND)

        self._beacons_reached = set()

    def spawn_pos(self):
        wall = 8
        H = config.GRID_H
        ground_y = H - wall - 25
        return wall + 20, ground_y - 12

    def check_complete(self, player, grid):
        for i, (bx, by) in enumerate(self._beacons):
            if i not in self._beacons_reached:
                dx = abs(player.center_x - bx)
                dy = abs(player.center_y - by)
                if dx < 10 and dy < 15:
                    self._beacons_reached.add(i)
        return len(self._beacons_reached) >= 3

    def get_hint(self):
        reached = len(self._beacons_reached)
        if reached == 0:
            return "Build paths. Reach the light anchors. (0/3)"
        elif reached < 3:
            return f"Light anchors reached: {reached}/3"
        return "All light anchors reached!"

    def enemy_spawns(self):
        W, H = config.GRID_W, config.GRID_H
        wall = 8
        ground_y = H - wall - 25
        sec1_end = W // 4 + 10
        gap1_end = sec1_end + 30
        sec2_start = gap1_end
        sec2_end = W * 3 // 5
        gap2_end = sec2_end + 35
        sec3_start = gap2_end
        climb_x = W - wall - 80
        return [
            # Section 1: start area patrol
            (wall + 40, ground_y - 5, wall + 10, sec1_end - 5),
            # Section 2: bunker area
            (sec2_start + 10, ground_y - 5, sec2_start + 5, sec2_end - 5),
            # Section 3: crystal cave floor
            (sec3_start + 20, ground_y - 12, sec3_start + 5, climb_x - 5),
            # Vertical climb guard
            (climb_x + 5, ground_y - 22, climb_x - 10, climb_x + 35),
        ]
