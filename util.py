"""Pure utility functions."""
import numpy as np


def pack_rgb(r, g, b):
    """Pack RGB to uint32 (0x00RRGGBB format)."""
    return (int(r) << 16) | (int(g) << 8) | int(b)


def noise_field(w, h, seed=42):
    """Generate a noise field of shape (w, h) with values in [-1, 1]."""
    rng = np.random.RandomState(seed)
    return rng.uniform(-1.0, 1.0, (w, h)).astype(np.float32)


def clamp(val, lo, hi):
    """Clamp a value between lo and hi."""
    return max(lo, min(hi, val))


def lerp_color(c1, c2, t):
    """Linearly interpolate between two RGB tuples."""
    t = max(0.0, min(1.0, t))
    return (
        int(c1[0] + (c2[0] - c1[0]) * t),
        int(c1[1] + (c2[1] - c1[1]) * t),
        int(c1[2] + (c2[2] - c1[2]) * t),
    )
