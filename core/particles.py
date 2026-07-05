"""
SoA (Structure of Arrays) particle system - fully vectorized numpy.
Particle types: debris, spark, dust, fire, glass_shard.
"""
import numpy as np
from .. import config, materials

# Particle types
P_DEBRIS = 0
P_SPARK = 1
P_DUST = 2
P_FIRE = 3
P_GLASS = 4
NUM_TYPES = 5


class ParticleStorage:
    """
    SoA storage: parallel numpy arrays for each attribute.
    Pre-allocated to MAX_PARTICLES. Uses an 'alive' mask.
    """

    def __init__(self, max_particles=None):
        N = max_particles or config.MAX_PARTICLES
        self.max = N

        # Position (grid coordinates, float for sub-pixel)
        self.x = np.zeros(N, dtype=np.float32)
        self.y = np.zeros(N, dtype=np.float32)

        # Velocity
        self.vx = np.zeros(N, dtype=np.float32)
        self.vy = np.zeros(N, dtype=np.float32)

        # Visual
        self.r = np.zeros(N, dtype=np.uint8)
        self.g = np.zeros(N, dtype=np.uint8)
        self.b = np.zeros(N, dtype=np.uint8)
        self.alpha = np.zeros(N, dtype=np.uint8)

        # Lifetime (seconds remaining)
        self.life = np.zeros(N, dtype=np.float32)

        # Type
        self.ptype = np.zeros(N, dtype=np.uint8)

        # Alive mask
        self.alive = np.zeros(N, dtype=bool)

        # Size (pixels at grid scale)
        self.size = np.ones(N, dtype=np.float32)

        self._count = 0

    @property
    def count(self):
        return int(np.sum(self.alive))

    def spawn(self, x, y, vx, vy, r, g, b, alpha, life, ptype, size=1.0):
        """Spawn a single particle. Returns True if spawned."""
        dead = np.where(~self.alive)[0]
        if len(dead) == 0:
            return False
        i = dead[0]
        self.x[i] = x
        self.y[i] = y
        self.vx[i] = vx
        self.vy[i] = vy
        self.r[i] = r
        self.g[i] = g
        self.b[i] = b
        self.alpha[i] = alpha
        self.life[i] = life
        self.ptype[i] = ptype
        self.size[i] = size
        self.alive[i] = True
        return True

    def spawn_batch(self, n, x, y, vx, vy, r, g, b, alpha, life, ptype, size):
        """
        Spawn multiple particles at once. Arrays must be length n.
        Returns number actually spawned.
        """
        dead = np.where(~self.alive)[0]
        k = min(n, len(dead))
        if k == 0:
            return 0
        idx = dead[:k]
        self.x[idx] = x[:k]
        self.y[idx] = y[:k]
        self.vx[idx] = vx[:k]
        self.vy[idx] = vy[:k]
        self.r[idx] = r[:k]
        self.g[idx] = g[:k]
        self.b[idx] = b[:k]
        self.alpha[idx] = alpha[:k]
        self.life[idx] = life[:k]
        self.ptype[idx] = ptype[:k]
        self.size[idx] = size[:k]
        self.alive[idx] = True
        return k

    def update(self, dt):
        """Update all alive particles. Vectorized."""
        a = self.alive
        if not np.any(a):
            return

        # Gravity (affects debris, dust, glass; not sparks/fire)
        gravity_mask = a & ((self.ptype == P_DEBRIS) | (self.ptype == P_DUST) | (self.ptype == P_GLASS))
        self.vy[gravity_mask] += 80.0 * dt  # pixels/s^2 in grid coords

        # Fire rises
        fire_mask = a & (self.ptype == P_FIRE)
        self.vy[fire_mask] -= 40.0 * dt

        # Sparks: slight gravity + friction
        spark_mask = a & (self.ptype == P_SPARK)
        self.vy[spark_mask] += 20.0 * dt
        self.vx[spark_mask] *= 0.98
        self.vy[spark_mask] *= 0.98

        # Move
        self.x[a] += self.vx[a] * dt
        self.y[a] += self.vy[a] * dt

        # Age
        self.life[a] -= dt

        # Fade alpha with life
        t = np.clip(self.life[a] / 1.0, 0, 1)  # normalized remaining life
        self.alpha[a] = (t * 200).astype(np.uint8)

        # Kill expired or out-of-bounds
        kill = a & (
            (self.life <= 0) |
            (self.x < 0) | (self.x >= config.GRID_W) |
            (self.y < 0) | (self.y >= config.GRID_H)
        )
        self.alive[kill] = False

    def clear(self):
        """Kill all particles."""
        self.alive[:] = False


