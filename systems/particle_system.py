"""Particle system: event-driven spawning + physics update."""
from ..core.particles import ParticleStorage, spawn_destruction_particles
import numpy as np


class ParticleSystem:
    """
    Manages particle lifecycle:
    - Spawns particles from destruction events
    - Updates particle positions/velocities
    - Handles particle death
    """

    def __init__(self, storage=None):
        self.storage = storage or ParticleStorage()
        self._rng = np.random.default_rng(seed=42)

    def on_destruction(self, destroyed):
        """Handle destruction events by spawning particles."""
        if destroyed:
            spawn_destruction_particles(self.storage, destroyed, self._rng)

    def update(self, dt):
        """Update all particles."""
        self.storage.update(dt)

    def clear(self):
        """Kill all particles."""
        self.storage.clear()
