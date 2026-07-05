"""
Player rendering layer: dark energy orb with responsive halo.
Rendered at SCREEN RESOLUTION for clean, smooth circles.
Everything else is voxels but the player is crisp like Geometry Dash.

Visual layers (back to front):
1. Outer soft glow (large, faint)
2. Halo rings (concentric, animated)
3. Dark orb core (anti-aliased circle with shading)
4. Edge glow rim (bright ring at orb edge)
5. Specular highlight (top-left light catch)
6. Speed trail / dash streak
7. Wall slide sparks
8. Energy arc indicator
"""
import math
import numpy as np
import pygame
from ... import config


class PlayerLayer:
    """
    Renders player orb at SCREEN resolution — smooth, clean lines.
    No blocky upscaling. Direct screen-space rendering.
    """

    # Screen-space sizes (pixels at native resolution)
    ORB_RADIUS = 14           # core dark sphere (screen pixels)
    HALO_INNER = 22           # inner bright halo ring
    HALO_OUTER = 60           # outer soft glow reach
    SPEC_OFFSET = (-4, -4)    # specular highlight offset

    def __init__(self):
        # Render directly at screen resolution
        self.surface = pygame.Surface(
            (config.SCREEN_W, config.SCREEN_H), pygame.SRCALPHA
        )
        self._time = 0.0

    def render(self, screen, player, view_x=0, view_y=0):
        """Render the orb + halo at screen resolution."""
        if not player.alive:
            return

        self._time += 1.0 / 60.0

        # Invincibility blink
        if player.invincible_timer > 0:
            if int(player.invincible_timer * 12) % 3 == 0:
                return

        PS = config.PIXEL_SCALE
        SW, SH = config.SCREEN_W, config.SCREEN_H

        # Player center in SCREEN coordinates (smooth, sub-pixel)
        cx = (player.x + player.WIDTH / 2 - view_x) * PS
        cy = (player.y + player.HEIGHT / 2 - view_y + player.idle_bob_offset) * PS

        # Skip if off screen
        margin = self.HALO_OUTER + 20
        if cx < -margin or cx > SW + margin or cy < -margin or cy > SH + margin:
            return

        icx, icy = int(cx), int(cy)

        self.surface.fill((0, 0, 0, 0))

        # Player state
        halo_color = player.halo_color
        halo_mult = player.halo_radius_multiplier
        halo_bright = player.halo_brightness
        squash = player.squash_stretch
        energy_frac = player.energy_fraction
        speed = player._speed_factor
        is_dashing = player._dashing
        is_wall_sliding = player.wall_sliding

        # ============================================================
        # Layer 1: Outer glow (soft Gaussian, large radius)
        # ============================================================
        outer_r = int(self.HALO_OUTER * halo_mult)
        glow_intensity = 0.3 * halo_bright * (0.5 + energy_frac * 0.5)
        if is_dashing:
            glow_intensity *= 1.5  # brighter during dash

        self._draw_glow_fast(icx, icy, outer_r, halo_color,
                             glow_intensity, max_alpha=70, SW=SW, SH=SH)

        # ============================================================
        # Layer 2: Halo rings (clean anti-aliased circles)
        # ============================================================
        inner_r = int(self.HALO_INNER * halo_mult)

        # Outer halo ring
        ring_a = int(min(255, 100 * halo_bright * (0.6 + energy_frac * 0.4)))
        pygame.draw.circle(self.surface, (*halo_color, ring_a),
                           (icx, icy), inner_r, 2)

        # Inner halo ring (brighter)
        inner_a = int(min(255, 160 * halo_bright))
        bright_halo = tuple(min(255, c + 50) for c in halo_color)
        pygame.draw.circle(self.surface, (*bright_halo, inner_a),
                           (icx, icy), inner_r - 3, 2)

        # Breathing pulse ring
        pulse_phase = math.sin(self._time * 3.0)
        pulse_r = inner_r + int(pulse_phase * 6)
        pulse_a = int(max(0, 30 + 25 * pulse_phase))
        if pulse_r > 0:
            pygame.draw.circle(self.surface, (*halo_color, pulse_a),
                               (icx, icy), pulse_r, 1)

        # ============================================================
        # Layer 3: Dark orb core (smooth, with shading)
        # ============================================================
        orb_r = self.ORB_RADIUS

        # Apply squash/stretch
        rx = max(4, int(orb_r / max(0.5, squash)))
        ry = max(4, int(orb_r * squash))

        # Orb body — dark with gradient feel
        # Draw filled ellipse for core
        orb_rect = pygame.Rect(icx - rx, icy - ry, rx * 2, ry * 2)
        pygame.draw.ellipse(self.surface, (8, 8, 18, 255), orb_rect)

        # Inner shade — slightly lighter center for sphere illusion
        shade_rx = max(2, rx - 3)
        shade_ry = max(2, ry - 3)
        shade_rect = pygame.Rect(icx - shade_rx + 1, icy - shade_ry + 1,
                                 shade_rx * 2, shade_ry * 2)
        pygame.draw.ellipse(self.surface, (14, 14, 28, 255), shade_rect)

        # ============================================================
        # Layer 4: Edge glow rim (bright colored ring at orb boundary)
        # ============================================================
        edge_a = int(min(255, 200 * halo_bright))
        edge_color = tuple(min(255, c + 80) for c in halo_color)
        pygame.draw.ellipse(self.surface, (*edge_color, edge_a),
                            orb_rect, 2)

        # ============================================================
        # Layer 5: Specular highlight (crisp light catch)
        # ============================================================
        spec_x = icx + self.SPEC_OFFSET[0]
        spec_y = icy + self.SPEC_OFFSET[1]
        spec_r = max(2, min(rx, ry) // 3)

        # Soft specular
        pygame.draw.circle(self.surface, (40, 50, 70, 200),
                           (int(spec_x), int(spec_y)), spec_r + 2)
        # Bright specular dot
        pygame.draw.circle(self.surface, (80, 100, 140, 220),
                           (int(spec_x), int(spec_y)), spec_r)
        # Sharp white highlight point
        pygame.draw.circle(self.surface, (160, 180, 220, 200),
                           (int(spec_x) - 1, int(spec_y) - 1), max(1, spec_r // 2))

        # ============================================================
        # Layer 6: Speed trail / dash streak
        # ============================================================
        if is_dashing:
            # Dash streak: bright horizontal line with fading trail
            dash_dir = 1 if player.facing_right else -1
            trail_len = 8
            for i in range(1, trail_len + 1):
                fade = 1.0 - i / trail_len
                tx = icx - dash_dir * i * 10
                ta = int(150 * fade)
                tr = max(2, int(orb_r * fade * 0.8))
                pygame.draw.circle(self.surface, (*halo_color, ta),
                                   (int(tx), icy), tr)
        elif speed > 0.25:
            # Motion trail
            trail_len = max(2, int(speed * 6))
            trail_dir_x = -1 if player.facing_right else 1
            trail_dir_y = 0
            if abs(player.vy) > 30:
                trail_dir_y = 1 if player.vy < 0 else -1
                trail_dir_x = int(trail_dir_x * 0.3)

            for i in range(1, trail_len + 1):
                fade = 1.0 - i / (trail_len + 1)
                tx = icx + trail_dir_x * i * 8
                ty = icy + trail_dir_y * i * 8
                ta = int(80 * fade * speed)
                tr = max(2, int(6 * fade))
                if 0 <= tx < SW and 0 <= ty < SH:
                    pygame.draw.circle(self.surface, (*halo_color, ta),
                                       (int(tx), int(ty)), tr)

        # ============================================================
        # Layer 7: Wall slide sparks
        # ============================================================
        if is_wall_sliding:
            wall_x = icx - rx - 4 if player._wall_side < 0 else icx + rx + 4
            # Animated sparks sliding down
            for i in range(5):
                spark_y = icy - 10 + i * 8 + int(self._time * 80) % 12
                spark_phase = math.sin(i * 2.5 + self._time * 12.0)
                if spark_phase > 0:
                    sa = int(120 * spark_phase)
                    pygame.draw.circle(
                        self.surface, (255, 200, 80, sa),
                        (int(wall_x + spark_phase * 3), int(spark_y)), 2
                    )

        # ============================================================
        # Layer 8: Energy arc indicator (below orb)
        # ============================================================
        if energy_frac < 0.99:
            arc_r = inner_r + 6
            arc_extent = energy_frac * math.pi
            if arc_extent > 0.1:
                # Color: green→yellow→red based on energy
                if energy_frac > 0.6:
                    arc_color = (40, 220, 120)
                elif energy_frac > 0.3:
                    arc_color = (220, 220, 50)
                else:
                    arc_color = (220, 60, 40)

                num_dots = max(5, int(arc_extent * 6))
                for i in range(num_dots):
                    t = i / max(1, num_dots - 1)
                    angle = math.pi * 0.5 - arc_extent / 2 + arc_extent * t
                    dx = math.cos(angle) * arc_r
                    dy = math.sin(angle) * arc_r
                    px = icx + int(dx)
                    py = icy + int(dy)
                    if 0 <= px < SW and 0 <= py < SH:
                        pygame.draw.circle(self.surface, (*arc_color, 140),
                                           (px, py), 2)

        # Blit to screen
        screen.blit(self.surface, (0, 0))

    def _draw_glow_fast(self, cx, cy, radius, color, intensity, max_alpha, SW, SH):
        """Fast soft glow using concentric circles with decreasing alpha."""
        # Instead of per-pixel Gaussian, draw concentric filled circles
        # with decreasing alpha — much faster, looks smooth at screen res
        num_rings = min(12, radius // 4)
        if num_rings < 2:
            return

        rc, gc, bc = color
        for i in range(num_rings, 0, -1):
            t = i / num_rings  # 1.0 = outermost, approaching 0 = center
            r = int(radius * t)
            if r < 2:
                continue
            # Exponential falloff
            falloff = math.exp(-t * t * 2.0)
            a = int(max_alpha * falloff * intensity)
            if a < 2:
                continue
            cr = int(min(255, rc * falloff * intensity))
            cg = int(min(255, gc * falloff * intensity))
            cb = int(min(255, bc * falloff * intensity))
            pygame.draw.circle(self.surface, (cr, cg, cb, a), (cx, cy), r)
