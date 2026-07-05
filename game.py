"""
Main game class: init, main loop, shutdown, frame telemetry.
Entry point with level progression, adaptive perf, and clean architecture.
"""
import os
import sys
import time
import pygame
import numpy as np
from . import config, materials
from .systems.input_system import InputSystem
from .scenes.sandbox_scene import SandboxScene
from .scenes.demo_scenes import DEMO_BUILDERS
from .rendering.layers.ui_layer import UILayer
from .levels import LevelManager


# Seconds to show "Level Complete!" before advancing
LEVEL_TRANSITION_DELAY = 2.5


class Game:
    """Main game shell."""

    def __init__(self):
        # Parse CLI flags
        self.use_torch = None
        if '--force-cpu' in sys.argv:
            self.use_torch = False
        elif '--force-gpu' in sys.argv:
            self.use_torch = True

        # Check for demo scene
        self.demo_name = None
        for arg in sys.argv[1:]:
            if arg.startswith('--demo='):
                self.demo_name = arg.split('=', 1)[1]

    def _create_scene(self, level=None):
        """Create a new scene, optionally for a specific level."""
        scene = SandboxScene(use_torch=self.use_torch, level=level)
        scene.on_enter()
        return scene

    def run(self):
        """Main game loop."""
        pygame.init()

        # Detect native resolution and configure display
        config.init_display()

        # Borderless windowed (looks like fullscreen but allows screenshots)
        if config.FULLSCREEN:
            screen = pygame.display.set_mode(
                (config.SCREEN_W, config.SCREEN_H),
                pygame.NOFRAME | pygame.HWSURFACE | pygame.DOUBLEBUF,
            )
        else:
            screen = pygame.display.set_mode((config.SCREEN_W, config.SCREEN_H))
        pygame.display.set_caption("wAIver")
        pygame.mouse.set_visible(False)
        clock = pygame.time.Clock()

        # Systems
        input_sys = InputSystem()
        ui = UILayer()

        # Level manager
        level_mgr = LevelManager()

        # Load demo scene if requested, otherwise start level 1
        if self.demo_name and self.demo_name in DEMO_BUILDERS:
            scene = self._create_scene()
            name, builder = DEMO_BUILDERS[self.demo_name]
            scene.grid.clear()
            builder(scene.grid)
            scene.physics.terrain_changed()
            # Re-spawn player in valid position for this demo terrain
            scene.player.find_spawn(scene.grid.voxels)
            scene.camera.snap_to(scene.player)
            pygame.display.set_caption(f"wAIver - {name}")
        else:
            level = level_mgr.current_level()
            scene = self._create_scene(level=level)
            if level:
                pygame.display.set_caption(f"wAIver - {level.name}")

        # Timing
        timings = {}

        running = True
        while running:
            frame_start = time.perf_counter()
            dt = clock.get_time() / 1000.0
            dt = min(dt, 0.05)

            # --- INPUT ---
            t0 = time.perf_counter()
            inp = input_sys.process()
            timings['input'] = (time.perf_counter() - t0) * 1000

            if inp.quit:
                running = False
                continue

            if inp.toggle_telemetry:
                ui.show_telemetry = not ui.show_telemetry

            # --- UPDATE ---
            t0 = time.perf_counter()
            scene.update(dt, inp)
            timings['physics'] = (time.perf_counter() - t0) * 1000

            # (Split timing for destruction/particles from physics in telemetry)
            timings['destruct'] = 0
            timings['particles'] = 0

            # --- LEVEL TRANSITION ---
            if scene.level_complete and scene._complete_timer >= LEVEL_TRANSITION_DELAY:
                if level_mgr.advance():
                    level = level_mgr.current_level()
                    scene = self._create_scene(level=level)
                    pygame.display.set_caption(f"wAIver - {level.name}")
                else:
                    # All levels done - restart from level 1
                    level_mgr.current_index = 0
                    level = level_mgr.current_level()
                    scene = self._create_scene(level=level)
                    pygame.display.set_caption(f"wAIver - {level.name}")

            # --- RENDER ---
            t0 = time.perf_counter()
            scene.render(screen)
            timings['render'] = (time.perf_counter() - t0) * 1000

            # --- UI ---
            fps = clock.get_fps()
            # Level info for UI
            level_name = None
            level_hint = None
            level_complete = False
            if scene.level:
                level_name = scene.level.name
                level_hint = scene.level.get_hint()
                level_complete = scene.level_complete

            ui.render(
                screen,
                mode=scene.mode,
                material_id=scene.current_material,
                block_index=scene.block_index,
                grid_x=inp.grid_x,
                grid_y=inp.grid_y,
                timings=timings,
                fps=fps,
                wave_backend="torch/CUDA" if scene.physics.wave._use_torch else "numpy/CPU",
                wave_substeps=scene.physics.wave.substeps,
                particle_count=scene.physics.particles.count,
                particle_max=scene.physics.particles.max,
                destroyed_count=scene.physics.destroyed_count,
                bloom_enabled=scene.renderer.bloom.enabled,
                wave_energy=float(np.sum(scene.physics.wave.u ** 2)),
                player_pos=(scene.player.x, scene.player.y),
                level_name=level_name,
                level_hint=level_hint,
                level_complete=level_complete,
                player_health=scene.player.health,
                player_max_health=scene.player.max_health,
                wave_type=getattr(scene, 'wave_type', 0),
            )

            # --- SCREENSHOT (F12) ---
            if inp.screenshot:
                try:
                    ss_dir = os.path.join(os.path.dirname(__file__), '..', 'screenshots')
                    os.makedirs(ss_dir, exist_ok=True)
                    ts = time.strftime('%Y%m%d_%H%M%S')
                    ss_path = os.path.abspath(os.path.join(ss_dir, f'waiver_{ts}.png'))
                    pygame.image.save(screen, ss_path)
                    print(f'[Screenshot] Saved: {ss_path}')
                except Exception as e:
                    print(f'[Screenshot] FAILED: {e}')

            # --- ADAPTIVE PERFORMANCE ---
            if fps > 0 and fps < config.ADAPTIVE_LOW_FPS:
                scene.renderer.bloom.enabled = False
            elif fps > config.TARGET_FPS - 5:
                scene.renderer.bloom.enabled = True
            if fps > 0 and fps < config.ADAPTIVE_CRITICAL_FPS:
                scene.physics.wave.substeps = 2
            else:
                scene.physics.wave.substeps = config.WAVE_SUBSTEPS

            pygame.display.flip()
            clock.tick(config.TARGET_FPS)

        pygame.quit()
