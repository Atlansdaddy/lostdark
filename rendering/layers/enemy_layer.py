"""Enemy rendering layer: shadow creatures as dark circles with state-based coloring."""
import numpy as np
import pygame
from ... import config
from ...core.enemy import PATROL, HUNT, FLEE, DYING


class EnemyLayer:
    """Renders shadow creature enemies with state-based visual feedback."""

    def __init__(self):
        W, H = config.VIEW_W, config.VIEW_H
        self.surface = pygame.Surface((W, H), pygame.SRCALPHA)
        self._scaled = pygame.Surface((config.SCREEN_W, config.SCREEN_H), pygame.SRCALPHA)

    def render(self, screen, enemies, view_x=0, view_y=0):
        """Render all enemies."""
        if not enemies:
            return

        W, H = config.VIEW_W, config.VIEW_H
        self.surface.fill((0, 0, 0, 0))

        for enemy in enemies:
            cx = int(enemy.center_x) - view_x
            cy = int(enemy.center_y) - view_y

            # Off-screen check
            if cx < -5 or cx >= W + 5 or cy < -5 or cy >= H + 5:
                continue

            if enemy.state == DYING:
                # Shrinking circle + fade
                progress = enemy._dying_timer / enemy._dying_duration
                radius = max(1, int(2 * (1.0 - progress)))
                alpha = int(200 * (1.0 - progress))
                color = (120, 40, 180, alpha)
                if radius > 0:
                    pygame.draw.circle(self.surface, color, (cx, cy), radius)
                continue

            # Base colors by state
            if enemy.state == HUNT:
                core_color = (140, 30, 50, 220)
                glow_color = (100, 20, 30)
            elif enemy.state == FLEE:
                core_color = (80, 30, 120, 140)  # transparent
                glow_color = (60, 20, 80)
            else:  # PATROL
                core_color = (60, 20, 100, 200)
                glow_color = (40, 15, 70)

            # Draw subtle glow
            self._draw_enemy_glow(cx, cy, glow_color)

            # Draw enemy circle
            pygame.draw.circle(self.surface, core_color, (cx, cy), 2)
            # Dark edge
            pygame.draw.circle(self.surface, (20, 10, 40, 180), (cx, cy), 2, 1)

        # Scale and blit
        pygame.transform.scale(self.surface, (config.SCREEN_W, config.SCREEN_H), self._scaled)
        screen.blit(self._scaled, (0, 0))

    def _draw_enemy_glow(self, cx, cy, color):
        """Faint glow around enemy."""
        W, H = config.VIEW_W, config.VIEW_H
        radius = 5
        x0 = max(0, cx - radius)
        y0 = max(0, cy - radius)
        x1 = min(W, cx + radius + 1)
        y1 = min(H, cy + radius + 1)
        if x0 >= x1 or y0 >= y1:
            return

        xs = np.arange(x0, x1, dtype=np.float32)
        ys = np.arange(y0, y1, dtype=np.float32)
        XX, YY = np.meshgrid(xs, ys, indexing='ij')
        dist2 = (XX - cx) ** 2 + (YY - cy) ** 2
        glow = np.exp(-dist2 / (2 * (radius / 2.0) ** 2))

        rc, gc, bc = color
        for dx_idx in range(len(xs)):
            for dy_idx in range(len(ys)):
                px = int(xs[dx_idx])
                py = int(ys[dy_idx])
                if 0 <= px < W and 0 <= py < H:
                    g = glow[dx_idx, dy_idx]
                    if g > 0.08:
                        r = int(rc * g)
                        green = int(gc * g)
                        b = int(bc * g)
                        a = int(80 * g)
                        self.surface.set_at((px, py), (r, green, b, a))
