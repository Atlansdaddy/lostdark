"""Single material registry - enum, properties, LUTs."""
import numpy as np

# Material IDs (uint8)
AIR = 0
STONE = 1
GLASS = 2
METAL = 3
WOOD = 4
WATER = 5
SAND = 6
DIRT = 7
NUM_MATERIALS = 8

# Material names
NAMES = ['Air', 'Stone', 'Glass', 'Metal', 'Wood', 'Water', 'Sand', 'Dirt']

# Base colors (R, G, B) - vibrant Geometry Dash style
COLORS = [
    (0, 0, 0),         # AIR (transparent/bg)
    (140, 145, 160),   # STONE - cool blue-grey
    (140, 210, 255),   # GLASS - bright ice blue
    (180, 195, 215),   # METAL - bright silver-blue
    (155, 100, 45),    # WOOD - warm rich brown
    (20, 110, 230),    # WATER - vivid blue
    (230, 205, 120),   # SAND - warm gold
    (115, 80, 45),     # DIRT - warm brown
]

# Physical properties (indexed by material ID)
DENSITY = np.array([0.0, 2.5, 2.2, 7.8, 0.6, 1.0, 1.5, 1.3], dtype=np.float32)
COHESION = np.array([0.0, 6.0, 1.5, 10.0, 4.0, 0.0, 0.5, 1.5], dtype=np.float32)
HARDNESS = np.array([0.0, 5.0, 1.2, 8.0, 3.0, 0.0, 0.5, 1.2], dtype=np.float32)
ELASTICITY = np.array([0.0, 0.3, 0.1, 0.5, 0.4, 0.0, 0.1, 0.2], dtype=np.float32)
ABSORPTION = np.array([0.0, 0.3, 0.1, 0.2, 0.5, 0.4, 0.6, 0.5], dtype=np.float32)

# Wave speed multiplier per material (0 = blocks waves, 1 = full speed)
WAVE_SPEED_MULT = np.array([1.0, 0.4, 0.8, 0.3, 0.5, 0.9, 0.6, 0.5], dtype=np.float32)

# Booleans
IS_SOLID = np.array([False, True, True, True, True, False, True, True], dtype=bool)
IS_FLUID = np.array([False, False, False, False, False, True, False, False], dtype=bool)

# Color variation per material (subtle for clean Geometry Dash look)
COLOR_VARIATION = np.array([0, 3, 2, 2, 4, 3, 3, 4], dtype=np.int32)

# Pre-computed numpy LUTs
COLOR_LUT_RGB = np.array(COLORS, dtype=np.uint8)  # (NUM_MATERIALS, 3)

# Number of debris particles per voxel break
DEBRIS_COUNT = np.array([0, 3, 6, 2, 4, 0, 2, 2], dtype=np.int32)

# Does this material produce sparks when broken?
SPARK_ON_BREAK = np.array([False, True, True, True, False, False, False, False], dtype=bool)

# Does this material burn?
FLAMMABLE = np.array([False, False, False, False, True, False, False, False], dtype=bool)

# Illumination properties (dark-world system)
# How much wave energy reflects as light (0=invisible, 1=full reflect)
REFLECTIVITY = np.array([0.0, 0.8, 0.15, 0.95, 0.3, 0.2, 0.2, 0.2], dtype=np.float32)
# How long glow persists per frame (higher=stays lit longer)
GLOW_DECAY = np.array([0.948, 0.958, 0.928, 0.981, 0.948, 0.938, 0.948, 0.948], dtype=np.float32)
