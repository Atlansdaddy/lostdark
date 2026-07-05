"""Wave visualization layer: dual-colored wavefronts for dark-world echolocation.
SONAR waves = cyan/blue (reveal/light)
FORCE waves = orange/magenta (kinetic/destruction)
Both approach white at high amplitude.
"""
import numpy as np
import pygame
import time
from ... import config, materials


class WaveLayer:
    """
    Renders both sonar and force wave fields as distinct colored overlays.
    Sonar: cyan-blue (echolocation light)
    Force: orange-red (kinetic energy)
    High amplitude: both approach white.
    """

    def __init__(self):
        # RGBA surface at view resolution
        self.surface = pygame.Surface((config.VIEW_W, config.VIEW_H), pygame.SRCALPHA)
        self._rgb = np.zeros((config.VIEW_W, config.VIEW_H, 3), dtype=np.uint8)
        self._alpha = np.zeros((config.VIEW_W, config.VIEW_H), dtype=np.uint8)

        # Sonar colors (cool: cyan -> white)
        self.sonar_pos = np.array([40, 180, 255], dtype=np.float32)   # cyan
        self.sonar_neg = np.array([80, 120, 255], dtype=np.float32)   # blue

        # Force colors (hot: orange -> magenta -> white)
        self.force_pos = np.array([255, 120, 30], dtype=np.float32)   # orange
        self.force_neg = np.array([255, 50, 150], dtype=np.float32)   # magenta

        self.white = np.array([255, 255, 255], dtype=np.float32)

        # Pre-allocated scaled surface
        self._scaled_wave = pygame.Surface((config.SCREEN_W, config.SCREEN_H), pygame.SRCALPHA)

        # Cursor glow state
        self._cursor_gx = 0
        self._cursor_gy = 0
        self._view_x = 0
        self._view_y = 0
        self._active_wave_type = 0  # 0=sonar, 1=force (for cursor color)

    def render(self, screen, wave_u, voxels, cursor_gx=0, cursor_gy=0,
               view_x=0, view_y=0, sonar_u=None, force_u=None,
               active_wave_type=0):
        """
        Render dual wave overlay onto screen.
        sonar_u/force_u: separate fields. Falls back to wave_u if not provided.
        active_wave_type: 0=sonar, 1=force (affects cursor glow color).
        """
        self._cursor_gx = cursor_gx
        self._cursor_gy = cursor_gy
        self._view_x = view_x
        self._view_y = view_y
        self._active_wave_type = active_wave_type

        # Extract visible portions
        x1 = max(0, view_x)
        y1 = max(0, view_y)
        x2 = min(wave_u.shape[0], view_x + config.VIEW_W)
        y2 = min(wave_u.shape[1], view_y + config.VIEW_H)

        if sonar_u is not None and force_u is not None:
            sonar_view = sonar_u[x1:x2, y1:y2]
            force_view = force_u[x1:x2, y1:y2]
            self._render_dual_waves(sonar_view, force_view)
        else:
            # Legacy fallback: render combined as sonar-colored
            wave_view = wave_u[x1:x2, y1:y2]
            self._render_single_waves(wave_view)

        self._render_cursor_glow()

        # Scale and blit
        pygame.transform.scale(self.surface, (config.SCREEN_W, config.SCREEN_H), self._scaled_wave)
        screen.blit(self._scaled_wave, (0, 0))

    def _render_dual_waves(self, sonar_view, force_view):
        """Render sonar (cyan) and force (orange) as layered colored overlay."""
        W, H = sonar_view.shape
        rgb = self._rgb
        alpha = self._alpha
        rgb[:] = 0
        alpha[:] = 0

        # --- Sonar: cyan/blue ---
        s_pos = np.maximum(sonar_view, 0)
        s_neg = np.maximum(-sonar_view, 0)
        s_pos_i = np.clip(s_pos * 1.8, 0, 1)   # slightly brighter than force
        s_neg_i = np.clip(s_neg * 1.8, 0, 1)
        s_total = s_pos_i + s_neg_i
        s_safe = np.where(s_total > 0.001, s_total, 1.0)
        s_white_mix = np.clip((s_total - 0.5) * 2.0, 0, 0.7)

        # --- Force: orange/magenta ---
        f_pos = np.maximum(force_view, 0)
        f_neg = np.maximum(-force_view, 0)
        f_pos_i = np.clip(f_pos * 1.5, 0, 1)
        f_neg_i = np.clip(f_neg * 1.5, 0, 1)
        f_total = f_pos_i + f_neg_i
        f_safe = np.where(f_total > 0.001, f_total, 1.0)
        f_white_mix = np.clip((f_total - 0.4) * 2.5, 0, 0.8)

        # Combined intensity for alpha
        combined = s_total + f_total
        combined_safe = np.where(combined > 0.001, combined, 1.0)

        for c in range(3):
            # Sonar color
            s_base = (s_pos_i * self.sonar_pos[c] + s_neg_i * self.sonar_neg[c]) / s_safe
            s_mixed = s_base * (1.0 - s_white_mix) + self.white[c] * s_white_mix
            s_contrib = s_mixed * s_total

            # Force color
            f_base = (f_pos_i * self.force_pos[c] + f_neg_i * self.force_neg[c]) / f_safe
            f_mixed = f_base * (1.0 - f_white_mix) + self.white[c] * f_white_mix
            f_contrib = f_mixed * f_total

            # Blend: weighted average by intensity
            blended = (s_contrib + f_contrib) / combined_safe
            rgb[:W, :H, c] = np.clip(blended, 0, 255).astype(np.uint8)

        # Alpha from combined
        alpha[:W, :H] = np.clip(combined * 220, 0, 220).astype(np.uint8)

        # Write to surface
        pxa = pygame.surfarray.pixels3d(self.surface)
        pxa[:] = rgb
        del pxa
        pxa = pygame.surfarray.pixels_alpha(self.surface)
        pxa[:] = alpha
        del pxa

    def _render_single_waves(self, wave_view):
        """Legacy fallback: render single wave field as cyan/blue."""
        W, H = wave_view.shape
        rgb = self._rgb
        alpha = self._alpha
        rgb[:] = 0
        alpha[:] = 0

        pos = np.maximum(wave_view, 0)
        neg = np.maximum(-wave_view, 0)
        pos_i = np.clip(pos * 1.5, 0, 1)
        neg_i = np.clip(neg * 1.5, 0, 1)
        combined_i = pos_i + neg_i
        safe_div = np.where(combined_i > 0.001, combined_i, 1.0)
        white_mix = np.clip((combined_i - 0.5) * 2.0, 0, 0.8)

        for c in range(3):
            base = (pos_i * self.sonar_pos[c] + neg_i * self.sonar_neg[c]) / safe_div
            mixed = base * (1.0 - white_mix) + self.white[c] * white_mix
            rgb[:W, :H, c] = np.clip(mixed, 0, 255).astype(np.uint8)

        alpha[:W, :H] = np.clip(combined_i * 255, 0, 220).astype(np.uint8)

        pxa = pygame.surfarray.pixels3d(self.surface)
        pxa[:] = rgb
        del pxa
        pxa = pygame.surfarray.pixels_alpha(self.surface)
        pxa[:] = alpha
        del pxa

    def _render_cursor_glow(self):
        """Pulsing glow at cursor -- cyan for sonar, orange for force."""
        gx = self._cursor_gx - self._view_x
        gy = self._cursor_gy - self._view_y
        W, H = config.VIEW_W, config.VIEW_H

        if gx < 0 or gx >= W or gy < 0 or gy >= H:
            return

        pulse = 0.4 + 0.3 * np.sin(time.perf_counter() * 3.0 * 2 * np.pi)
        radius = 8

        x0 = max(0, gx - radius)
        y0 = max(0, gy - radius)
        x1 = min(W, gx + radius + 1)
        y1 = min(H, gy + radius + 1)
        if x0 >= x1 or y0 >= y1:
            return

        xs = np.arange(x0, x1, dtype=np.float32)
        ys = np.arange(y0, y1, dtype=np.float32)
        XX, YY = np.meshgrid(xs, ys, indexing='ij')
        dist2 = (XX - gx) ** 2 + (YY - gy) ** 2
        glow = pulse * np.exp(-dist2 / (2 * (radius / 2.5) ** 2))
        glow_u8 = np.clip(glow * 60, 0, 60).astype(np.uint8)

        pxa = pygame.surfarray.pixels3d(self.surface)
        pxa_a = pygame.surfarray.pixels_alpha(self.surface)

        region_r = pxa[x0:x1, y0:y1, 0].astype(np.int16)
        region_g = pxa[x0:x1, y0:y1, 1].astype(np.int16)
        region_b = pxa[x0:x1, y0:y1, 2].astype(np.int16)

        if self._active_wave_type == 0:
            # Sonar: cyan glow
            pxa[x0:x1, y0:y1, 0] = np.clip(region_r + glow_u8 * 0.2, 0, 255).astype(np.uint8)
            pxa[x0:x1, y0:y1, 1] = np.clip(region_g + glow_u8 * 0.7, 0, 255).astype(np.uint8)
            pxa[x0:x1, y0:y1, 2] = np.clip(region_b + glow_u8, 0, 255).astype(np.uint8)
        else:
            # Force: orange glow
            pxa[x0:x1, y0:y1, 0] = np.clip(region_r + glow_u8, 0, 255).astype(np.uint8)
            pxa[x0:x1, y0:y1, 1] = np.clip(region_g + glow_u8 * 0.5, 0, 255).astype(np.uint8)
            pxa[x0:x1, y0:y1, 2] = np.clip(region_b + glow_u8 * 0.15, 0, 255).astype(np.uint8)

        region_a = pxa_a[x0:x1, y0:y1].astype(np.int16)
        pxa_a[x0:x1, y0:y1] = np.clip(region_a + glow_u8, 0, 220).astype(np.uint8)

        del pxa
        del pxa_a
