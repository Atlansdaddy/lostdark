"""Physics orchestrator: dual wave (sonar+force) + destruction + water + granular + illumination."""
import numpy as np
from .. import config, materials
from ..core.wave_physics import WavePhysics, SONAR, FORCE
from ..core.destruction import DestructionProcessor
from ..core.water import WaterSim
from ..core.granular import GranularSim
from ..core.particles import ParticleStorage, spawn_destruction_particles
from ..core.illumination import Illumination


class PhysicsSystem:
    """Orchestrates all physics subsystems including dual-wave illumination."""

    def __init__(self, grid, use_torch=None):
        self.grid = grid
        self.wave = WavePhysics(use_torch=use_torch)
        self.destruction = DestructionProcessor()
        self.water = WaterSim()
        self.granular = GranularSim()
        self.particles = ParticleStorage()
        self.illumination = Illumination()
        self._rng = np.random.default_rng(seed=42)

        # Sync speed map + illumination
        self._sync_speed_map()
        self.illumination.terrain_changed(grid.voxels)

        # Stats from last frame
        self.destroyed_count = 0

    def _sync_speed_map(self):
        """Update wave speed/absorption from current voxel state."""
        self.wave.update_speed_map(
            materials.WAVE_SPEED_MULT[self.grid.voxels],
            materials.ABSORPTION[self.grid.voxels],
        )

    def add_wave_pulse(self, x, y, amplitude=2.0, radius=5, wave_type=FORCE):
        """Add a wave pulse at grid position (defaults to force for backward compat)."""
        self.wave.add_pulse(x, y, amplitude, radius, wave_type=wave_type)

    def add_sonar_pulse(self, x, y, amplitude=1.5, radius=5):
        """Add a sonar (light-only) wave pulse."""
        self.wave.add_sonar(x, y, amplitude, radius)

    def add_force_pulse(self, x, y, amplitude=2.0, radius=5):
        """Add a force (destructive) wave pulse."""
        self.wave.add_force(x, y, amplitude, radius)

    def terrain_changed(self):
        """Notify physics that terrain was modified externally."""
        self._sync_speed_map()
        self.illumination.terrain_changed(self.grid.voxels)

    def update(self, dt):
        """
        Full physics tick:
        1. Wave equation step (both sonar + force)
        2. Destruction from FORCE energy only
        3. Water sim
        4. Illumination from SONAR energy + force glow
        5. Particle update
        Returns list of destroyed voxels.
        """
        # Wave physics (both fields)
        self.wave.step()

        # Destruction — ONLY from force waves (sonar is non-destructive)
        energy = self.wave.get_energy()
        destroyed = self.destruction.process(self.grid, energy)
        self.destroyed_count = len(destroyed)

        if destroyed:
            spawn_destruction_particles(self.particles, destroyed, self._rng)
            self._sync_speed_map()
            self.illumination.terrain_changed(self.grid.voxels)

        # Water
        self.water.update(self.grid, dt)

        # Granular (sand falls, dirt crumbles)
        granular_changed = self.granular.update(self.grid, dt)
        if granular_changed:
            self._sync_speed_map()
            self.illumination.terrain_changed(self.grid.voxels)

        # Pulse rings (expanding echolocation rings)
        self.illumination.update_pulses(dt)

        # Illumination — sonar waves illuminate strongly, force waves glow faintly
        self.illumination.update_dual(
            self.wave.sonar_u, self.wave.force_u, self.grid.voxels
        )

        # Particles
        self.particles.update(dt)

        return destroyed

    def reset(self):
        """Clear all physics state."""
        self.wave.reset()
        self.water.reset()
        self.granular.reset()
        self.particles.clear()
        self.illumination.reset()
        self._sync_speed_map()
        self.illumination.terrain_changed(self.grid.voxels)
