"""Input system: converts raw pygame events to game actions."""
import pygame
from .. import config, materials


class InputState:
    """Current frame's input state."""
    __slots__ = (
        'quit', 'reset', 'toggle_mode', 'toggle_telemetry',
        'select_material', 'brush_delta',
        'lmb', 'rmb', 'mmb', 'space',
        'grid_x', 'grid_y', 'screen_x', 'screen_y',
        'move_left', 'move_right', 'jump', 'dash',
        'screenshot', 'toggle_wave_type',
    )

    def __init__(self):
        self.quit = False
        self.reset = False
        self.toggle_mode = False
        self.toggle_telemetry = False
        self.select_material = -1  # -1 = no change
        self.brush_delta = 0
        self.lmb = False
        self.rmb = False
        self.mmb = False
        self.space = False
        self.grid_x = 0
        self.grid_y = 0
        self.screen_x = 0
        self.screen_y = 0
        # Player movement
        self.move_left = False
        self.move_right = False
        self.jump = False
        self.dash = False
        self.screenshot = False
        self.toggle_wave_type = False  # Q toggles sonar/force


MATERIAL_KEYS = {
    pygame.K_1: materials.STONE,
    pygame.K_2: materials.GLASS,
    pygame.K_3: materials.METAL,
    pygame.K_4: materials.WOOD,
    pygame.K_5: materials.WATER,
    pygame.K_6: materials.SAND,
    pygame.K_7: materials.DIRT,
}


class InputSystem:
    """Processes pygame events into InputState."""

    def __init__(self):
        self._space_held = False
        self._jump_pressed = False
        self._dash_pressed = False

    def process(self):
        """Process all pending events. Returns InputState for this frame."""
        state = InputState()
        self._jump_pressed = False
        self._dash_pressed = False

        for event in pygame.event.get():
            if event.type == pygame.QUIT:
                state.quit = True
            elif event.type == pygame.KEYDOWN:
                if event.key == pygame.K_ESCAPE:
                    state.quit = True
                elif event.key == pygame.K_TAB:
                    state.toggle_mode = True
                elif event.key == pygame.K_r:
                    state.reset = True
                elif event.key == pygame.K_F3:
                    state.toggle_telemetry = True
                elif event.key == pygame.K_F12:
                    state.screenshot = True
                elif event.key == pygame.K_q:
                    state.toggle_wave_type = True
                elif event.key == pygame.K_SPACE:
                    self._space_held = True
                elif event.key in (pygame.K_w, pygame.K_UP):
                    self._jump_pressed = True
                elif event.key in (pygame.K_LSHIFT, pygame.K_RSHIFT):
                    self._dash_pressed = True
                elif event.key in MATERIAL_KEYS:
                    state.select_material = MATERIAL_KEYS[event.key]
            elif event.type == pygame.KEYUP:
                if event.key == pygame.K_SPACE:
                    self._space_held = False
            elif event.type == pygame.MOUSEWHEEL:
                state.brush_delta += event.y

        # Continuous state
        buttons = pygame.mouse.get_pressed()
        state.lmb = buttons[0]
        state.rmb = buttons[2]
        state.mmb = buttons[1]
        state.space = self._space_held

        mx, my = pygame.mouse.get_pos()
        state.screen_x = mx
        state.screen_y = my
        state.grid_x, state.grid_y = config.screen_to_grid(mx, my)

        # Player movement (continuous key state)
        keys = pygame.key.get_pressed()
        state.move_left = keys[pygame.K_a] or keys[pygame.K_LEFT]
        state.move_right = keys[pygame.K_d] or keys[pygame.K_RIGHT]
        state.jump = self._jump_pressed
        state.dash = self._dash_pressed

        return state
