"""Terrain layer: renders visible portion of terrain with camera offset."""
import numpy as np
import pygame
from ... import config, materials
from ..voxel_painter import VoxelPainter


class TerrainLayer:
    """
    Renders the voxel terrain to a surface.
    - Only renders the visible portion based on camera view offset.
    - Air cells are transparent so background shows through.
    - In dark world mode, terrain is multiplied by illumination field.
    """

    def __init__(self, grid):
        self.grid = grid
        self.painter = VoxelPainter()
        # View-sized RGBA surface (air = transparent)
        self.surface = pygame.Surface((config.VIEW_W, config.VIEW_H), pygame.SRCALPHA)
        # Pre-allocated scaled RGBA surface (screen resolution)
        self.scaled = pygame.Surface((config.SCREEN_W, config.SCREEN_H), pygame.SRCALPHA)

    def render(self, screen, illumination=None, view_x=0, view_y=0):
        """Render visible terrain to screen."""
        self._repaint(illumination, view_x, view_y)
        pygame.transform.scale(self.surface, (config.SCREEN_W, config.SCREEN_H), self.scaled)
        screen.blit(self.scaled, (0, 0))

    def _repaint(self, illumination=None, view_x=0, view_y=0):
        """Repaint visible portion of terrain via VoxelPainter."""
        # Extract visible portion of voxels and illumination
        x1 = max(0, view_x)
        y1 = max(0, view_y)
        x2 = min(config.GRID_W, view_x + config.VIEW_W)
        y2 = min(config.GRID_H, view_y + config.VIEW_H)

        voxels_view = self.grid.voxels[x1:x2, y1:y2]
        illum_view = None
        if illumination is not None:
            illum_view = illumination[x1:x2, y1:y2]

        rgb = self.painter.paint(voxels_view, illumination=illum_view)

        # Write RGB
        pxa = pygame.surfarray.pixels3d(self.surface)
        pxa[:] = 0
        dw = x2 - x1
        dh = y2 - y1
        pxa[:dw, :dh] = rgb
        del pxa

        # Write alpha: air AND water = transparent (water rendered by WaterLayer)
        pxa_a = pygame.surfarray.pixels_alpha(self.surface)
        pxa_a[:] = 0  # default transparent
        is_visible = (voxels_view != materials.AIR) & (voxels_view != materials.WATER)
        alpha_view = np.where(is_visible, 255, 0).astype(np.uint8)
        pxa_a[:dw, :dh] = alpha_view
        del pxa_a
