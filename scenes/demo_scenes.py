"""Pre-built demo scenes for showcasing destruction mechanics."""
from .. import config, materials
from ..core.voxel_grid import VoxelGrid
from ..systems.physics_system import PhysicsSystem
from ..rendering.renderer import Renderer
from .scene_base import Scene


def build_tower_collapse(grid):
    """Tall tower designed to crumble satisfyingly."""
    W, H = config.GRID_W, config.GRID_H

    # Ground
    grid.set_rect(0, H - 30, W, 30, materials.STONE)
    grid.set_rect(0, H - 40, W, 10, materials.DIRT)

    # Tall stone tower
    tx = W // 2 - 15
    for layer in range(0, 120, 4):
        y = H - 40 - layer
        if y < 10:
            break
        grid.set_rect(tx, y, 30, 4, materials.STONE)
        # Windows every other layer
        if layer % 12 == 8:
            grid.set_rect(tx + 3, y, 6, 3, materials.GLASS)
            grid.set_rect(tx + 21, y, 6, 3, materials.GLASS)


def build_glass_dome(grid):
    """Glass dome with stone base - shatters spectacularly."""
    W, H = config.GRID_W, config.GRID_H

    # Ground
    grid.set_rect(0, H - 30, W, 30, materials.STONE)

    # Stone base
    cx, cy = W // 2, H - 30
    base_w = 120
    grid.set_rect(cx - base_w // 2, cy - 10, base_w, 10, materials.STONE)

    # Glass dome (circle arc)
    dome_r = 50
    dome_cx, dome_cy = cx, cy - 10
    for angle_deg in range(0, 181, 1):
        import math
        angle = math.radians(angle_deg)
        x = int(dome_cx + dome_r * math.cos(angle))
        y = int(dome_cy - dome_r * math.sin(angle))
        if 0 <= x < W and 0 <= y < H:
            grid.set_rect(max(0, x - 1), max(0, y - 1), 3, 3, materials.GLASS)


def build_chain_reaction(grid):
    """Series of structures designed to chain-react when one falls."""
    W, H = config.GRID_W, config.GRID_H

    # Ground
    grid.set_rect(0, H - 30, W, 30, materials.STONE)
    grid.set_rect(0, H - 35, W, 5, materials.DIRT)

    # Domino pillars
    spacing = 40
    for i in range(10):
        x = 60 + i * spacing
        pillar_h = 50 + i * 5
        y = H - 35 - pillar_h
        if x + 8 < W and y > 0:
            # Alternating materials for variety
            mat = materials.STONE if i % 3 == 0 else (materials.WOOD if i % 3 == 1 else materials.GLASS)
            grid.set_rect(x, y, 8, pillar_h, mat)

            # Small platform on top
            grid.set_rect(x - 5, y - 3, 18, 3, materials.METAL)


def build_fortress(grid):
    """Multi-material fortress with weak points."""
    W, H = config.GRID_W, config.GRID_H

    # Ground
    grid.set_rect(0, H - 30, W, 30, materials.STONE)

    base_y = H - 30
    fx = W // 2 - 80

    # Outer walls (stone)
    grid.set_rect(fx, base_y - 60, 10, 60, materials.STONE)
    grid.set_rect(fx + 150, base_y - 60, 10, 60, materials.STONE)

    # Top wall
    grid.set_rect(fx, base_y - 60, 160, 8, materials.STONE)

    # Inner wood structure (flammable!)
    grid.set_rect(fx + 30, base_y - 40, 100, 4, materials.WOOD)
    grid.set_rect(fx + 40, base_y - 40, 4, 40, materials.WOOD)
    grid.set_rect(fx + 116, base_y - 40, 4, 40, materials.WOOD)

    # Glass windows (weak points)
    grid.set_rect(fx + 2, base_y - 45, 6, 12, materials.GLASS)
    grid.set_rect(fx + 152, base_y - 45, 6, 12, materials.GLASS)

    # Metal reinforced door
    grid.set_rect(fx + 70, base_y - 25, 20, 25, materials.METAL)

    # Sand floor
    grid.set_rect(fx + 10, base_y - 5, 140, 5, materials.SAND)


def build_granular_sandbox(grid):
    """Sand and dirt physics playground - watch materials flow and crumble.

    Layout (left to right across the world):
    [Water pool + sand dam] [Sand hourglass] [SPAWN] [Dirt cliff] [Mixed tower] [Wood+sand pit]

    Player spawns in center with open air above solid ground.
    """
    W, H = config.GRID_W, config.GRID_H

    # Stone ground (solid, won't move)
    grid.set_rect(0, H - 20, W, 20, materials.STONE)

    # ============================================================
    # CENTER SPAWN AREA (W//2 region) - kept clear for player
    # Small stone platform so player has a landing pad
    # ============================================================
    spawn_x = W // 2
    grid.set_rect(spawn_x - 15, H - 21, 30, 1, materials.STONE)

    # ============================================================
    # FAR LEFT: Water pool with sand dam
    # ============================================================
    wx = W // 8
    grid.set_rect(wx - 20, H - 55, 5, 35, materials.STONE)     # left wall
    grid.set_rect(wx + 20, H - 55, 8, 35, materials.SAND)      # sand dam (breakable!)
    grid.set_rect(wx + 28, H - 55, 5, 35, materials.STONE)     # right wall
    # Fill with water
    grid.set_rect(wx - 15, H - 50, 35, 30, materials.WATER)

    # ============================================================
    # LEFT: Sand hourglass - two chambers with glass floor
    # ============================================================
    cx = W // 4 + 10
    grid.set_rect(cx - 25, H - 120, 5, 100, materials.STONE)   # left wall
    grid.set_rect(cx + 20, H - 120, 5, 100, materials.STONE)   # right wall
    grid.set_rect(cx - 25, H - 120, 50, 5, materials.STONE)    # top cap
    # Fill top half with sand
    grid.set_rect(cx - 20, H - 115, 40, 38, materials.SAND)
    # Thin glass floor (breakable!) holding sand up
    grid.set_rect(cx - 20, H - 77, 40, 3, materials.GLASS)
    # Empty chamber below for sand to fall into

    # ============================================================
    # RIGHT OF CENTER: Dirt cliff that crumbles
    # ============================================================
    dx = W // 2 + 60
    grid.set_rect(dx - 10, H - 100, 20, 80, materials.DIRT)
    # Undercut the bottom so edges are exposed and crumbling starts
    grid.set_rect(dx - 10, H - 30, 8, 10, materials.AIR)
    grid.set_rect(dx + 2, H - 30, 8, 10, materials.AIR)

    # ============================================================
    # FAR RIGHT: Mixed tower - stone base, dirt middle, sand top
    # ============================================================
    tx = W * 3 // 4 + 10
    grid.set_rect(tx - 15, H - 50, 30, 10, materials.STONE)    # stone base
    grid.set_rect(tx - 12, H - 80, 24, 30, materials.DIRT)     # dirt middle
    grid.set_rect(tx - 10, H - 105, 20, 25, materials.SAND)    # sand top
    # Glass supports on sides (break them to collapse!)
    grid.set_rect(tx - 15, H - 80, 3, 30, materials.GLASS)
    grid.set_rect(tx + 12, H - 80, 3, 30, materials.GLASS)

    # ============================================================
    # RIGHT CENTER: Wood platform over sand pit
    # ============================================================
    px = W * 5 // 8 + 20
    grid.set_rect(px - 20, H - 48, 40, 3, materials.WOOD)      # wood bridge
    grid.set_rect(px - 18, H - 45, 36, 22, materials.SAND)     # sand underneath
    # Hollow out below the sand so it has somewhere to fall
    grid.set_rect(px - 15, H - 25, 30, 5, materials.AIR)


DEMO_BUILDERS = {
    'tower': ('Tower Collapse', build_tower_collapse),
    'dome': ('Glass Dome', build_glass_dome),
    'chain': ('Chain Reaction', build_chain_reaction),
    'fortress': ('Fortress', build_fortress),
    'granular': ('Sand & Dirt Physics', build_granular_sandbox),
}
