"""
Water rendering layer — Valheim-style contrast.
Everything else is voxels. Water is SMOOTH and REAL.
Renders water as smooth filled polygons with animated surface,
not as individual cells. The voxel grid is just data —
the rendering traces smooth contours over it.

Multi-pass rendering:
1. Deep body fill (dark blue-black, opaque)
2. Mid-depth gradient (dark teal)
3. Shallow/surface gradient (bright blue-cyan)
4. Animated surface line (bright cyan + white shimmer)
5. Internal caustic ripples (animated light bands)
6. Edge foam where water meets walls
7. Wave-reactive surface displacement
"""
import math
import numpy as np
import pygame
from ... import config, materials


class WaterLayer:
    """
    Smooth water rendering over voxel grid.
    Multi-layered rendering for depth, motion, and life:
    - Smooth polygon body with 3-band depth gradient
    - Animated sine-wave surface with foam line
    - Internal caustic light ripples
    - Wave-physics reactive surface bobbing
    - Edge foam/spray at terrain contact
    """

    def __init__(self):
        # Render directly at screen res for smooth curves
        self.surface = pygame.Surface(
            (config.SCREEN_W, config.SCREEN_H), pygame.SRCALPHA
        )
        # Secondary surface for caustic overlay
        self._caustic_surf = pygame.Surface(
            (config.SCREEN_W, config.SCREEN_H), pygame.SRCALPHA
        )
        self._time = 0.0
        self._frame = 0

    def render(self, screen, voxels, wave_u=None, illumination=None,
               view_x=0, view_y=0):
        """Render smooth water."""
        self._frame += 1
        self._time += 1.0 / 60.0

        # Extract visible portion
        x1 = max(0, view_x)
        y1 = max(0, view_y)
        x2 = min(config.GRID_W, view_x + config.VIEW_W)
        y2 = min(config.GRID_H, view_y + config.VIEW_H)

        vw = voxels[x1:x2, y1:y2]
        water = vw == materials.WATER

        if not np.any(water):
            return

        W, H = vw.shape
        PS = config.PIXEL_SCALE  # grid cell to screen pixel

        self.surface.fill((0, 0, 0, 0))  # clear transparent

        # Get wave data for this view if available
        wave_view = None
        if wave_u is not None:
            wave_view = wave_u[x1:x2, y1:y2]

        # Find connected water bodies
        bodies = self._find_water_bodies(water, W, H)

        for body in bodies:
            self._render_body(screen, body, water, wave_view, illumination,
                              x1, y1, W, H, PS, view_x, view_y, vw)

    def _find_water_bodies(self, water, W, H):
        """
        Find connected water regions using column segment merging.
        Returns list of bodies, each body is a list of (col, y_top, y_bot) tuples.
        """
        col_segments = {}
        for col in range(W):
            col_water = water[col, :]
            if not np.any(col_water):
                continue
            ys = np.where(col_water)[0]
            if len(ys) == 0:
                continue
            # Find contiguous runs
            segments = []
            start = ys[0]
            for i in range(1, len(ys)):
                if ys[i] != ys[i - 1] + 1:
                    segments.append((start, ys[i - 1]))
                    start = ys[i]
            segments.append((start, ys[-1]))
            col_segments[col] = segments

        if not col_segments:
            return []

        # Merge segments from adjacent columns that overlap in y
        # Use union-find for correct multi-column body merging
        segment_keys = []
        seg_index = {}
        for col in sorted(col_segments.keys()):
            for seg in col_segments[col]:
                key = (col, seg[0], seg[1])
                seg_index[key] = len(segment_keys)
                segment_keys.append(key)

        # Union-find
        parent = list(range(len(segment_keys)))

        def find(x):
            while parent[x] != x:
                parent[x] = parent[parent[x]]
                x = parent[x]
            return x

        def union(a, b):
            ra, rb = find(a), find(b)
            if ra != rb:
                parent[ra] = rb

        # Connect adjacent column segments that overlap
        for col in sorted(col_segments.keys()):
            if col - 1 not in col_segments:
                continue
            for seg in col_segments[col]:
                key = (col, seg[0], seg[1])
                idx = seg_index[key]
                for prev_seg in col_segments[col - 1]:
                    # Overlap check
                    if seg[0] <= prev_seg[1] and seg[1] >= prev_seg[0]:
                        prev_key = (col - 1, prev_seg[0], prev_seg[1])
                        prev_idx = seg_index[prev_key]
                        union(idx, prev_idx)

        # Collect bodies
        body_map = {}
        for i, key in enumerate(segment_keys):
            root = find(i)
            if root not in body_map:
                body_map[root] = []
            body_map[root].append(key)

        return list(body_map.values())

    def _render_body(self, screen, body_segments, water, wave_view, illumination,
                     x1, y1, W, H, PS, view_x, view_y, voxels):
        """
        Render a single water body with multi-pass depth + animation.
        """
        if not body_segments:
            return

        # Sort by column
        body_segments.sort(key=lambda s: s[0])

        # Build column profiles
        col_to_top = {}
        col_to_bottom = {}
        for col, y_top, y_bot in body_segments:
            if col not in col_to_top or y_top < col_to_top[col]:
                col_to_top[col] = y_top
            if col not in col_to_bottom or y_bot > col_to_bottom[col]:
                col_to_bottom[col] = y_bot

        if not col_to_top:
            return

        cols = sorted(col_to_top.keys())
        min_col = cols[0]
        max_col = cols[-1]
        body_width = max_col - min_col

        if body_width < 1:
            # Tiny water: single column, simple rect
            col = cols[0]
            sx = (col - (view_x - x1)) * PS
            sy_top = (col_to_top[col] - (view_y - y1)) * PS
            sy_bot = (col_to_bottom[col] + 1 - (view_y - y1)) * PS
            pygame.draw.rect(self.surface, (15, 60, 180, 180),
                             (sx, sy_top, PS, sy_bot - sy_top))
            screen.blit(self.surface, (0, 0))
            return

        # Overall body height for depth calculations
        global_top = min(col_to_top.get(c, 999) for c in cols)
        global_bot = max(col_to_bottom.get(c, 0) for c in cols)
        body_height = max(1, global_bot - global_top + 1)

        # ============================================================
        # Pass 1: Build smooth surface profile with wave reactivity
        # ============================================================
        top_points = []
        for col in range(min_col, max_col + 1):
            if col in col_to_top:
                base_y = float(col_to_top[col])
            else:
                # Interpolate from neighbors
                prev = max(c for c in cols if c < col) if any(c < col for c in cols) else cols[0]
                nxt = min(c for c in cols if c > col) if any(c > col for c in cols) else cols[-1]
                t = (col - prev) / max(1, nxt - prev)
                base_y = col_to_top.get(prev, 0) * (1 - t) + col_to_top.get(nxt, 0) * t

            # Multi-frequency animated sine wave for organic surface motion
            wave_a = math.sin(col * 0.35 + self._time * 2.8) * 0.35
            wave_b = math.sin(col * 0.12 + self._time * 1.5 + 1.0) * 0.25
            wave_c = math.sin(col * 0.7 + self._time * 4.5) * 0.1
            wave_offset = wave_a + wave_b + wave_c

            # React to actual wave physics if available
            if wave_view is not None and 0 <= col < W:
                y_idx = int(base_y)
                if 0 <= y_idx < H:
                    physics_wave = float(wave_view[col, y_idx])
                    wave_offset += physics_wave * 0.5  # wave energy displaces surface

            sx = (col - (view_x - x1)) * PS + PS // 2
            sy = (base_y + wave_offset - (view_y - y1)) * PS

            top_points.append((sx, sy))

        # Bottom edge (reverse order for closed polygon)
        bottom_points = []
        for col in range(max_col, min_col - 1, -1):
            if col in col_to_bottom:
                base_y = col_to_bottom[col] + 1
            else:
                prev = max(c for c in cols if c < col) if any(c < col for c in cols) else cols[0]
                nxt = min(c for c in cols if c > col) if any(c > col for c in cols) else cols[-1]
                t = (col - prev) / max(1, nxt - prev)
                base_y = col_to_bottom.get(prev, 0) * (1 - t) + col_to_bottom.get(nxt, 0) * t + 1

            sx = (col - (view_x - x1)) * PS + PS // 2
            sy = (base_y - (view_y - y1)) * PS

            bottom_points.append((sx, sy))

        polygon = top_points + bottom_points
        if len(polygon) < 3:
            return

        # ============================================================
        # Pass 2: Deep body fill (dark navy, high opacity)
        # ============================================================
        try:
            pygame.draw.polygon(self.surface, (8, 25, 80, 200), polygon)
        except (ValueError, TypeError):
            return

        # ============================================================
        # Pass 3: Depth gradient bands (3 layers: deep, mid, shallow)
        # ============================================================
        if body_height > 2:
            # --- Shallow zone: top 30% (brighter teal-blue) ---
            shallow_depth = body_height * 0.3
            shallow_top = []
            for col in range(min_col, max_col + 1):
                top_y = col_to_top.get(col, global_top)
                sx = (col - (view_x - x1)) * PS + PS // 2
                sy = (top_y - (view_y - y1)) * PS
                shallow_top.append((sx, sy))

            shallow_bottom = []
            for col in range(max_col, min_col - 1, -1):
                top_y = col_to_top.get(col, global_top)
                band_y = top_y + shallow_depth
                sx = (col - (view_x - x1)) * PS + PS // 2
                sy = (band_y - (view_y - y1)) * PS
                shallow_bottom.append((sx, sy))

            shallow_poly = shallow_top + shallow_bottom
            if len(shallow_poly) >= 3:
                try:
                    pygame.draw.polygon(self.surface, (25, 100, 200, 100), shallow_poly)
                except (ValueError, TypeError):
                    pass

            # --- Deep zone: bottom 40% (extra dark) ---
            if body_height > 5:
                deep_start = body_height * 0.6
                deep_top = []
                for col in range(min_col, max_col + 1):
                    top_y = col_to_top.get(col, global_top)
                    band_y = top_y + deep_start
                    sx = (col - (view_x - x1)) * PS + PS // 2
                    sy = (band_y - (view_y - y1)) * PS
                    deep_top.append((sx, sy))

                deep_poly = deep_top + bottom_points
                if len(deep_poly) >= 3:
                    try:
                        pygame.draw.polygon(self.surface, (4, 12, 50, 100), deep_poly)
                    except (ValueError, TypeError):
                        pass

        # ============================================================
        # Pass 4: Internal caustic light bands (animated wavy highlights)
        # ============================================================
        if body_height > 4 and body_width > 3:
            self._draw_caustics(body_width, body_height, min_col, max_col,
                                col_to_top, col_to_bottom, cols,
                                x1, y1, PS, view_x, view_y, W, H)

        # ============================================================
        # Pass 5: Surface highlight — animated bright line with shimmer
        # ============================================================
        if len(top_points) >= 2:
            # Thick bright surface line (cyan)
            pygame.draw.lines(self.surface, (60, 200, 255, 220), False, top_points, 4)
            # Slightly thinner lighter line on top
            pygame.draw.lines(self.surface, (120, 230, 255, 180), False, top_points, 2)

            # White specular shimmer — scattered bright dots on wave peaks
            for i, (sx, sy) in enumerate(top_points):
                shimmer = math.sin(i * 0.4 + self._time * 6.0) * 0.5 + 0.5
                if shimmer > 0.7:
                    bright = int(180 + shimmer * 75)
                    size = 2 if shimmer > 0.85 else 1
                    pygame.draw.circle(self.surface, (bright, bright, 255, 200),
                                       (int(sx), int(sy) - 1), size)

            # Foam line: slightly wider white glow just above surface
            foam_points = [(int(sx), int(sy) - 3) for sx, sy in top_points]
            if len(foam_points) >= 2:
                # Only draw foam segments where surface is "active"
                foam_segs = []
                for i, (fx, fy) in enumerate(foam_points):
                    activity = abs(math.sin(i * 0.3 + self._time * 3.5))
                    if activity > 0.5:
                        foam_segs.append((fx, fy))
                    else:
                        if len(foam_segs) >= 2:
                            pygame.draw.lines(self.surface, (220, 245, 255, 100),
                                              False, foam_segs, 1)
                        foam_segs = []
                if len(foam_segs) >= 2:
                    pygame.draw.lines(self.surface, (220, 245, 255, 100),
                                      False, foam_segs, 1)

        # ============================================================
        # Pass 6: Edge foam where water touches solid terrain
        # ============================================================
        self._draw_edge_foam(min_col, max_col, col_to_top, col_to_bottom,
                             cols, voxels, water, x1, y1, PS, view_x, view_y, W, H)

        # Blit water surface onto screen
        screen.blit(self.surface, (0, 0))

    def _draw_caustics(self, body_width, body_height, min_col, max_col,
                       col_to_top, col_to_bottom, cols,
                       x1, y1, PS, view_x, view_y, W, H):
        """Draw animated caustic light bands inside the water body."""
        # Draw 2-3 wavy light bands at different depths
        num_bands = min(3, body_height // 4)
        for band_idx in range(num_bands):
            depth_frac = 0.15 + band_idx * 0.25  # at 15%, 40%, 65% depth
            band_alpha = max(20, 60 - band_idx * 20)  # brighter near surface

            band_points = []
            for col in range(min_col, max_col + 1):
                top_y = col_to_top.get(col, min(col_to_top.values()))
                bot_y = col_to_bottom.get(col, max(col_to_bottom.values()))
                local_depth = bot_y - top_y + 1

                # Caustic wave pattern (different phase per band)
                cx_wave = (math.sin(col * 0.5 + self._time * 2.0 + band_idx * 2.1) * 0.4 +
                           math.sin(col * 0.25 + self._time * 1.2 + band_idx * 0.7) * 0.3)

                band_y = top_y + local_depth * depth_frac + cx_wave

                sx = (col - (view_x - x1)) * PS + PS // 2
                sy = (band_y - (view_y - y1)) * PS
                band_points.append((int(sx), int(sy)))

            if len(band_points) >= 2:
                # Caustic color: warm bright light filtering through water
                r = 80 + band_idx * 10
                g = 180 - band_idx * 30
                b = 255
                try:
                    pygame.draw.lines(self.surface, (r, g, b, band_alpha),
                                      False, band_points, 1)
                except (ValueError, TypeError):
                    pass

    def _draw_edge_foam(self, min_col, max_col, col_to_top, col_to_bottom,
                        cols, voxels, water, x1, y1, PS, view_x, view_y, W, H):
        """Draw foam/spray at edges where water meets solid terrain."""
        for col in cols:
            top_y = col_to_top[col]
            bot_y = col_to_bottom[col]

            # Check left and right neighbors for solid blocks
            for check_col in [col - 1, col + 1]:
                if 0 <= check_col < W:
                    for y in range(top_y, min(bot_y + 1, H)):
                        if not water[check_col, y]:
                            # Solid neighbor — draw foam dots along this edge
                            foam_x = check_col if check_col > col else col
                            sx = (foam_x - (view_x - x1)) * PS
                            sy = (y - (view_y - y1)) * PS

                            # Animated foam
                            foam_phase = math.sin(y * 0.8 + self._time * 4.0 + col * 0.3)
                            if foam_phase > 0.2:
                                alpha = int(80 + foam_phase * 80)
                                pygame.draw.circle(
                                    self.surface, (200, 230, 255, alpha),
                                    (int(sx + PS // 2), int(sy + PS // 2)),
                                    max(1, int(PS * 0.3))
                                )
                            break  # Only draw foam at topmost contact per column side