def spawn_destruction_particles(storage, destroyed, rng=None):
    """
    Spawn particles from destruction events.
    destroyed: list of (x, y, material_id, energy) tuples.
    """
    if not destroyed or storage.count >= storage.max - 10:
        return

    if rng is None:
        rng = np.random.default_rng()

    for x, y, mat, energy in destroyed:
        color = materials.COLORS[mat]
        speed = min(60, energy * 15 + 10)

        # Debris particles
        n_debris = int(materials.DEBRIS_COUNT[mat])
        if n_debris > 0:
            angles = rng.uniform(0, 2 * np.pi, n_debris).astype(np.float32)
            speeds = rng.uniform(speed * 0.3, speed, n_debris).astype(np.float32)
            storage.spawn_batch(
                n_debris,
                x=np.full(n_debris, float(x), dtype=np.float32),
                y=np.full(n_debris, float(y), dtype=np.float32),
                vx=np.cos(angles) * speeds,
                vy=np.sin(angles) * speeds - speed * 0.5,  # bias upward
                r=np.full(n_debris, color[0], dtype=np.uint8),
                g=np.full(n_debris, color[1], dtype=np.uint8),
                b=np.full(n_debris, color[2], dtype=np.uint8),
                alpha=np.full(n_debris, 220, dtype=np.uint8),
                life=rng.uniform(0.5, 1.5, n_debris).astype(np.float32),
                ptype=np.full(n_debris, P_DEBRIS, dtype=np.uint8),
                size=rng.uniform(1.0, 2.5, n_debris).astype(np.float32),
            )

        # Sparks (stone, glass, metal)
        if materials.SPARK_ON_BREAK[mat]:
            n_sparks = 2
            angles = rng.uniform(0, 2 * np.pi, n_sparks).astype(np.float32)
            speeds_s = rng.uniform(speed, speed * 2, n_sparks).astype(np.float32)
            storage.spawn_batch(
                n_sparks,
                x=np.full(n_sparks, float(x), dtype=np.float32),
                y=np.full(n_sparks, float(y), dtype=np.float32),
                vx=np.cos(angles) * speeds_s,
                vy=np.sin(angles) * speeds_s - speed,
                r=np.full(n_sparks, 255, dtype=np.uint8),
                g=np.full(n_sparks, 220, dtype=np.uint8),
                b=np.full(n_sparks, 100, dtype=np.uint8),
                alpha=np.full(n_sparks, 255, dtype=np.uint8),
                life=rng.uniform(0.2, 0.5, n_sparks).astype(np.float32),
                ptype=np.full(n_sparks, P_SPARK, dtype=np.uint8),
                size=np.full(n_sparks, 1.0, dtype=np.float32),
            )

        # Dust cloud
        n_dust = 2
        storage.spawn_batch(
            n_dust,
            x=rng.uniform(x - 2, x + 2, n_dust).astype(np.float32),
            y=rng.uniform(y - 2, y + 2, n_dust).astype(np.float32),
            vx=rng.uniform(-10, 10, n_dust).astype(np.float32),
            vy=rng.uniform(-15, -5, n_dust).astype(np.float32),
            r=np.full(n_dust, 180, dtype=np.uint8),
            g=np.full(n_dust, 170, dtype=np.uint8),
            b=np.full(n_dust, 160, dtype=np.uint8),
            alpha=np.full(n_dust, 120, dtype=np.uint8),
            life=rng.uniform(0.8, 2.0, n_dust).astype(np.float32),
            ptype=np.full(n_dust, P_DUST, dtype=np.uint8),
            size=rng.uniform(2.0, 4.0, n_dust).astype(np.float32),
        )

        # Glass shards
        if mat == materials.GLASS:
            n_glass = 4
            angles = rng.uniform(0, 2 * np.pi, n_glass).astype(np.float32)
            speeds_g = rng.uniform(speed * 0.5, speed * 1.5, n_glass).astype(np.float32)
            storage.spawn_batch(
                n_glass,
                x=np.full(n_glass, float(x), dtype=np.float32),
                y=np.full(n_glass, float(y), dtype=np.float32),
                vx=np.cos(angles) * speeds_g,
                vy=np.sin(angles) * speeds_g - speed * 0.3,
                r=np.full(n_glass, 200, dtype=np.uint8),
                g=np.full(n_glass, 230, dtype=np.uint8),
                b=np.full(n_glass, 250, dtype=np.uint8),
                alpha=np.full(n_glass, 200, dtype=np.uint8),
                life=rng.uniform(0.3, 0.8, n_glass).astype(np.float32),
                ptype=np.full(n_glass, P_GLASS, dtype=np.uint8),
                size=rng.uniform(0.5, 1.5, n_glass).astype(np.float32),
            )

        # Fire (wood only)
        if materials.FLAMMABLE[mat] and energy > 1.0:
            n_fire = 3
            storage.spawn_batch(
                n_fire,
                x=rng.uniform(x - 1, x + 1, n_fire).astype(np.float32),
                y=np.full(n_fire, float(y), dtype=np.float32),
                vx=rng.uniform(-5, 5, n_fire).astype(np.float32),
                vy=rng.uniform(-20, -5, n_fire).astype(np.float32),
                r=np.full(n_fire, 255, dtype=np.uint8),
                g=rng.integers(100, 200, n_fire).astype(np.uint8),
                b=np.full(n_fire, 30, dtype=np.uint8),
                alpha=np.full(n_fire, 200, dtype=np.uint8),
                life=rng.uniform(0.5, 1.2, n_fire).astype(np.float32),
                ptype=np.full(n_fire, P_FIRE, dtype=np.uint8),
                size=rng.uniform(1.5, 3.0, n_fire).astype(np.float32),
            )
