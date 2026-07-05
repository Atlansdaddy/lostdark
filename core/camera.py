"""Camera system: follows player, provides view offset for large worlds."""
import numpy as np
from .. import config


class Camera:
    """
    Tracks player position and provides viewport offset.
    Allows world to be larger than the screen - only renders visible portion.
    Smooth following with slight lag for game feel.
    """

    # Smoothing
    FOLLOW_SPEED = 8.0  # higher = snappier following

    def __init__(self):
        # Camera position (top-left corner of view, in grid coordinates)
        self.x = 0.0
        self.y = 0.0
        # Target position (where camera wants to be)
        self._target_x = 0.0
        self._target_y = 0.0

    def update(self, dt, player):
        """Update camera to follow player."""
        if player is None:
            return
        vw, vh = config.VIEW_W, config.VIEW_H

        # Target: center player in view
        self._target_x = player.center_x - vw / 2
        self._target_y = player.center_y - vh / 2

        # Clamp target to world bounds
        self._target_x = max(0, min(config.GRID_W - vw, self._target_x))
        self._target_y = max(0, min(config.GRID_H - vh, self._target_y))

        # Smooth follow
        lerp = min(1.0, self.FOLLOW_SPEED * dt)
        self.x += (self._target_x - self.x) * lerp
        self.y += (self._target_y - self.y) * lerp

        # Final clamp
        self.x = max(0, min(config.GRID_W - vw, self.x))
        self.y = max(0, min(config.GRID_H - vh, self.y))

    def snap_to(self, player):
        """Instantly center on player (no smoothing)."""
        if player is None:
            return
        vw, vh = config.VIEW_W, config.VIEW_H
        self.x = player.center_x - vw / 2
        self.y = player.center_y - vh / 2
        self.x = max(0, min(config.GRID_W - vw, self.x))
        self.y = max(0, min(config.GRID_H - vh, self.y))
        self._target_x = self.x
        self._target_y = self.y

    @property
    def view_x(self):
        """Integer x offset for rendering."""
        return int(self.x)

    @property
    def view_y(self):
        """Integer y offset for rendering."""
        return int(self.y)

    def grid_to_screen(self, gx, gy):
        """Convert grid coordinates to screen coordinates."""
        sx = (gx - self.view_x) * config.PIXEL_SCALE
        sy = (gy - self.view_y) * config.PIXEL_SCALE
        return sx, sy

    def screen_to_grid(self, sx, sy):
        """Convert screen coordinates to grid coordinates."""
        gx = sx // config.PIXEL_SCALE + self.view_x
        gy = sy // config.PIXEL_SCALE + self.view_y
        return gx, gy

    def is_visible(self, gx, gy):
        """Check if a grid cell is within the camera view."""
        return (self.view_x <= gx < self.view_x + config.VIEW_W and
                self.view_y <= gy < self.view_y + config.VIEW_H)
