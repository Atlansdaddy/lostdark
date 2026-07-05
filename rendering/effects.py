"""Post-processing effects: bloom (quarter-res persistent) + screen shake."""
import numpy as np
import pygame
from .. import config


class Bloom:
    """
    Quarter-resolution bloom: downsample bright areas, box blur, composite additive.
    Persistent surfaces - no allocations per frame.
    """

    def __init__(self):
        self.qw = config.SCREEN_W // 4
        self.qh = config.SCREEN_H // 4
        self.enabled = True
        self.intensity = 0.6

        # Quarter-res surfaces
        self._quarter = pygame.Surface((self.qw, self.qh))
        self._blurred = pygame.Surface((self.qw, self.qh))
        self._upscaled = pygame.Surface((config.SCREEN_W, config.SCREEN_H))

    def apply(self, screen):
        """Apply bloom to the screen surface in-place."""
        if not self.enabled:
            return

        # Downsample screen to quarter resolution
        pygame.transform.scale(screen, (self.qw, self.qh), self._quarter)

        # Threshold: extract bright pixels only
        pxa = pygame.surfarray.pixels3d(self._quarter)
        brightness = pxa.astype(np.uint16).sum(axis=2)  # (qw, qh)
        threshold = 200  # sum of RGB > 200 = bright
        dim_mask = brightness < threshold
        pxa[dim_mask] = 0
        del pxa

        # Box blur (two-pass separable for speed)
        self._box_blur()

        # Upscale back to screen resolution
        pygame.transform.scale(self._blurred, (config.SCREEN_W, config.SCREEN_H), self._upscaled)

        # Additive blend onto screen
        screen.blit(self._upscaled, (0, 0), special_flags=pygame.BLEND_ADD)

    def _box_blur(self):
        """Simple box blur on quarter-res surface."""
        pxa = pygame.surfarray.pixels3d(self._quarter)
        buf = pxa.astype(np.uint16)

        # Horizontal pass
        out = buf.copy()
        out[1:-1, :, :] = (buf[:-2, :, :] + buf[1:-1, :, :] + buf[2:, :, :]) // 3

        # Vertical pass
        result = out.copy()
        result[:, 1:-1, :] = (out[:, :-2, :] + out[:, 1:-1, :] + out[:, 2:, :]) // 3

        del pxa

        pxb = pygame.surfarray.pixels3d(self._blurred)
        pxb[:] = np.clip(result * self.intensity, 0, 255).astype(np.uint8)
        del pxb


class ScreenShake:
    """Camera shake triggered by destruction events."""

    def __init__(self):
        self.offset_x = 0.0
        self.offset_y = 0.0
        self._trauma = 0.0  # 0-1 shake intensity
        self._decay = 3.0   # trauma decay per second

    def add_trauma(self, amount):
        """Add shake trauma (0-1). Caps at 1."""
        self._trauma = min(1.0, self._trauma + amount)

    def update(self, dt):
        """Update shake. Call once per frame."""
        if self._trauma <= 0:
            self.offset_x = 0
            self.offset_y = 0
            return

        # Shake magnitude = trauma^2 for perceptual smoothness
        mag = self._trauma * self._trauma * 8  # max 8px shake
        rng = np.random.default_rng()
        self.offset_x = rng.uniform(-mag, mag)
        self.offset_y = rng.uniform(-mag, mag)

        self._trauma = max(0, self._trauma - self._decay * dt)

    @property
    def active(self):
        return self._trauma > 0.01
