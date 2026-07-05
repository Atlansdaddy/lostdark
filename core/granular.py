"""
Granular physics - sand flows like slow fluid, dirt crumbles at edges.
Vectorized numpy - no Python per-cell loops.

Sand: falls with gravity, flows diagonally, piles at angle of repose.
      Behaves like Noita-style falling sand. Displaces into air below,
      diagonal-below, and spreads laterally under pressure.

Dirt: stable when supported, but unsupported edges crumble away.
      Interior dirt stays put. Edge dirt with air on 2+ sides falls.
"""
import numpy as np
from .. import config, materials


class GranularSim:
    """
    Granular material simulation for sand and dirt.
    Sand flows freely. Dirt crumbles at edges only.
    All operations vectorized via numpy.
    """

    def __init__(self):
        self._rng = np.random.default_rng(seed=77)
        self._frame = 0

    def update(self, grid, dt):
        """
        Run one frame of granular physics.
        Sand: gravity + diagonal flow + lateral spread.
        Dirt: edge crumble only.
        """
        self._frame += 1
        voxels = grid.voxels
        W, H = grid.w, grid.h
        changed = False

        # --- SAND PHYSICS ---
        changed |= self._update_sand(voxels, W, H)

        # --- DIRT PHYSICS ---
        changed |= self._update_dirt(voxels, W, H)

        if changed:
            grid.mark_all_dirty()

        return changed

    def _update_sand(self, voxels, W, H):
        """
        Sand falls, flows diagonally, piles naturally.
        Process bottom-to-top so sand cascades in one frame.
        Vectorized per-row.
        """
        changed = False

        # --- Pass 1: Gravity (fall straight down) ---
        # Process rows bottom-to-top
        for y in range(H - 2, -1, -1):
            sand_row = voxels[:, y] == materials.SAND
            if not np.any(sand_row):
                continue

            air_below = voxels[:, y + 1] == materials.AIR
            can_fall = sand_row & air_below

            if np.any(can_fall):
                xs = np.where(can_fall)[0]
                voxels[xs, y] = materials.AIR
                voxels[xs, y + 1] = materials.SAND
                changed = True

        # --- Pass 2: Diagonal flow (sand slides off edges) ---
        # Alternate left-right bias each frame to prevent directional drift
        go_right_first = (self._frame % 2) == 0

        for y in range(H - 2, -1, -1):
            sand_row = voxels[:, y] == materials.SAND
            if not np.any(sand_row):
                continue

            # Only sand that's sitting on something (not still falling)
            supported = (voxels[:, y + 1] != materials.AIR)
            settled_sand = sand_row & supported

            if not np.any(settled_sand):
                continue

            # Check diagonal-below-right: air at (x+1, y+1) AND air at (x+1, y)
            diag_right = np.zeros(W, dtype=bool)
            diag_right[:-1] = (settled_sand[:-1] &
                               (voxels[1:, y + 1] == materials.AIR) &
                               (voxels[1:, y] == materials.AIR))

            # Check diagonal-below-left: air at (x-1, y+1) AND air at (x-1, y)
            diag_left = np.zeros(W, dtype=bool)
            diag_left[1:] = (settled_sand[1:] &
                             (voxels[:-1, y + 1] == materials.AIR) &
                             (voxels[:-1, y] == materials.AIR))

            # Both available - randomly pick (stochastic for natural look)
            both = diag_left & diag_right
            if np.any(both):
                both_xs = np.where(both)[0]
                # Alternate bias + randomness
                if go_right_first:
                    go_right = self._rng.random(len(both_xs)) < 0.55
                else:
                    go_right = self._rng.random(len(both_xs)) < 0.45
                right_xs = both_xs[go_right]
                left_xs = both_xs[~go_right]

                if len(right_xs) > 0:
                    voxels[right_xs, y] = materials.AIR
                    voxels[right_xs + 1, y + 1] = materials.SAND
                    changed = True
                    # Clear from diag_left/right so we don't double-move
                    diag_right[right_xs] = False
                    diag_left[right_xs] = False

                if len(left_xs) > 0:
                    voxels[left_xs, y] = materials.AIR
                    voxels[left_xs - 1, y + 1] = materials.SAND
                    changed = True
                    diag_right[left_xs] = False
                    diag_left[left_xs] = False

            # Only right available
            only_right = diag_right & ~diag_left
            if np.any(only_right):
                xs = np.where(only_right)[0]
                voxels[xs, y] = materials.AIR
                voxels[xs + 1, y + 1] = materials.SAND
                changed = True

            # Only left available
            only_left = diag_left & ~diag_right
            if np.any(only_left):
                xs = np.where(only_left)[0]
                voxels[xs, y] = materials.AIR
                voxels[xs - 1, y + 1] = materials.SAND
                changed = True

        # --- Pass 3: Lateral spread under pressure ---
        # Sand stacked 3+ high pushes bottom sideways (rate-limited)
        if self._frame % 3 == 0:  # every 3rd frame to save perf
            sand = voxels == materials.SAND
            # Find sand with sand above AND sand above that (3 high stack)
            stacked = np.zeros_like(sand)
            stacked[:, 2:] = sand[:, 2:] & sand[:, 1:-1] & sand[:, :-2]

            if np.any(stacked):
                positions = np.argwhere(stacked)
                # Rate limit to ~20% for natural look
                mask = self._rng.random(len(positions)) < 0.2
                positions = positions[mask]

                for x, y in positions:
                    # Try to push sideways
                    if x > 0 and voxels[x - 1, y] == materials.AIR:
                        voxels[x, y] = materials.AIR
                        voxels[x - 1, y] = materials.SAND
                        changed = True
                    elif x < W - 1 and voxels[x + 1, y] == materials.AIR:
                        voxels[x, y] = materials.AIR
                        voxels[x + 1, y] = materials.SAND
                        changed = True

        return changed

    def _update_dirt(self, voxels, W, H):
        """
        Dirt is stable when supported but crumbles at exposed edges.
        An edge = dirt with air on 2+ cardinal sides AND air below-diagonal.
        Rate-limited for gradual crumble effect.
        """
        # Only run every 4th frame (dirt crumbles slowly)
        if self._frame % 4 != 0:
            return False

        changed = False

        dirt = voxels == materials.DIRT
        if not np.any(dirt):
            return False

        # Count air neighbors (cardinal directions)
        air = voxels == materials.AIR
        air_neighbors = np.zeros_like(dirt, dtype=np.int8)

        # Up
        air_neighbors[:, 1:] += air[:, :-1]
        # Down
        air_neighbors[:, :-1] += air[:, 1:]
        # Left
        air_neighbors[1:, :] += air[:-1, :]
        # Right
        air_neighbors[:-1, :] += air[1:, :]

        # Edge dirt: 2+ air neighbors = exposed
        exposed = dirt & (air_neighbors >= 2)

        # Must also have air below OR air diagonal-below (somewhere to fall)
        can_fall = np.zeros_like(exposed)
        # Air directly below
        can_fall[:, :-1] |= exposed[:, :-1] & air[:, 1:]
        # Air diagonal below-left
        can_fall[1:, :-1] |= exposed[1:, :-1] & air[:-1, 1:]
        # Air diagonal below-right
        can_fall[:-1, :-1] |= exposed[:-1, :-1] & air[1:, 1:]

        if not np.any(can_fall):
            return False

        # Rate limit: only ~15% of crumble candidates per tick
        positions = np.argwhere(can_fall)
        mask = self._rng.random(len(positions)) < 0.15
        positions = positions[mask]

        for x, y in positions:
            if voxels[x, y] != materials.DIRT:
                continue  # already moved by earlier iteration

            # Try to fall: straight down first, then diagonal
            if y + 1 < H and voxels[x, y + 1] == materials.AIR:
                voxels[x, y] = materials.AIR
                voxels[x, y + 1] = materials.DIRT
                changed = True
            elif x > 0 and y + 1 < H and voxels[x - 1, y + 1] == materials.AIR:
                voxels[x, y] = materials.AIR
                voxels[x - 1, y + 1] = materials.DIRT
                changed = True
            elif x + 1 < W and y + 1 < H and voxels[x + 1, y + 1] == materials.AIR:
                voxels[x, y] = materials.AIR
                voxels[x + 1, y + 1] = materials.DIRT
                changed = True

        return changed

    def reset(self):
        """Clear granular state."""
        self._frame = 0
