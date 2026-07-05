"""Main game scene: dark cave, player character, wave echolocation, levels."""
import numpy as np
from .. import config, materials
from ..core.voxel_grid import VoxelGrid
from ..core.player import Player
from ..core.camera import Camera
from ..core.enemy_manager import EnemyManager
from ..core.wave_physics import SONAR, FORCE
from ..systems.physics_system import PhysicsSystem
from ..rendering.renderer import Renderer
from .scene_base import Scene


class SandboxScene(Scene):
    """
    The main game scene: dark world platformer with wave echolocation.
    Supports level-based play and free exploration.
    Two wave types: SONAR (reveal) and FORCE (destroy).
    """

    def __init__(self, use_torch=None, level=None):
        self.grid = VoxelGrid()
        self.physics = PhysicsSystem(self.grid, use_torch=use_torch)
        self.renderer = Renderer(self.grid)

        # Player
        self.player = Player(config.GRID_W // 2, config.GRID_H // 2)

        # Camera
        self.camera = Camera()

        # Enemies
        self.enemy_manager = EnemyManager()

        # Level
        self.level = level
        self.level_complete = False
        self._complete_timer = 0.0
        self._level_flood_done = False

        # Death/reset
        self._death_timer = 0.0

        # Game state
        self.mode = 'WAVE'  # default to WAVE (dark world)
        self.current_material = materials.STONE
        self.block_index = 0  # index into config.BLOCK_SIZES

        # Wave type: 0=SONAR (reveal/light), 1=FORCE (destroy/push)
        self.wave_type = SONAR

        # Stats
        self.destroyed_last = []
        self._cursor_gx = 0
        self._cursor_gy = 0

    def on_enter(self):
        if self.level:
            self.level.build(self.grid)
            sx, sy = self.level.spawn_pos()
            self.player.x = float(sx)
            self.player.y = float(sy)
            # Spawn enemies from level definition
            self.enemy_manager.reset()
            for spawn in self.level.enemy_spawns():
                self.enemy_manager.spawn(*spawn)
        else:
            self._build_cave_terrain()
            self.player.find_spawn(self.grid.voxels)
        self.physics.terrain_changed()
        self.camera.snap_to(self.player)

    def update(self, dt, input_state):
        """Process input and update physics + player."""
        inp = input_state

        # Mode toggle (BUILD / WAVE)
        if inp.toggle_mode:
            self.mode = 'WAVE' if self.mode == 'BUILD' else 'BUILD'

        # Wave type toggle (Q key: sonar <-> force)
        if inp.toggle_wave_type:
            self.wave_type = FORCE if self.wave_type == SONAR else SONAR

        # Material selection
        if inp.select_material >= 0:
            self.current_material = inp.select_material

        # Block size cycling
        if inp.brush_delta != 0:
            n = len(config.BLOCK_SIZES)
            self.block_index = (self.block_index + inp.brush_delta) % n

        # Reset
        if inp.reset:
            self._do_reset()

        # --- Death handling ---
        if not self.player.alive:
            self._death_timer += dt
            if self._death_timer > 1.0:
                self._do_reset()
            # Still update camera/render but skip player input
            self.renderer.shake.update(dt)
            self.camera.update(dt, self.player)
            self.physics.update(dt)
            return

        # --- Player movement ---
        self.player.update(dt, self.grid.voxels,
                           inp.move_left, inp.move_right, inp.jump, inp.dash)

        # Reset near_beacon each frame
        self.player.near_beacon = False

        # Player ambient echolocation pulse — ALWAYS sonar (this is how you see)
        if self.player.should_pulse():
            self.physics.add_sonar_pulse(
                self.player.center_x, self.player.center_y,
                amplitude=Player.PULSE_INTENSITY,
                radius=8,
            )
            # Also add the illumination ring (visual pulse ring)
            self.physics.illumination.add_pulse_ring(
                self.player.center_x, self.player.center_y,
                max_radius=Player.PULSE_RADIUS,
                speed=100.0,
                intensity=Player.PULSE_INTENSITY,
            )

        # Player constant glow (always slightly visible)
        self.physics.illumination.add_glow(
            self.player.center_x, self.player.center_y,
            radius=12, intensity=0.35,
        )

        # --- Mouse actions (convert screen to world coords using camera) ---
        gx, gy = self.camera.screen_to_grid(inp.screen_x, inp.screen_y)
        self._cursor_gx = gx
        self._cursor_gy = gy
        terrain_changed = False

        bw, bh, _ = config.BLOCK_SIZES[self.block_index]

        if inp.lmb:
            if self.mode == 'BUILD':
                self.grid.set_rect(gx - bw // 2, gy - bh // 2, bw, bh, self.current_material)
                terrain_changed = True
            elif self.mode == 'WAVE':
                if self.wave_type == SONAR:
                    # Sonar scan: reveals area with expanding light ring
                    self.physics.add_sonar_pulse(gx, gy, amplitude=1.8, radius=6)
                    self.physics.illumination.add_pulse_ring(
                        gx, gy, max_radius=50, speed=120.0, intensity=2.0,
                    )
                else:
                    # Force blast at cursor: destructive wave (controlled)
                    blast_r = max(bw, bh) // 2 + 2
                    self.physics.add_force_pulse(gx, gy, amplitude=1.2, radius=blast_r)
                    self.renderer.shake.add_trauma(0.1)

        if inp.rmb:
            self.grid.set_rect(gx - bw // 2, gy - bh // 2, bw, bh, materials.AIR)
            terrain_changed = True

        if inp.mmb:
            # Middle click: always a big force blast (destruction shortcut)
            blast_r = max(bw, bh) // 2 + 2
            self.physics.add_force_pulse(gx, gy, amplitude=1.8, radius=blast_r)
            self.grid.destroy_circle(gx, gy, blast_r)
            terrain_changed = True
            self.renderer.shake.add_trauma(0.25)

        if inp.space:
            if self.wave_type == SONAR:
                # Continuous sonar flashlight at cursor
                self.physics.illumination.add_flash(
                    gx, gy, radius=25, intensity=0.8,
                )
            else:
                # Continuous force stream at cursor (sustained push)
                self.physics.add_force_pulse(gx, gy, amplitude=0.4, radius=2)

        if terrain_changed:
            self.physics.terrain_changed()

        # Physics tick
        self.destroyed_last = self.physics.update(dt)
        if self.destroyed_last:
            self.renderer.shake.add_trauma(min(0.3, len(self.destroyed_last) * 0.01))

        # Enemy updates
        if self.level:
            self.enemy_manager.update(
                dt, self.physics.illumination.light,
                self.player, self.grid.voxels,
            )

        # Screen shake
        self.renderer.shake.update(dt)

        # Camera follow
        self.camera.update(dt, self.player)

        # Level completion check
        if self.level and not self.level_complete:
            if self.level.check_complete(self.player, self.grid):
                self.level_complete = True
                self._complete_timer = 0.0
                self._level_flood_done = False
        if self.level_complete:
            self._complete_timer += dt
            # Flood light on first frame of completion
            if not self._level_flood_done:
                self._level_flood_done = True
                self.physics.illumination.flood_light(2.5)
                self.physics.illumination.add_pulse_ring(
                    self.player.center_x, self.player.center_y,
                    max_radius=200, speed=150.0, intensity=2.0,
                )

    def render(self, screen):
        """Render all layers with illumination and dual wave fields."""
        self.renderer.render(
            screen,
            wave_u=self.physics.wave.u,
            sonar_u=self.physics.wave.sonar_u,
            force_u=self.physics.wave.force_u,
            particles=self.physics.particles,
            illumination=self.physics.illumination.light,
            player=self.player,
            cursor_gx=self._cursor_gx,
            cursor_gy=self._cursor_gy,
            camera=self.camera,
            enemies=self.enemy_manager.enemies,
            active_wave_type=self.wave_type,
        )

    def _do_reset(self):
        """Reset level, player, and enemies."""
        self.grid.clear()
        self.physics.reset()
        self.level_complete = False
        self._complete_timer = 0.0
        self._level_flood_done = False
        self._death_timer = 0.0
        self.player.health = self.player.max_health
        self.player.alive = True
        self.player.invincible_timer = 0.0
        self.enemy_manager.reset()
        if self.level:
            self.level.build(self.grid)
            sx, sy = self.level.spawn_pos()
            self.player.x = float(sx)
            self.player.y = float(sy)
            if hasattr(self.level, '_beacons_reached'):
                self.level._beacons_reached = set()
            for spawn in self.level.enemy_spawns():
                self.enemy_manager.spawn(*spawn)
        else:
            self._build_cave_terrain()
            self.player.find_spawn(self.grid.voxels)
        self.physics.terrain_changed()
        self.camera.snap_to(self.player)

    def _build_cave_terrain(self):
        """Create enclosed cave world. Dark world needs walls."""
        W, H = config.GRID_W, config.GRID_H
        grid = self.grid

        wall = 10  # wall thickness

        # --- Outer walls (stone enclosure) ---
        grid.set_rect(0, 0, W, wall, materials.STONE)            # ceiling
        grid.set_rect(0, H - wall, W, wall, materials.STONE)     # floor
        grid.set_rect(0, 0, wall, H, materials.STONE)            # left wall
        grid.set_rect(W - wall, 0, wall, H, materials.STONE)     # right wall

        # --- Stone floor layer (above bottom wall) ---
        grid.set_rect(wall, H - wall - 15, W - 2 * wall, 15, materials.DIRT)
        grid.set_rect(wall, H - wall - 5, W - 2 * wall, 5, materials.STONE)

        # --- Stone cavern (left third) ---
        lx = wall
        # Stalactites from ceiling
        for i in range(6):
            sx = lx + 15 + i * 25
            sh = 20 + (i * 7) % 30
            sw = 4 + (i * 3) % 5
            if sx + sw < W // 3:
                grid.set_rect(sx, wall, sw, sh, materials.STONE)

        # Stalagmites from floor
        for i in range(5):
            sx = lx + 25 + i * 30
            sh = 15 + (i * 11) % 25
            sw = 5 + (i * 2) % 4
            if sx + sw < W // 3:
                grid.set_rect(sx, H - wall - 15 - sh, sw, sh, materials.STONE)

        # --- Metal bunker (center) ---
        bx = W // 3 + 10
        by = H - wall - 15 - 60

        # Outer metal walls
        grid.set_rect(bx, by, 80, 60, materials.METAL)
        # Hollow interior (two floors)
        grid.set_rect(bx + 4, by + 4, 72, 24, materials.AIR)     # top floor
        grid.set_rect(bx + 4, by + 32, 72, 24, materials.AIR)    # bottom floor
        # Metal floor between levels
        grid.set_rect(bx + 4, by + 28, 72, 4, materials.METAL)
        # Glass windows
        grid.set_rect(bx + 15, by + 8, 12, 8, materials.GLASS)
        grid.set_rect(bx + 53, by + 8, 12, 8, materials.GLASS)
        grid.set_rect(bx + 15, by + 36, 12, 8, materials.GLASS)
        grid.set_rect(bx + 53, by + 36, 12, 8, materials.GLASS)
        # Glass floor section (fragile!)
        grid.set_rect(bx + 30, by + 28, 20, 4, materials.GLASS)
        # Door opening
        grid.set_rect(bx + 35, by + 44, 10, 16, materials.AIR)

        # --- Wood platforms (center-right) ---
        px = W // 2 + 50
        # Staggered bridges
        grid.set_rect(px, H - wall - 50, 50, 3, materials.WOOD)
        grid.set_rect(px + 30, H - wall - 80, 50, 3, materials.WOOD)
        grid.set_rect(px - 10, H - wall - 110, 45, 3, materials.WOOD)
        # Support pillars
        grid.set_rect(px + 10, H - wall - 50, 3, 35, materials.WOOD)
        grid.set_rect(px + 55, H - wall - 80, 3, 65, materials.WOOD)

        # --- Glass crystal formation (right third) ---
        cx = W - wall - 80
        cy = H // 2
        # Radial crystals pointing outward
        import math
        for angle_deg in range(0, 360, 30):
            angle = math.radians(angle_deg)
            length = 15 + (angle_deg * 7) % 12
            for r in range(length):
                gx = int(cx + r * math.cos(angle))
                gy = int(cy + r * math.sin(angle))
                if wall < gx < W - wall and wall < gy < H - wall:
                    grid.set_rect(max(wall, gx - 1), max(wall, gy - 1), 3, 3, materials.GLASS)

        # --- Hidden chamber (bottom-right) ---
        hx = W - wall - 70
        hy = H - wall - 15 - 35
        grid.set_rect(hx, hy, 60, 35, materials.STONE)
        grid.set_rect(hx + 4, hy + 4, 52, 27, materials.AIR)    # hollow
        # Small treasure inside
        grid.set_rect(hx + 20, hy + 20, 12, 7, materials.METAL)

        # --- Sand deposits ---
        grid.set_rect(wall + 40, H - wall - 18, 60, 3, materials.SAND)
        grid.set_rect(W // 2 - 20, H - wall - 17, 40, 2, materials.SAND)
        grid.set_rect(W - wall - 100, H - wall - 16, 30, 1, materials.SAND)

        self.physics.terrain_changed()
