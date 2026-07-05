"""Illumination system: wave energy -> per-cell light for dark-world rendering."""
import numpy as np
from .. import config, materials


class PulseRing:
    """An expanding ring of light radiating outward from a point."""
    __slots__ = ('cx', 'cy', 'current_radius', 'max_radius', 'speed', 'intensity', 'age')

    def __init__(self, cx, cy, max_radius, speed, intensity):
        self.cx = cx
        self.cy = cy
        self.current_radius = 0.0
        self.max_radius = max_radius
        self.speed = speed
        self.intensity = intensity
        self.age = 0.0


class Illumination:
    """
    Tracks per-cell illumination level.
    Updated each frame from wave amplitude and material properties.
    Screen is near-black; waves are your only light.
    """

    def __init__(self):
        W, H = config.GRID_W, config.GRID_H
        self.light = np.zeros((W, H), dtype=np.float32)  # 0=black, 1+=lit

        # Per-cell maps (updated when terrain changes)
        self._decay = np.ones((W, H), dtype=np.float32) * 0.948
        self._reflect = np.zeros((W, H), dtype=np.float32)

        # Active pulse rings
        self._pulses = []

    def terrain_changed(self, voxels):
        """Update per-cell decay and reflectivity from current voxels."""
        self._decay[:] = materials.GLOW_DECAY[voxels]
        self._reflect[:] = materials.REFLECTIVITY[voxels]

    def update_pulses(self, dt):
        """Advance all pulse rings, apply ring-shaped light, remove expired."""
        W, H = config.GRID_W, config.GRID_H
        ring_width = 3.5  # cells wide

        alive = []
        for p in self._pulses:
            p.current_radius += p.speed * dt
            p.age += dt

            if p.current_radius > p.max_radius:
                continue  # expired

            r = p.current_radius
            # Bounding box for the ring
            outer = int(r + ring_width + 1)
            x0 = max(0, int(p.cx) - outer)
            y0 = max(0, int(p.cy) - outer)
            x1 = min(W, int(p.cx) + outer + 1)
            y1 = min(H, int(p.cy) + outer + 1)
            if x0 >= x1 or y0 >= y1:
                alive.append(p)
                continue

            xs = np.arange(x0, x1, dtype=np.float32)
            ys = np.arange(y0, y1, dtype=np.float32)
            XX, YY = np.meshgrid(xs, ys, indexing='ij')
            dist = np.sqrt((XX - p.cx) ** 2 + (YY - p.cy) ** 2)

            # Ring: Gaussian around current_radius
            ring = p.intensity * np.exp(-((dist - r) ** 2) / (2.0 * (ring_width / 2.5) ** 2))
            # Fade intensity as ring expands
            fade = 1.0 - (p.current_radius / p.max_radius) * 0.5
            self.light[x0:x1, y0:y1] += ring * fade

            alive.append(p)

        self._pulses = alive

    def update(self, wave_u, voxels):
        """Legacy single-field update (backward compat). Uses combined wave_u."""
        self.update_dual(wave_u, None, voxels)

    def update_dual(self, sonar_u, force_u, voxels):
        """
        Update illumination from dual wave fields:
        - SONAR: primary illumination source (this is how you SEE)
        - FORCE: faint hot glow (destruction energy visible but dim)
        """
        # Sonar amplitude — the main light source
        sonar_amp = np.abs(sonar_u) if sonar_u is not None else 0.0

        # Force amplitude — faint warm glow from kinetic energy
        force_amp = np.abs(force_u) if force_u is not None else 0.0

        # Sonar illuminates strongly — this is echolocation light
        self.light += sonar_amp * self._reflect * 0.35

        # Force gives a faint glow — you can see the shockwave but it's not a light source
        self.light += force_amp * self._reflect * 0.08

        # Air cells: sonar wavefronts visible, force barely visible
        air_mask = voxels == materials.AIR
        if sonar_u is not None:
            self.light[air_mask] += sonar_amp[air_mask] * 0.08
        if force_u is not None:
            self.light[air_mask] += force_amp[air_mask] * 0.02

        # Water cells: sonar transmits as caustic light, force ripples surface
        water_mask = voxels == materials.WATER
        if sonar_u is not None:
            self.light[water_mask] += sonar_amp[water_mask] * 0.2
        if force_u is not None:
            self.light[water_mask] += force_amp[water_mask] * 0.05

        # Decay (per-material: metal=0.981 stays lit, glass=0.928 fades fast)
        self.light *= self._decay

        # Minimum ambient so cave geometry is faintly visible
        solid = voxels != materials.AIR
        np.maximum(self.light, 0.04 * solid, out=self.light)

        # Water has slightly higher ambient glow (faint blue luminescence)
        np.maximum(self.light, 0.08 * water_mask, out=self.light)

        # Clamp
        np.clip(self.light, 0, 3.0, out=self.light)

    def add_pulse_ring(self, x, y, max_radius=60, speed=100.0, intensity=1.5):
        """Add an expanding ring of light from (x, y)."""
        self._pulses.append(PulseRing(x, y, max_radius, speed, intensity))

    def add_glow(self, x, y, radius, intensity):
        """Add a point light source (e.g. player glow)."""
        W, H = config.GRID_W, config.GRID_H
        x0 = max(0, x - radius)
        y0 = max(0, y - radius)
        x1 = min(W, x + radius + 1)
        y1 = min(H, y + radius + 1)
        if x0 >= x1 or y0 >= y1:
            return

        xs = np.arange(x0, x1, dtype=np.float32)
        ys = np.arange(y0, y1, dtype=np.float32)
        XX, YY = np.meshgrid(xs, ys, indexing='ij')
        dist2 = (XX - x) ** 2 + (YY - y) ** 2
        glow = intensity * np.exp(-dist2 / (2 * (radius / 2.5) ** 2))
        self.light[x0:x1, y0:y1] += glow

    def add_flash(self, x, y, radius, intensity):
        """
        Bright echolocation flash - illuminates a large area instantly.
        Brighter at center, fades with distance. No wave physics involved.
        """
        W, H = config.GRID_W, config.GRID_H
        x0 = max(0, x - radius)
        y0 = max(0, y - radius)
        x1 = min(W, x + radius + 1)
        y1 = min(H, y + radius + 1)
        if x0 >= x1 or y0 >= y1:
            return

        xs = np.arange(x0, x1, dtype=np.float32)
        ys = np.arange(y0, y1, dtype=np.float32)
        XX, YY = np.meshgrid(xs, ys, indexing='ij')
        dist2 = (XX - x) ** 2 + (YY - y) ** 2
        # Wider Gaussian (radius / 1.8 instead of / 2.5) for broader coverage
        flash = intensity * np.exp(-dist2 / (2 * (radius / 1.8) ** 2))
        self.light[x0:x1, y0:y1] += flash

    def flood_light(self, intensity=2.0):
        """Flood the entire level with light (level-complete reveal)."""
        self.light[:] = intensity

    def reset(self):
        """Clear illumination state."""
        self.light[:] = 0
        self._pulses.clear()
