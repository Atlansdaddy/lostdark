"""
Destruction system: wave energy -> material damage -> voxel breaking.
Deterministic top-K: highest energy/cohesion ratio breaks first.
"""
import numpy as np
from .. import config, materials


class DestructionProcessor:
    """
    Each frame: score all voxels by energy/cohesion, break top-K.
    Returns list of destruction events for particle spawning.
    """

    def __init__(self):
        self.threshold = config.DESTRUCTION_THRESHOLD
        self.max_per_frame = config.MAX_DESTRUCTIONS_PER_FRAME

    def process(self, grid, energy_field):
        """
        Process destruction from wave energy.
        energy_field: (W, H) float32 wave energy density.
        Returns list of (x, y, material_id, energy) tuples for destroyed voxels.
        """
        voxels = grid.voxels

        # Only consider solid, non-air voxels
        solid = materials.IS_SOLID[voxels]
        if not np.any(solid):
            return []

        # Score: energy / cohesion (higher = breaks easier)
        cohesion = materials.COHESION[voxels]
        safe_cohesion = np.where(cohesion > 0, cohesion, 1.0)
        score = np.where(solid, energy_field / safe_cohesion, 0.0)

        # Only voxels above threshold
        candidates = score > self.threshold
        if not np.any(candidates):
            return []

        # Get candidate positions and scores
        positions = np.argwhere(candidates)  # (N, 2)
        scores = score[candidates]           # (N,)

        # Top-K by score (deterministic: highest energy/cohesion breaks first)
        if len(scores) > self.max_per_frame:
            top_k_idx = np.argpartition(scores, -self.max_per_frame)[-self.max_per_frame:]
            positions = positions[top_k_idx]
            scores = scores[top_k_idx]

        # Destroy voxels and collect events
        destroyed = []
        for i in range(len(positions)):
            x, y = int(positions[i, 0]), int(positions[i, 1])
            mat = int(voxels[x, y])
            if mat == materials.AIR:
                continue
            e = float(scores[i])
            voxels[x, y] = materials.AIR
            destroyed.append((x, y, mat, e))

        # Mark affected chunks dirty
        if destroyed:
            xs = positions[:, 0]
            ys = positions[:, 1]
            cxs = xs // config.CHUNK_SIZE
            cys = ys // config.CHUNK_SIZE
            for cx, cy in zip(cxs, cys):
                cx, cy = int(cx), int(cy)
                grid.chunk_dirty[cx, cy] = True
                if cx > 0: grid.chunk_dirty[cx - 1, cy] = True
                if cx < grid.cw - 1: grid.chunk_dirty[cx + 1, cy] = True
                if cy > 0: grid.chunk_dirty[cx, cy - 1] = True
                if cy < grid.ch - 1: grid.chunk_dirty[cx, cy + 1] = True

        return destroyed
