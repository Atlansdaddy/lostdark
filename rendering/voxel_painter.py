"""Palette LUT + noise + edge brightening + illumination for voxel rendering."""
import numpy as np
from .. import config, materials, util


class VoxelPainter:
    """Converts voxel grid to RGB pixels: palette index + noise + bright edges + illumination."""

    def __init__(self):
        # Noise field for full world (we'll slice it as needed)
        self.noise = util.noise_field(config.GRID_W, config.GRID_H, seed=42)
        # Work buffers sized for view (will resize dynamically if needed)
        self._rgb = np.zeros((config.VIEW_W, config.VIEW_H, 3), dtype=np.uint8)
        self._tmp = np.zeros((config.VIEW_W, config.VIEW_H, 3), dtype=np.int16)
        self._lit = np.zeros((config.VIEW_W, config.VIEW_H, 3), dtype=np.float32)

    def paint(self, voxels, illumination=None):
        """
        Terrain repaint: palette-index render + noise + bright edges + illumination.
        voxels: (W, H) uint8 - can be any size (view-sized subset of world).
        illumination: optional (W, H) float32 light field.
        Returns (W, H, 3) uint8 RGB buffer. Buffer is reused - do not hold reference.
        """
        W, H = voxels.shape

        # Ensure work buffers are correct size
        if self._rgb.shape[0] != W or self._rgb.shape[1] != H:
            self._rgb = np.zeros((W, H, 3), dtype=np.uint8)
            self._tmp = np.zeros((W, H, 3), dtype=np.int16)
            self._lit = np.zeros((W, H, 3), dtype=np.float32)

        rgb = self._rgb
        tmp = self._tmp

        # 1. Palette-index render (the killer optimization)
        rgb[:] = materials.COLOR_LUT_RGB[voxels]

        # 2. Per-voxel color noise (slice noise field to match view)
        variation = materials.COLOR_VARIATION[voxels]  # (W, H) int32
        noise_slice = self.noise[:W, :H] if W <= self.noise.shape[0] and H <= self.noise.shape[1] else np.random.randn(W, H)
        offset = (noise_slice * variation).astype(np.int16)  # (W, H) int16

        tmp[:, :, 0] = rgb[:, :, 0]
        tmp[:, :, 1] = rgb[:, :, 1]
        tmp[:, :, 2] = rgb[:, :, 2]
        tmp[:, :, 0] += offset
        tmp[:, :, 1] += offset
        tmp[:, :, 2] += offset
        np.clip(tmp, 0, 255, out=tmp)

        # 3. Edge brightening (material boundaries - Geometry Dash style)
        edges = self._compute_edges(voxels)
        if np.any(edges):
            # Brighten edges instead of darkening (clean glowing outlines)
            tmp[edges, 0] = np.minimum(255, tmp[edges, 0] + 40)
            tmp[edges, 1] = np.minimum(255, tmp[edges, 1] + 50)
            tmp[edges, 2] = np.minimum(255, tmp[edges, 2] + 60)

        # 4. Illumination multiply (dark world)
        if illumination is not None:
            lit = self._lit
            light = np.clip(illumination, 0, 2.0)  # cap so it doesn't blow out
            lit[:, :, 0] = tmp[:, :, 0] * light
            lit[:, :, 1] = tmp[:, :, 1] * light
            lit[:, :, 2] = tmp[:, :, 2] * light
            np.clip(lit, 0, 255, out=lit)
            rgb[:] = lit.astype(np.uint8)
            # Air stays black (bg color handles it)
            air = voxels == materials.AIR
            rgb[air] = 0
        else:
            rgb[:] = tmp.astype(np.uint8)

        return rgb

    @staticmethod
    def _compute_edges(voxels):
        """Compute material boundary mask. True = edge pixel."""
        edges = np.zeros(voxels.shape, dtype=bool)
        edges[1:, :] |= (voxels[1:, :] != voxels[:-1, :])
        edges[:-1, :] |= (voxels[:-1, :] != voxels[1:, :])
        edges[:, 1:] |= (voxels[:, 1:] != voxels[:, :-1])
        edges[:, :-1] |= (voxels[:, :-1] != voxels[:, 1:])
        # Don't darken air boundaries
        edges &= (voxels != materials.AIR)
        return edges
