"""Background layer: bold Geometry Dash style gradient + geometric shapes + vignette."""
import numpy as np
import pygame
from ... import config


class BackgroundLayer:
    """
    Geometry Dash style background:
    - Rich blue-purple gradient
    - Large bold geometric shapes (rectangles, diamonds) at high visibility
    - Parallax scrolling
    - Ground detail strip
    - Vignette shadow at edges
    """

    def __init__(self):
        self._gradient = self._create_gradient()
        self._layers = self._create_layers()
        self._ground_strip = self._create_ground_strip()
        self._vignette = self._create_vignette()

    def _create_gradient(self):
        """Rich vertical gradient - deep purple-blue to mid-blue."""
        surf = pygame.Surface((config.SCREEN_W, config.SCREEN_H))
        pxa = pygame.surfarray.pixels3d(surf)
        top = np.array([8, 4, 32], dtype=np.float32)       # deep purple-blue
        mid = np.array([12, 18, 60], dtype=np.float32)      # dark blue
        bot = np.array([18, 30, 75], dtype=np.float32)      # medium blue
        for y in range(config.SCREEN_H):
            t = y / config.SCREEN_H
            if t < 0.5:
                # Top half: purple-blue to dark blue
                s = t * 2.0
                s = s * s  # ease-in
                pxa[:, y, :] = (top * (1 - s) + mid * s).astype(np.uint8)
            else:
                # Bottom half: dark blue to medium blue
                s = (t - 0.5) * 2.0
                pxa[:, y, :] = (mid * (1 - s) + bot * s).astype(np.uint8)
        del pxa
        return surf

    def _create_layers(self):
        """Pre-render parallax layers with bold, visible geometric shapes."""
        np.random.seed(12345)
        layers = []

        sw, sh = config.SCREEN_W, config.SCREEN_H

        layer_defs = [
            # (parallax, rect_count, diamond_count, color, alpha, size_range)
            (0.05, 8, 4, (25, 40, 90), 90, (120, 300)),     # far: huge shapes
            (0.15, 10, 5, (30, 55, 110), 75, (60, 160)),    # mid: medium shapes
            (0.30, 8, 3, (40, 70, 130), 60, (30, 90)),      # near: smaller, brighter
        ]

        tile_w = sw * 3
        tile_h = sh * 2

        for parallax, rcount, dcount, color, alpha, size_range in layer_defs:
            surf = pygame.Surface((tile_w, tile_h), pygame.SRCALPHA)

            # Rectangles
            for _ in range(rcount):
                x = np.random.randint(0, tile_w)
                y = np.random.randint(0, tile_h)
                w = np.random.randint(*size_range)
                h = np.random.randint(size_range[0] // 2, size_range[1])
                # Fill
                pygame.draw.rect(surf, (*color, alpha), (x, y, w, h))
                # Bright top/left edges (3D look)
                ec = (min(255, color[0] + 30), min(255, color[1] + 40),
                      min(255, color[2] + 50), alpha + 20)
                pygame.draw.line(surf, ec, (x, y), (x + w, y), 2)
                pygame.draw.line(surf, ec, (x, y), (x, y + h), 2)
                # Dark bottom/right edges
                dc = (max(0, color[0] - 10), max(0, color[1] - 10),
                      max(0, color[2] - 10), alpha)
                pygame.draw.line(surf, dc, (x + w, y), (x + w, y + h), 2)
                pygame.draw.line(surf, dc, (x, y + h), (x + w, y + h), 2)

            # Diamonds (rotated squares)
            for _ in range(dcount):
                cx = np.random.randint(0, tile_w)
                cy = np.random.randint(0, tile_h)
                size = np.random.randint(size_range[0] // 2, size_range[1] // 2)
                points = [
                    (cx, cy - size),         # top
                    (cx + size, cy),         # right
                    (cx, cy + size),         # bottom
                    (cx - size, cy),         # left
                ]
                pygame.draw.polygon(surf, (*color, alpha), points)
                # Bright top edges
                ec = (min(255, color[0] + 25), min(255, color[1] + 35),
                      min(255, color[2] + 45), alpha + 15)
                pygame.draw.line(surf, ec, points[3], points[0], 2)
                pygame.draw.line(surf, ec, points[0], points[1], 2)

            layers.append((parallax, surf))

        return layers

    def _create_ground_strip(self):
        """Dark ground detail strip along the bottom (like GD ground texture)."""
        sw, sh = config.SCREEN_W, config.SCREEN_H
        strip_h = sh // 6
        surf = pygame.Surface((sw, strip_h), pygame.SRCALPHA)

        # Base dark fill
        surf.fill((5, 8, 25, 100))

        # Grid lines (GD style ground pattern)
        grid_size = 40
        line_color = (20, 30, 60, 80)
        for x in range(0, sw, grid_size):
            pygame.draw.line(surf, line_color, (x, 0), (x, strip_h), 1)
        for y in range(0, strip_h, grid_size):
            pygame.draw.line(surf, line_color, (0, y), (sw, y), 1)

        # Bright top edge (horizon line)
        pygame.draw.line(surf, (40, 70, 140, 150), (0, 0), (sw, 0), 2)
        pygame.draw.line(surf, (30, 50, 100, 100), (0, 2), (sw, 2), 1)

        return surf

    def _create_vignette(self):
        """Strong dark vignette at screen edges."""
        sw, sh = config.SCREEN_W, config.SCREEN_H
        surf = pygame.Surface((sw, sh), pygame.SRCALPHA)

        # Use radial distance from center for smooth vignette
        cx, cy = sw // 2, sh // 2
        max_r = (cx ** 2 + cy ** 2) ** 0.5

        # Build vignette as concentric bands
        steps = 30
        for i in range(steps):
            t = i / steps  # 0=center, 1=edge
            # Quadratic alpha: gentle center, strong edges
            alpha = int(t * t * 120)
            margin_x = int(cx * (1 - t))
            margin_y = int(cy * (1 - t))
            w = sw - 2 * margin_x
            h = sh - 2 * margin_y
            if w <= 0 or h <= 0:
                continue
            if i == 0:
                surf.fill((0, 0, 5, alpha))
            else:
                band = pygame.Surface((w, h), pygame.SRCALPHA)
                band.fill((0, 0, 5, alpha))
                prev_t = (i - 1) / steps
                inner_mx = int(cx * (1 - prev_t)) - margin_x
                inner_my = int(cy * (1 - prev_t)) - margin_y
                inner_w = sw - 2 * int(cx * (1 - prev_t))
                inner_h = sh - 2 * int(cy * (1 - prev_t))
                if inner_w > 0 and inner_h > 0:
                    band.fill((0, 0, 0, 0), (inner_mx, inner_my, inner_w, inner_h))
                surf.blit(band, (margin_x, margin_y))

        return surf

    def render(self, screen, view_x=0, view_y=0):
        """Render background with parallax + ground strip + vignette."""
        # Base gradient
        screen.blit(self._gradient, (0, 0))

        # Parallax geometric layers
        for parallax, surf in self._layers:
            ox = int(-view_x * parallax * config.PIXEL_SCALE) % surf.get_width()
            oy = int(-view_y * parallax * config.PIXEL_SCALE) % surf.get_height()
            screen.blit(surf, (-ox, -oy))

        # Ground detail strip (bottom of screen)
        ground_y = config.SCREEN_H - self._ground_strip.get_height()
        screen.blit(self._ground_strip, (0, ground_y))

        # Vignette overlay
        screen.blit(self._vignette, (0, 0))
