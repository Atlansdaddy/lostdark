"""UI overlay layer: HUD, mode indicator, material swatch, telemetry."""
import pygame
import numpy as np
from ... import config, materials


class UILayer:
    """Renders HUD elements on top of everything."""

    def __init__(self):
        self.font = pygame.font.SysFont('consolas', 14)
        self.font_small = pygame.font.SysFont('consolas', 12)
        self.show_telemetry = False

    def render(self, screen, mode, material_id, block_index,
               grid_x, grid_y, timings=None, fps=0.0,
               wave_backend='numpy', wave_substeps=4,
               particle_count=0, particle_max=0,
               destroyed_count=0, bloom_enabled=True,
               wave_energy=0.0, player_pos=None,
               level_name=None, level_hint=None, level_complete=False,
               player_health=5, player_max_health=5,
               wave_type=0):
        """Render all UI elements."""
        self._render_hud(screen, mode, material_id, block_index, wave_type)
        self._render_health(screen, player_health, player_max_health)
        self._render_block_preview(screen, grid_x, grid_y, block_index)
        self._render_controls(screen)

        if level_name:
            self._render_level_info(screen, level_name, level_hint, level_complete)

        if self.show_telemetry and timings:
            self._render_telemetry(
                screen, timings, fps, wave_backend, wave_substeps,
                particle_count, particle_max, destroyed_count,
                bloom_enabled, wave_energy, player_pos,
            )

    def _render_hud(self, screen, mode, material_id, block_index, wave_type=0):
        """Mode, material, block size, wave type indicator."""
        mat_name = materials.NAMES[material_id]
        mat_color = materials.COLORS[material_id]
        bw, bh, bname = config.BLOCK_SIZES[block_index]
        wave_name = "SONAR" if wave_type == 0 else "FORCE"
        wave_color = (40, 180, 255) if wave_type == 0 else (255, 120, 30)

        text = f"{mode} | {mat_name} | {bname} ({bw}x{bh})"
        surf = self.font.render(text, True, (255, 255, 255))
        screen.blit(surf, (10, 10))

        # Wave type indicator (right side of HUD)
        wt_surf = self.font.render(f"[Q] {wave_name}", True, wave_color)
        screen.blit(wt_surf, (config.SCREEN_W - wt_surf.get_width() - 10, 10))

        # Color swatch
        pygame.draw.rect(screen, mat_color, (10, 30, 20, 20))
        pygame.draw.rect(screen, (255, 255, 255), (10, 30, 20, 20), 1)

        # Material hotbar
        x = 40
        for i in range(1, materials.NUM_MATERIALS):
            c = materials.COLORS[i]
            rect = pygame.Rect(x, 30, 16, 16)
            pygame.draw.rect(screen, c, rect)
            if i == material_id:
                pygame.draw.rect(screen, (255, 255, 255), rect, 2)
            else:
                pygame.draw.rect(screen, (80, 80, 80), rect, 1)

            # Key number
            num_surf = self.font_small.render(str(i), True, (200, 200, 200))
            screen.blit(num_surf, (x + 4, 47))
            x += 20

    def _render_health(self, screen, health, max_health):
        """Render health pips below the HUD bar."""
        x_start = 10
        y = 55
        pip_radius = 4
        spacing = 12
        for i in range(max_health):
            cx = x_start + i * spacing + pip_radius
            if i < health:
                pygame.draw.circle(screen, (80, 220, 100), (cx, y), pip_radius)
            else:
                pygame.draw.circle(screen, (60, 60, 60), (cx, y), pip_radius, 1)

    def _render_block_preview(self, screen, grid_x, grid_y, block_index):
        """Cursor preview: crosshair for 1x1, rectangle outline for larger."""
        # Use raw mouse position for screen-space preview (camera-independent)
        sx, sy = pygame.mouse.get_pos()
        bw, bh, _ = config.BLOCK_SIZES[block_index]

        if bw == 1 and bh == 1:
            # Crosshair cursor
            size = 6
            color = (255, 255, 255)
            pygame.draw.line(screen, color, (sx - size, sy), (sx + size, sy), 1)
            pygame.draw.line(screen, color, (sx, sy - size), (sx, sy + size), 1)
        else:
            # Rectangle outline matching block dimensions
            pw = bw * config.PIXEL_SCALE
            ph = bh * config.PIXEL_SCALE
            rect = pygame.Rect(sx - pw // 2, sy - ph // 2, pw, ph)
            pygame.draw.rect(screen, (255, 255, 255), rect, 1)

    def _render_controls(self, screen):
        """Controls hint at bottom."""
        hint = "WASD:Move  Q:Sonar/Force  LMB:Scan/Blast  RMB:Remove  MMB:Force Blast  Tab:Mode  Space:Hold  Shift:Dash  R:Reset  F3:Stats"
        surf = self.font_small.render(hint, True, (120, 120, 120))
        screen.blit(surf, (10, config.SCREEN_H - 18))

    def _render_level_info(self, screen, name, hint, complete):
        """Level name, objective hint, and completion message."""
        # Level name (top center)
        name_surf = self.font.render(name, True, (200, 220, 255))
        nx = (config.SCREEN_W - name_surf.get_width()) // 2
        screen.blit(name_surf, (nx, 10))

        # Objective hint (below name)
        if hint and not complete:
            hint_surf = self.font_small.render(hint, True, (140, 160, 180))
            hx = (config.SCREEN_W - hint_surf.get_width()) // 2
            screen.blit(hint_surf, (hx, 28))

        # Completion message
        if complete:
            comp_surf = self.font.render("Level Complete!", True, (100, 255, 100))
            cx = (config.SCREEN_W - comp_surf.get_width()) // 2
            cy = config.SCREEN_H // 2 - 20
            screen.blit(comp_surf, (cx, cy))

    def _render_telemetry(self, screen, timings, fps, backend, substeps,
                          p_count, p_max, destroyed, bloom_on, wave_e,
                          player_pos=None):
        """Per-system timing breakdown."""
        bloom_str = "ON" if bloom_on else "OFF"
        lines = [
            f"FPS: {fps:.0f} | Bloom: {bloom_str}",
            f"INPUT:{timings.get('input',0):.1f} PHYS:{timings.get('physics',0):.1f} DEST:{timings.get('destruct',0):.1f} PART:{timings.get('particles',0):.1f} RENDER:{timings.get('render',0):.1f}ms",
            f"Grid: {config.GRID_W}x{config.GRID_H} | {backend} | Sub:{substeps}",
            f"Particles: {p_count}/{p_max} | Wave E: {wave_e:.0f} | Broke: {destroyed}",
        ]
        if player_pos:
            lines.append(f"Player: ({player_pos[0]:.0f}, {player_pos[1]:.0f})")

        y = config.SCREEN_H - 18 - len(lines) * 16 - 6
        for line in lines:
            surf = self.font_small.render(line, True, (0, 255, 0))
            screen.blit(surf, (10, y))
            y += 16
