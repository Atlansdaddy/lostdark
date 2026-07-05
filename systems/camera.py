"""Camera system: screen shake, future pan/zoom."""
import numpy as np


class Camera:
    """
    2D camera with screen shake support.
    Future: pan/zoom for exploring large worlds.
    """

    def __init__(self):
        # Offset applied to rendering
        self.offset_x = 0.0
        self.offset_y = 0.0

        # Shake
        self._trauma = 0.0
        self._trauma_decay = 3.0  # per second
        self._max_shake = 8.0     # max pixel offset
        self._rng = np.random.default_rng()

    def add_trauma(self, amount):
        """Add shake trauma (0-1). Clips at 1."""
        self._trauma = min(1.0, self._trauma + amount)

    def update(self, dt):
        """Update camera state. Call once per frame."""
        if self._trauma > 0.001:
            mag = self._trauma * self._trauma * self._max_shake
            self.offset_x = self._rng.uniform(-mag, mag)
            self.offset_y = self._rng.uniform(-mag, mag)
            self._trauma = max(0, self._trauma - self._trauma_decay * dt)
        else:
            self.offset_x = 0.0
            self.offset_y = 0.0
            self._trauma = 0.0

    @property
    def shaking(self):
        return self._trauma > 0.001

    def reset(self):
        """Reset camera to default state."""
        self.offset_x = 0.0
        self.offset_y = 0.0
        self._trauma = 0.0
