"""
Wave equation solver - TWO WAVE TYPES:
  SONAR: light/reveal waves (illumination only, no physics force)
  FORCE: kinetic waves (destruction, displacement, physical impact)

Both use the same wave equation but feed into different systems.
Numpy-first with optional torch acceleration.
"""
import numpy as np
import time
from .. import config

# Try torch
try:
    import torch
    HAS_TORCH = torch.cuda.is_available()
except ImportError:
    HAS_TORCH = False


# Wave type constants
SONAR = 0   # light/reveal — feeds illumination only
FORCE = 1   # kinetic — feeds destruction + physics


class WavePhysics:
    """
    Dual-field wave simulation.
    Sonar waves: reveal the world (illumination, no destruction).
    Force waves: physical impact (destruction, displacement).
    Both share speed_map and absorption from materials.
    """

    def __init__(self, use_torch=None):
        W, H = config.GRID_W, config.GRID_H

        # --- SONAR field (light waves) ---
        self.sonar_u = np.zeros((W, H), dtype=np.float32)
        self.sonar_v = np.zeros((W, H), dtype=np.float32)

        # --- FORCE field (kinetic waves) ---
        self.force_u = np.zeros((W, H), dtype=np.float32)
        self.force_v = np.zeros((W, H), dtype=np.float32)

        # Legacy alias: combined u for rendering (sonar + force overlay)
        self.u = np.zeros((W, H), dtype=np.float32)
        self.v = np.zeros((W, H), dtype=np.float32)

        # Shared material maps
        self.speed_map = np.ones((W, H), dtype=np.float32)
        self.absorption = np.zeros((W, H), dtype=np.float32)

        # Wave parameters
        self.c = config.WAVE_SPEED
        self.damping = config.WAVE_DAMPING
        self.substeps = config.WAVE_SUBSTEPS
        self.max_amp = config.MAX_WAVE_AMPLITUDE

        # Sonar travels faster and farther (less damping)
        self.sonar_speed_mult = 1.4     # sonar is 40% faster
        self.sonar_damping = 0.997      # sonar persists longer (lighter damping)

        # Force is heavier, punchy but short-lived
        self.force_damping = 0.975      # force decays fast (energy dumps into destruction)

        # Choose backend
        if use_torch is None:
            self._use_torch = HAS_TORCH and self._benchmark_torch_faster()
        else:
            self._use_torch = use_torch and HAS_TORCH

        if self._use_torch:
            self._init_torch()

    def _benchmark_torch_faster(self):
        """Run quick benchmark: numpy vs torch. Returns True if torch wins."""
        W, H = config.GRID_W, config.GRID_H
        iters = 10

        # Numpy timing
        u = np.random.randn(W, H).astype(np.float32) * 0.1
        v = np.zeros_like(u)
        t0 = time.perf_counter()
        for _ in range(iters):
            lap = np.zeros_like(u)
            lap[1:-1, 1:-1] = (
                u[0:-2, 1:-1] + u[2:, 1:-1] +
                u[1:-1, 0:-2] + u[1:-1, 2:] -
                4 * u[1:-1, 1:-1]
            )
            v = (v + self.c * self.c * lap) * self.damping
            u = u + v
        np_time = time.perf_counter() - t0

        # Torch timing
        try:
            device = torch.device('cuda')
            ut = torch.randn(1, 1, W, H, device=device, dtype=torch.float32) * 0.1
            vt = torch.zeros_like(ut)
            kernel = torch.tensor([[0, 1, 0], [1, -4, 1], [0, 1, 0]],
                                  device=device, dtype=torch.float32).reshape(1, 1, 3, 3)
            torch.cuda.synchronize()
            t0 = time.perf_counter()
            for _ in range(iters):
                lap = torch.nn.functional.conv2d(ut, kernel, padding=1)
                vt = (vt + self.c * self.c * lap) * self.damping
                ut = ut + vt
            torch.cuda.synchronize()
            torch_time = time.perf_counter() - t0
        except Exception:
            return False

        print(f"[WavePhysics] numpy: {np_time*1000:.1f}ms  torch: {torch_time*1000:.1f}ms  -> {'torch' if torch_time < np_time else 'numpy'}")
        return torch_time < np_time

    def _init_torch(self):
        """Initialize torch tensors and kernel."""
        self._device = torch.device('cuda')
        self._kernel = torch.tensor(
            [[0, 1, 0], [1, -4, 1], [0, 1, 0]],
            device=self._device, dtype=torch.float32
        ).reshape(1, 1, 3, 3)
        # Sonar torch fields
        self._sonar_ut = torch.zeros(1, 1, config.GRID_W, config.GRID_H,
                                     device=self._device, dtype=torch.float32)
        self._sonar_vt = torch.zeros_like(self._sonar_ut)
        # Force torch fields
        self._force_ut = torch.zeros(1, 1, config.GRID_W, config.GRID_H,
                                     device=self._device, dtype=torch.float32)
        self._force_vt = torch.zeros_like(self._force_ut)
        self._speed_t = torch.ones_like(self._sonar_ut)

    def update_speed_map(self, speed_map, absorption_map):
        """Update per-cell wave speed and absorption from material data."""
        self.speed_map[:] = speed_map
        self.absorption[:] = absorption_map
        if self._use_torch:
            self._speed_t = torch.from_numpy(
                speed_map.reshape(1, 1, config.GRID_W, config.GRID_H)
            ).to(self._device)

    def add_pulse(self, x, y, amplitude=2.0, radius=5, wave_type=FORCE):
        """Add a Gaussian wave pulse at (x, y) to the specified wave field."""
        W, H = config.GRID_W, config.GRID_H
        x0 = max(0, x - radius * 3)
        y0 = max(0, y - radius * 3)
        x1 = min(W, x + radius * 3 + 1)
        y1 = min(H, y + radius * 3 + 1)

        xs = np.arange(x0, x1, dtype=np.float32)
        ys = np.arange(y0, y1, dtype=np.float32)
        if len(xs) == 0 or len(ys) == 0:
            return
        XX, YY = np.meshgrid(xs, ys, indexing='ij')
        dist2 = (XX - x) ** 2 + (YY - y) ** 2
        pulse = amplitude * np.exp(-dist2 / (2 * radius * radius))

        if wave_type == SONAR:
            self.sonar_v[x0:x1, y0:y1] += pulse
            if self._use_torch:
                self._sonar_vt[0, 0, x0:x1, y0:y1] += torch.from_numpy(pulse).to(self._device)
        else:
            self.force_v[x0:x1, y0:y1] += pulse
            if self._use_torch:
                self._force_vt[0, 0, x0:x1, y0:y1] += torch.from_numpy(pulse).to(self._device)

    def add_sonar(self, x, y, amplitude=1.5, radius=5):
        """Convenience: add a sonar (light) pulse."""
        self.add_pulse(x, y, amplitude, radius, wave_type=SONAR)

    def add_force(self, x, y, amplitude=2.0, radius=5):
        """Convenience: add a force (kinetic) pulse."""
        self.add_pulse(x, y, amplitude, radius, wave_type=FORCE)

    def step(self):
        """Advance both wave fields by one frame."""
        if self._use_torch:
            self._step_torch()
        else:
            self._step_numpy()

        # Combined u for rendering (both wave types visible)
        self.u = self.sonar_u + self.force_u
        self.v = self.sonar_v + self.force_v

    def _step_numpy(self):
        """Numpy wave equation — step both fields."""
        c2_base = (self.c * self.speed_map) ** 2
        absorb = 1.0 - self.absorption * 0.1

        # --- Sonar field (faster propagation, lighter damping) ---
        su, sv = self.sonar_u, self.sonar_v
        c2_sonar = c2_base * (self.sonar_speed_mult ** 2)
        for _ in range(self.substeps):
            lap = np.zeros_like(su)
            lap[1:-1, 1:-1] = (
                su[0:-2, 1:-1] + su[2:, 1:-1] +
                su[1:-1, 0:-2] + su[1:-1, 2:] -
                4 * su[1:-1, 1:-1]
            )
            sv = (sv + c2_sonar * lap) * self.sonar_damping * absorb
            su = su + sv
        np.clip(su, -self.max_amp, self.max_amp, out=su)
        self.sonar_u = su
        self.sonar_v = sv

        # --- Force field (standard speed, heavier damping) ---
        fu, fv = self.force_u, self.force_v
        for _ in range(self.substeps):
            lap = np.zeros_like(fu)
            lap[1:-1, 1:-1] = (
                fu[0:-2, 1:-1] + fu[2:, 1:-1] +
                fu[1:-1, 0:-2] + fu[1:-1, 2:] -
                4 * fu[1:-1, 1:-1]
            )
            fv = (fv + c2_base * lap) * self.force_damping * absorb
            fu = fu + fv
        np.clip(fu, -self.max_amp, self.max_amp, out=fu)
        self.force_u = fu
        self.force_v = fv

    def _step_torch(self):
        """Torch GPU wave equation — step both fields."""
        c2_base = (self.c ** 2) * (self._speed_t ** 2)

        # Sonar
        sut, svt = self._sonar_ut, self._sonar_vt
        c2_sonar = c2_base * (self.sonar_speed_mult ** 2)
        for _ in range(self.substeps):
            lap = torch.nn.functional.conv2d(sut, self._kernel, padding=1)
            svt = (svt + c2_sonar * lap) * self.sonar_damping
            sut = sut + svt
        sut.clamp_(-self.max_amp, self.max_amp)
        self._sonar_ut, self._sonar_vt = sut, svt
        self.sonar_u = sut[0, 0].cpu().numpy()
        self.sonar_v = svt[0, 0].cpu().numpy()

        # Force
        fut, fvt = self._force_ut, self._force_vt
        for _ in range(self.substeps):
            lap = torch.nn.functional.conv2d(fut, self._kernel, padding=1)
            fvt = (fvt + c2_base * lap) * self.force_damping
            fut = fut + fvt
        fut.clamp_(-self.max_amp, self.max_amp)
        self._force_ut, self._force_vt = fut, fvt
        self.force_u = fut[0, 0].cpu().numpy()
        self.force_v = fvt[0, 0].cpu().numpy()

    def get_energy(self):
        """Return FORCE energy field for destruction. Sonar doesn't destroy."""
        return self.force_u ** 2 + self.force_v ** 2

    def get_sonar_energy(self):
        """Return SONAR energy field for illumination boost."""
        return self.sonar_u ** 2 + self.sonar_v ** 2

    def reset(self):
        """Clear all wave state."""
        self.sonar_u[:] = 0
        self.sonar_v[:] = 0
        self.force_u[:] = 0
        self.force_v[:] = 0
        self.u[:] = 0
        self.v[:] = 0
        if self._use_torch:
            self._sonar_ut.zero_()
            self._sonar_vt.zero_()
            self._force_ut.zero_()
            self._force_vt.zero_()
