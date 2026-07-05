"""
Finite water simulation - water MOVES, never duplicates.
Water falls fast, spreads laterally to level out, pools in depressions.
Key difference from sand: water LEVELS OUT (seeks flat surface), sand PILES UP.
"""
import numpy as np
from .. import config, materials


class WaterSim:
    """
    Finite water: placed water cells fall and settle.
    No reproduction - only movement.
    - Gravity: water falls into air below (fast, every frame)
    - Leveling: water flows sideways to equalize surface height
    - Pressure: deep water pushes outward aggressively

    Unlike sand which piles, water always seeks the lowest flat surface.
    """

    def __init__(self):
        self._rng = np.random.default_rng(seed=123)
        self._frame = 0

    def update(self, grid, dt):
        """
        Update water simulation. Water only MOVES, never duplicates.
        """
        self._frame += 1
        voxels = grid.voxels
        W, H = grid.w, grid.h

        water = voxels == materials.WATER
        if not np.any(water):
            return

        changed = False

        # --- GRAVITY: water falls down (fast - all at once) ---
        for y in range(H - 2, -1, -1):
            water_row = voxels[:, y] == materials.WATER
            if not np.any(water_row):
                continue
            air_below = voxels[:, y + 1] == materials.AIR
            can_fall = water_row & air_below
            if np.any(can_fall):
                xs = np.where(can_fall)[0]
                voxels[xs, y] = materials.AIR
                voxels[xs, y + 1] = materials.WATER
                changed = True

        # --- LATERAL LEVELING: water spreads sideways aggressively ---
        # This is what makes water WATER and not sand.
        # Water on a flat surface flows sideways even without a drop.
        # Process multiple passes for fast spreading.
        for _pass in range(3):  # 3 passes = spreads 3 cells per frame
            water = voxels == materials.WATER  # refresh
            for y in range(H - 1, -1, -1):
                water_row = water[:, y]
                if not np.any(water_row):
                    continue

                # Water must be supported (solid or water below, or at bottom)
                if y < H - 1:
                    supported = (voxels[:, y + 1] != materials.AIR)
                else:
                    supported = np.ones(W, dtype=bool)

                settled = water_row & supported
                if not np.any(settled):
                    continue

                # Flow right: air to the right (don't need air below-right!)
                # This is the key difference from sand - water flows flat
                flow_right = np.zeros(W, dtype=bool)
                flow_right[:-1] = (settled[:-1] &
                                   (voxels[1:, y] == materials.AIR))

                # But only if there's support for where it's going
                # (solid or water below the destination, or it'll fall next frame)
                if y < H - 1:
                    dest_supported_right = np.zeros(W, dtype=bool)
                    dest_supported_right[:-1] = (voxels[1:, y + 1] != materials.AIR)
                    flow_right &= dest_supported_right
                # else: bottom row, always supported

                # Flow left
                flow_left = np.zeros(W, dtype=bool)
                flow_left[1:] = (settled[1:] &
                                 (voxels[:-1, y] == materials.AIR))

                if y < H - 1:
                    dest_supported_left = np.zeros(W, dtype=bool)
                    dest_supported_left[1:] = (voxels[:-1, y + 1] != materials.AIR)
                    flow_left &= dest_supported_left

                # Both available - alternate direction bias
                both = flow_left & flow_right
                if np.any(both):
                    both_xs = np.where(both)[0]
                    go_right = self._rng.random(len(both_xs)) < 0.5
                    right_xs = both_xs[go_right]
                    left_xs = both_xs[~go_right]

                    if len(right_xs) > 0:
                        voxels[right_xs, y] = materials.AIR
                        voxels[right_xs + 1, y] = materials.WATER
                        changed = True
                        flow_right[right_xs] = False
                        flow_left[right_xs] = False

                    if len(left_xs) > 0:
                        voxels[left_xs, y] = materials.AIR
                        voxels[left_xs - 1, y] = materials.WATER
                        changed = True
                        flow_right[left_xs] = False
                        flow_left[left_xs] = False

                # Only right
                only_right = flow_right & ~flow_left
                if np.any(only_right):
                    xs = np.where(only_right)[0]
                    voxels[xs, y] = materials.AIR
                    voxels[xs + 1, y] = materials.WATER
                    changed = True

                # Only left
                only_left = flow_left & ~flow_right
                if np.any(only_left):
                    xs = np.where(only_left)[0]
                    voxels[xs, y] = materials.AIR
                    voxels[xs - 1, y] = materials.WATER
                    changed = True

        # --- DIAGONAL FLOW: water flows around corners ---
        # If water is settled and there's air diagonal-below, flow there
        water = voxels == materials.WATER
        for y in range(H - 2, -1, -1):
            water_row = water[:, y]
            if not np.any(water_row):
                continue

            supported = (voxels[:, y + 1] != materials.AIR)
            settled = water_row & supported
            if not np.any(settled):
                continue

            # Diagonal right: air at (x+1,y) AND air at (x+1,y+1)
            diag_right = np.zeros(W, dtype=bool)
            diag_right[:-1] = (settled[:-1] &
                               (voxels[1:, y] == materials.AIR) &
                               (voxels[1:, y + 1] == materials.AIR))

            # Diagonal left
            diag_left = np.zeros(W, dtype=bool)
            diag_left[1:] = (settled[1:] &
                             (voxels[:-1, y] == materials.AIR) &
                             (voxels[:-1, y + 1] == materials.AIR))

            # Rate limit diagonal (50% chance)
            if np.any(diag_right):
                xs = np.where(diag_right)[0]
                mask = self._rng.random(len(xs)) < 0.5
                xs = xs[mask]
                if len(xs) > 0:
                    voxels[xs, y] = materials.AIR
                    voxels[xs + 1, y + 1] = materials.WATER
                    changed = True

            if np.any(diag_left):
                xs = np.where(diag_left)[0]
                mask = self._rng.random(len(xs)) < 0.5
                xs = xs[mask]
                if len(xs) > 0:
                    voxels[xs, y] = materials.AIR
                    voxels[xs - 1, y + 1] = materials.WATER
                    changed = True

        # --- PRESSURE: deep water pushes outward ---
        if self._frame % 2 == 0:
            water = voxels == materials.WATER
            # Find water with water above (stacked)
            stacked = np.zeros_like(water)
            stacked[:, 1:] = water[:, 1:] & water[:, :-1]

            if np.any(stacked):
                positions = np.argwhere(stacked)
                mask = self._rng.random(len(positions)) < 0.3
                positions = positions[mask]

                for x, y in positions:
                    if voxels[x, y] != materials.WATER:
                        continue
                    if x > 0 and voxels[x - 1, y] == materials.AIR:
                        voxels[x, y] = materials.AIR
                        voxels[x - 1, y] = materials.WATER
                        changed = True
                    elif x < W - 1 and voxels[x + 1, y] == materials.AIR:
                        voxels[x, y] = materials.AIR
                        voxels[x + 1, y] = materials.WATER
                        changed = True

        if changed:
            grid.mark_all_dirty()

    def reset(self):
        """Clear water state."""
        self._frame = 0
