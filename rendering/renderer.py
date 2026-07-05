"""Layered compositing renderer - orchestrates all render layers."""
import pygame
from .. import config
from .layers.terrain_layer import TerrainLayer
from .layers.wave_layer import WaveLayer
from .layers.particle_layer import ParticleLayer
from .layers.player_layer import PlayerLayer
from .layers.enemy_layer import EnemyLayer
from .layers.background_layer import BackgroundLayer
from .layers.water_layer import WaterLayer
from .effects import Bloom, ScreenShake


class Renderer:
    """
    Composites all rendering layers in order:
    0. Background (gradient + geometric shapes)
    1. Terrain (with illumination for dark world, water transparent)
    1.5. Water (fluid rendering with depth, caustics, shimmer)
    2. Wave overlay (bright wavefronts + cursor glow)
    3. Player (sprite + glow halo)
    3.5. Enemies (shadow creatures)
    4. Particles (RGBA blend)
    5. Bloom (post-process)
    """

    def __init__(self, grid):
        self.grid = grid
        self.background = BackgroundLayer()
        self.terrain = TerrainLayer(grid)
        self.wave = WaveLayer()
        self.particle = ParticleLayer()
        self.player_layer = PlayerLayer()
        self.enemy_layer = EnemyLayer()
        self.water_layer = WaterLayer()
        self.bloom = Bloom()
        self.shake = ScreenShake()

    def render(self, screen, wave_u=None, particles=None, illumination=None,
               player=None, cursor_gx=0, cursor_gy=0, camera=None,
               enemies=None, sonar_u=None, force_u=None,
               active_wave_type=0):
        """
        Render all layers to screen.
        wave_u: combined (W, H) float32 wave displacement field.
        sonar_u/force_u: separate sonar and force fields for dual-color rendering.
        active_wave_type: 0=sonar, 1=force (cursor glow color).
        particles: optional ParticleStorage instance.
        illumination: optional (W, H) float32 light field.
        player: optional Player instance.
        cursor_gx, cursor_gy: grid cursor position for glow.
        camera: optional Camera for viewport offset.
        enemies: optional list of ShadowCreature instances.
        """
        # Get camera view offset
        vx = camera.view_x if camera else 0
        vy = camera.view_y if camera else 0

        # Layer 0: Background (gradient + shapes, parallax)
        self.background.render(screen, vx, vy)

        # Layer 1: Terrain (with illumination multiply, water transparent)
        self.terrain.render(screen, illumination=illumination, view_x=vx, view_y=vy)

        # Layer 1.5: Water (fluid rendering with depth, caustics, shimmer)
        self.water_layer.render(screen, self.grid.voxels, wave_u=wave_u,
                                illumination=illumination, view_x=vx, view_y=vy)

        # Layer 2: Wave overlay + cursor glow (dual-colored)
        if wave_u is not None:
            self.wave.render(screen, wave_u, self.grid.voxels,
                             cursor_gx=cursor_gx, cursor_gy=cursor_gy,
                             view_x=vx, view_y=vy,
                             sonar_u=sonar_u, force_u=force_u,
                             active_wave_type=active_wave_type)

        # Layer 3: Player
        if player is not None:
            self.player_layer.render(screen, player, view_x=vx, view_y=vy)

        # Layer 3.5: Enemies
        if enemies:
            self.enemy_layer.render(screen, enemies, view_x=vx, view_y=vy)

        # Layer 4: Particles
        if particles is not None:
            self.particle.render(screen, particles, view_x=vx, view_y=vy)

        # Layer 5: Bloom
        self.bloom.apply(screen)

        # Screen shake offset
        if self.shake.active:
            ox = int(self.shake.offset_x)
            oy = int(self.shake.offset_y)
            if ox != 0 or oy != 0:
                tmp = screen.copy()
                screen.fill(config.BG_COLOR)
                screen.blit(tmp, (ox, oy))
