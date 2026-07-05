"""Shadow creature enemy: patrols in darkness, hunts player, flees light."""
import numpy as np
from .. import config, materials

# Enemy states
PATROL = 0
HUNT = 1
FLEE = 2
DYING = 3


class ShadowCreature:
    """
    Dark entity that patrols in shadow, hunts the player when nearby and dark,
    and takes damage from sustained light exposure.
    """

    WIDTH = 3
    HEIGHT = 3

    PATROL_SPEED = 20.0
    HUNT_SPEED = 35.0
    FLEE_SPEED = 40.0

    LIGHT_DAMAGE_THRESHOLD = 0.6
    LIGHT_FLEE_THRESHOLD = 0.4

    CONTACT_DAMAGE = 1
    CONTACT_COOLDOWN = 1.0

    GRAVITY = 200.0

    def __init__(self, x, y, patrol_left, patrol_right):
        self.x = float(x)
        self.y = float(y)
        self.vx = 0.0
        self.vy = 0.0
        self.patrol_left = float(patrol_left)
        self.patrol_right = float(patrol_right)
        self.patrol_dir = 1.0  # 1=right, -1=left

        self.state = PATROL
        self.health = 3.0
        self.dead = False

        self._contact_cooldown = 0.0
        self._dying_timer = 0.0
        self._dying_duration = 0.5

        self.grounded = False

    @property
    def center_x(self):
        return self.x + self.WIDTH / 2

    @property
    def center_y(self):
        return self.y + self.HEIGHT / 2

    def update(self, dt, light_field, player, voxels):
        """Update enemy AI and physics."""
        if self.dead:
            return

        W, H = config.GRID_W, config.GRID_H

        # Contact cooldown
        if self._contact_cooldown > 0:
            self._contact_cooldown = max(0, self._contact_cooldown - dt)

        # Read light at own position
        ix = int(np.clip(self.center_x, 0, W - 1))
        iy = int(np.clip(self.center_y, 0, H - 1))
        my_light = float(light_field[ix, iy])

        # Distance to player
        dx = player.center_x - self.center_x
        dy = player.center_y - self.center_y
        dist_to_player = np.sqrt(dx * dx + dy * dy)

        # Read light at player position
        px = int(np.clip(player.center_x, 0, W - 1))
        py = int(np.clip(player.center_y, 0, H - 1))
        player_light = float(light_field[px, py])

        if self.state == DYING:
            self._dying_timer += dt
            if self._dying_timer >= self._dying_duration:
                self.dead = True
            return

        # State transitions
        if self.state == PATROL:
            if my_light > self.LIGHT_FLEE_THRESHOLD:
                self.state = FLEE
            elif dist_to_player < 40 and player_light < 0.3:
                self.state = HUNT
        elif self.state == HUNT:
            if my_light > self.LIGHT_FLEE_THRESHOLD:
                self.state = FLEE
            elif dist_to_player > 60:
                self.state = PATROL
        elif self.state == FLEE:
            # Take light damage
            if my_light > self.LIGHT_DAMAGE_THRESHOLD:
                self.health -= my_light * dt * 2.0
                if self.health <= 0:
                    self.state = DYING
                    self._dying_timer = 0.0
                    return
            if my_light < self.LIGHT_FLEE_THRESHOLD:
                self.state = PATROL

        # Movement based on state
        target_vx = 0.0
        if self.state == PATROL:
            target_vx = self.PATROL_SPEED * self.patrol_dir
            # Reverse at patrol bounds
            if self.x <= self.patrol_left:
                self.patrol_dir = 1.0
            elif self.x + self.WIDTH >= self.patrol_right:
                self.patrol_dir = -1.0
        elif self.state == HUNT:
            if dist_to_player > 2:
                direction = 1.0 if dx > 0 else -1.0
                target_vx = self.HUNT_SPEED * direction
        elif self.state == FLEE:
            # Flee away from brightest direction (approximate: flee from player)
            if dist_to_player > 1:
                direction = -1.0 if dx > 0 else 1.0
                target_vx = self.FLEE_SPEED * direction
            else:
                target_vx = self.FLEE_SPEED * self.patrol_dir

        # Smooth acceleration
        self.vx += (target_vx - self.vx) * min(1.0, dt * 8.0)

        # Gravity
        self.vy += self.GRAVITY * dt

        # Clamp
        self.vx = np.clip(self.vx, -self.FLEE_SPEED, self.FLEE_SPEED)
        self.vy = np.clip(self.vy, -200.0, 300.0)

        # Collision - horizontal
        new_x = self.x + self.vx * dt
        if self._overlaps_solid(voxels, new_x, self.y, W, H):
            new_x = self.x
            self.vx = 0
            # Reverse patrol direction on wall hit
            if self.state == PATROL:
                self.patrol_dir *= -1.0

        # Collision - vertical
        new_y = self.y + self.vy * dt
        self.grounded = False
        if self.vy >= 0:  # falling
            if self._overlaps_solid(voxels, new_x, new_y, W, H):
                lo, hi = self.y, new_y
                for _ in range(6):
                    mid = (lo + hi) * 0.5
                    if self._overlaps_solid(voxels, new_x, mid, W, H):
                        hi = mid
                    else:
                        lo = mid
                new_y = lo
                self.vy = 0
                self.grounded = True
        else:  # rising
            if self._overlaps_solid(voxels, new_x, new_y, W, H):
                new_y = self.y
                self.vy = 0

        self.x = np.clip(new_x, 0, W - self.WIDTH)
        self.y = np.clip(new_y, 0, H - self.HEIGHT)

    def overlaps_player(self, player):
        """AABB overlap check for contact damage."""
        if self.state == DYING or self.dead:
            return False
        return (self.x < player.x + player.WIDTH and
                self.x + self.WIDTH > player.x and
                self.y < player.y + player.HEIGHT and
                self.y + self.HEIGHT > player.y)

    def _overlaps_solid(self, voxels, x, y, W, H):
        """Check if enemy body at (x, y) overlaps any solid voxel."""
        ix, iy = int(x), int(y)
        x0 = max(0, ix)
        y0 = max(0, iy)
        x1 = min(W, ix + self.WIDTH)
        y1 = min(H, iy + self.HEIGHT)
        if x0 >= x1 or y0 >= y1:
            return False
        region = voxels[x0:x1, y0:y1]
        return bool(np.any(materials.IS_SOLID[region]))
