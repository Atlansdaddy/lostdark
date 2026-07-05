"""All tunables and coordinate conversion."""
import pygame

# Display scale (each voxel = PIXEL_SCALE x PIXEL_SCALE screen pixels)
# 8px per voxel = chunky, clean Geometry Dash style
PIXEL_SCALE = 8

# Fullscreen: detect native resolution at init time
# Fallback before pygame init
SCREEN_W = 1920
SCREEN_H = 1080
FULLSCREEN = True

# View dimensions (in grid cells) - computed from screen
VIEW_W = SCREEN_W // PIXEL_SCALE   # 240
VIEW_H = SCREEN_H // PIXEL_SCALE   # 135

# World dimensions (grid cells) - ~2 screens of exploration
GRID_W = VIEW_W * 2    # 480
GRID_H = VIEW_H * 2    # 270

# Chunk-based dirty tracking
CHUNK_SIZE = 16
CHUNKS_W = (GRID_W + CHUNK_SIZE - 1) // CHUNK_SIZE
CHUNKS_H = (GRID_H + CHUNK_SIZE - 1) // CHUNK_SIZE

# Physics
WAVE_SPEED = 0.5            # faster wave propagation
WAVE_DAMPING = 0.994
WAVE_SUBSTEPS = 2
MAX_WAVE_AMPLITUDE = 3.0

# Destruction (only FORCE waves cause destruction)
DESTRUCTION_THRESHOLD = 3.0   # raised: force needs real energy to break things
MAX_DESTRUCTIONS_PER_FRAME = 40

# Particles
MAX_PARTICLES = 2000

# Performance
TARGET_FPS = 60
ADAPTIVE_LOW_FPS = 45
ADAPTIVE_CRITICAL_FPS = 30

# Structural block sizes (w, h, name)
BLOCK_SIZES = [
    (1, 1, "Voxel"),
    (3, 3, "Block"),
    (6, 3, "Platform"),
    (3, 6, "Wall"),
    (8, 8, "Room"),
]

# Colors
BG_COLOR = (2, 2, 5)


def init_display():
    """Call after pygame.init() to detect native resolution and update config."""
    global SCREEN_W, SCREEN_H, VIEW_W, VIEW_H, GRID_W, GRID_H, CHUNKS_W, CHUNKS_H

    info = pygame.display.Info()
    SCREEN_W = info.current_w
    SCREEN_H = info.current_h

    VIEW_W = SCREEN_W // PIXEL_SCALE
    VIEW_H = SCREEN_H // PIXEL_SCALE

    # World: ~2 screens each direction
    GRID_W = VIEW_W * 2
    GRID_H = VIEW_H * 2

    CHUNKS_W = (GRID_W + CHUNK_SIZE - 1) // CHUNK_SIZE
    CHUNKS_H = (GRID_H + CHUNK_SIZE - 1) // CHUNK_SIZE


def screen_to_grid(sx, sy):
    """Convert screen coordinates to grid coordinates."""
    return sx // PIXEL_SCALE, sy // PIXEL_SCALE


def grid_to_screen(gx, gy):
    """Convert grid coordinates to screen coordinates."""
    return gx * PIXEL_SCALE, gy * PIXEL_SCALE


def grid_to_chunk(gx, gy):
    """Convert grid coordinates to chunk coordinates."""
    return gx // CHUNK_SIZE, gy // CHUNK_SIZE
