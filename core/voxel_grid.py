"""2D voxel grid with chunk-based dirty tracking."""
import numpy as np
from .. import config
from .. import materials


class VoxelGrid:
    def __init__(self):
        self.w = config.GRID_W
        self.h = config.GRID_H
        self.voxels = np.zeros((self.w, self.h), dtype=np.uint8)

        # Chunk dirty tracking
        self.cw = config.CHUNKS_W
        self.ch = config.CHUNKS_H
        self.chunk_dirty = np.ones((self.cw, self.ch), dtype=bool)  # all dirty initially

    def get(self, x, y):
        """Get material at (x, y). Returns AIR if out of bounds."""
        if 0 <= x < self.w and 0 <= y < self.h:
            return self.voxels[x, y]
        return materials.AIR

    def set(self, x, y, material):
        """Set material at (x, y). Marks chunk and neighbors dirty."""
        if 0 <= x < self.w and 0 <= y < self.h:
            if self.voxels[x, y] != material:
                self.voxels[x, y] = material
                self._dirty_around(x // config.CHUNK_SIZE, y // config.CHUNK_SIZE)

    def _dirty_around(self, cx, cy):
        """Mark a chunk and its 4-neighbors dirty (for edge darkening across borders)."""
        cw, ch = self.cw, self.ch
        d = self.chunk_dirty
        d[cx, cy] = True
        if cx > 0:      d[cx - 1, cy] = True
        if cx < cw - 1: d[cx + 1, cy] = True
        if cy > 0:      d[cx, cy - 1] = True
        if cy < ch - 1: d[cx, cy + 1] = True

    def set_rect(self, x0, y0, w, h, material):
        """Fill a rectangle with material."""
        x1 = max(0, x0)
        y1 = max(0, y0)
        x2 = min(self.w, x0 + w)
        y2 = min(self.h, y0 + h)
        if x1 >= x2 or y1 >= y2:
            return
        self.voxels[x1:x2, y1:y2] = material
        # Mark affected chunks + 1-chunk border dirty
        cx1 = max(0, x1 // config.CHUNK_SIZE - 1)
        cy1 = max(0, y1 // config.CHUNK_SIZE - 1)
        cx2 = min(self.cw, (x2 - 1) // config.CHUNK_SIZE + 2)
        cy2 = min(self.ch, (y2 - 1) // config.CHUNK_SIZE + 2)
        self.chunk_dirty[cx1:cx2, cy1:cy2] = True

    def set_circle(self, cx, cy, radius, material):
        """Fill a circle with material."""
        x0 = max(0, cx - radius)
        y0 = max(0, cy - radius)
        x1 = min(self.w, cx + radius + 1)
        y1 = min(self.h, cy + radius + 1)

        xs = np.arange(x0, x1)
        ys = np.arange(y0, y1)
        if len(xs) == 0 or len(ys) == 0:
            return

        XX, YY = np.meshgrid(xs, ys, indexing='ij')
        dist2 = (XX - cx) ** 2 + (YY - cy) ** 2
        mask = dist2 <= radius * radius
        self.voxels[x0:x1, y0:y1][mask] = material

        # Mark affected chunks dirty
        chx0 = max(0, x0 // config.CHUNK_SIZE - 1)
        chy0 = max(0, y0 // config.CHUNK_SIZE - 1)
        chx1 = min(self.cw, (x1 - 1) // config.CHUNK_SIZE + 2)
        chy1 = min(self.ch, (y1 - 1) // config.CHUNK_SIZE + 2)
        self.chunk_dirty[chx0:chx1, chy0:chy1] = True

    def consume_dirty(self):
        """Return Nx2 array of dirty chunk coords [cx, cy] and clear all flags."""
        dirty = np.argwhere(self.chunk_dirty)
        self.chunk_dirty[:] = False
        return dirty

    def mark_all_dirty(self):
        """Mark all chunks dirty."""
        self.chunk_dirty[:] = True

    def clear(self):
        """Reset to all air."""
        self.voxels[:] = materials.AIR
        self.mark_all_dirty()

    def destroy_voxel(self, x, y):
        """Destroy a voxel, returning its old material. Returns AIR if already air."""
        if 0 <= x < self.w and 0 <= y < self.h:
            old = self.voxels[x, y]
            if old != materials.AIR:
                self.voxels[x, y] = materials.AIR
                self._dirty_around(x // config.CHUNK_SIZE, y // config.CHUNK_SIZE)
                return old
        return materials.AIR

    def destroy_circle(self, cx, cy, radius):
        """Destroy all voxels in a circle. Returns list of (x, y, old_material)."""
        x0 = max(0, cx - radius)
        y0 = max(0, cy - radius)
        x1 = min(self.w, cx + radius + 1)
        y1 = min(self.h, cy + radius + 1)

        xs = np.arange(x0, x1)
        ys = np.arange(y0, y1)
        if len(xs) == 0 or len(ys) == 0:
            return []

        XX, YY = np.meshgrid(xs, ys, indexing='ij')
        dist2 = (XX - cx) ** 2 + (YY - cy) ** 2
        mask = dist2 <= radius * radius

        region = self.voxels[x0:x1, y0:y1]
        solid_mask = mask & (region != materials.AIR)

        destroyed = []
        coords = np.argwhere(solid_mask)
        for lx, ly in coords:
            destroyed.append((x0 + lx, y0 + ly, int(region[lx, ly])))
        region[solid_mask] = materials.AIR

        # Mark chunks dirty
        chx0 = max(0, x0 // config.CHUNK_SIZE - 1)
        chy0 = max(0, y0 // config.CHUNK_SIZE - 1)
        chx1 = min(self.cw, (x1 - 1) // config.CHUNK_SIZE + 2)
        chy1 = min(self.ch, (y1 - 1) // config.CHUNK_SIZE + 2)
        self.chunk_dirty[chx0:chx1, chy0:chy1] = True

        return destroyed

    def count_material(self, material):
        """Count voxels of a given material."""
        return int(np.sum(self.voxels == material))
