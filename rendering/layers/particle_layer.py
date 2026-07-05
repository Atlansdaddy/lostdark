"""Particle rendering layer: renders all particles into RGBA buffer, blit once."""
import numpy as np
import pygame
from ... import config
from ...core.particles import P_SPARK


class ParticleLayer:
    """
    Renders particles into a pre-allocated RGBA numpy buffer.
    One blit per frame - no per-particle pygame.draw calls.
    Sparks render as 2-3px directional streaks.
    """

    def __init__(self):
        W, H = config.VIEW_W, config.VIEW_H
        self.surface = pygame.Surface((W, H), pygame.SRCALPHA)
        # Pre-allocated RGBA buffer
        self._rgba = np.zeros((W, H, 4), dtype=np.uint8)

    def render(self, screen, particles, view_x=0, view_y=0):
        """
        Render all alive particles to screen.
        particles: ParticleStorage instance.
        view_x, view_y: camera offset for world-to-view transformation.
        """
        if not np.any(particles.alive):
            return

        rgba = self._rgba
        rgba[:] = 0  # clear

        alive = particles.alive
        idx = np.where(alive)[0]
        if len(idx) == 0:
            return

        # Get alive particle data, offset by camera view
        px = (particles.x[idx] - view_x).astype(np.int32)
        py = (particles.y[idx] - view_y).astype(np.int32)
        pr = particles.r[idx]
        pg = particles.g[idx]
        pb = particles.b[idx]
        pa = particles.alpha[idx]
        ps = particles.size[idx]
        pt = particles.ptype[idx]
        pvx = particles.vx[idx]
        pvy = particles.vy[idx]

        W, H = config.VIEW_W, config.VIEW_H

        # Render each particle type
        for i in range(len(idx)):
            x, y = int(px[i]), int(py[i])
            if x < 0 or x >= W or y < 0 or y >= H:
                continue

            r, g, b, a = int(pr[i]), int(pg[i]), int(pb[i]), int(pa[i])
            sz = max(1, int(ps[i]))

            if pt[i] == P_SPARK:
                # Directional streak: draw 2-3 pixels along velocity
                vx_n = pvx[i]
                vy_n = pvy[i]
                speed = max(0.01, (vx_n**2 + vy_n**2)**0.5)
                dx = vx_n / speed
                dy = vy_n / speed
                for step in range(3):
                    sx = int(x - dx * step)
                    sy = int(y - dy * step)
                    if 0 <= sx < W and 0 <= sy < H:
                        fade = 1.0 - step * 0.3
                        rgba[sx, sy] = [r, g, b, int(a * fade)]
            else:
                # Solid rectangle (1x1, 2x2, etc.)
                x0 = max(0, x)
                y0 = max(0, y)
                x1 = min(W, x + sz)
                y1 = min(H, y + sz)
                if x0 < x1 and y0 < y1:
                    rgba[x0:x1, y0:y1] = [r, g, b, a]

        # Write to surface and blit
        pxa = pygame.surfarray.pixels3d(self.surface)
        pxa[:] = rgba[:, :, :3]
        del pxa
        pxa = pygame.surfarray.pixels_alpha(self.surface)
        pxa[:] = rgba[:, :, 3]
        del pxa

        scaled = pygame.transform.scale(self.surface, (config.SCREEN_W, config.SCREEN_H))
        screen.blit(scaled, (0, 0))
