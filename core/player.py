"""
Player character: dark energy orb with halo.
Hovers/floats, wave-force jumps, energy resource system.
Air is a medium — double/triple jump via wave force bursts.
"""
import math
import numpy as np
from .. import config, materials


class Player:
    """
    Glowing dark orb that hovers above surfaces.
    Movement is floaty and smooth — not a platformer walk, a hover glide.
    Wave force provides jumps (energy-limited: double, small triple).
    """

    # Bounding box (grid cells) — orb is ~4x4
    WIDTH = 4
    HEIGHT = 4

    # --- Hover physics ---
    GRAVITY = 80.0            # very light gravity — true float feel
    HOVER_HEIGHT = 3.0        # cells above ground to hover at
    HOVER_FORCE = 160.0       # soft spring (not stiff — no bounce)
    HOVER_DAMP = 25.0         # heavy damping kills oscillation (critically damped)
    MOVE_SPEED = 50.0         # horizontal glide speed
    MOVE_ACCEL = 6.0          # how fast we reach target speed (smooth lerp rate)
    AIR_ACCEL = 3.5           # slightly less control in air but still good
    DRAG = 0.92               # horizontal drag when not moving
    TERMINAL_VELOCITY = 80.0  # max fall speed (slow, floaty)

    # --- Wave force jumps ---
    JUMP_FORCE = 75.0         # first jump impulse (controlled, not moon jump)
    JUMP2_FORCE = 55.0        # double jump (smaller)
    JUMP3_FORCE = 35.0        # triple jump (even smaller)
    MAX_JUMPS = 3             # max air jumps before landing
    JUMP_ENERGY_COST = [0, 25, 40]  # energy cost: first=free, second=25, third=40

    # --- Air dash ---
    DASH_SPEED = 140.0        # burst horizontal speed
    DASH_DURATION = 0.12      # seconds of dash
    DASH_COOLDOWN = 0.5       # seconds between dashes
    DASH_ENERGY_COST = 20     # energy cost per dash

    # --- Wall slide / wall jump ---
    WALL_SLIDE_SPEED = 25.0   # max fall speed while wall sliding (slow)
    WALL_JUMP_FORCE_X = 55.0  # horizontal push off wall (matched to feel)
    WALL_JUMP_FORCE_Y = 65.0  # vertical jump off wall
    WALL_STICK_TIME = 0.08    # brief stick to wall before sliding

    # --- Energy system ---
    MAX_ENERGY = 100.0
    ENERGY_REGEN = 15.0       # per second while grounded/hovering
    ENERGY_REGEN_AIR = 3.0    # slow regen in air

    # --- Ambient echolocation pulse ---
    PULSE_INTERVAL = 1.6
    PULSE_INTENSITY = 1.5
    PULSE_RADIUS = 60

    # --- Platforming feel ---
    COYOTE_TIME = 0.15        # slightly more generous for hover feel
    JUMP_BUFFER = 0.12

    # --- Health ---
    INVINCIBLE_DURATION = 1.5
    MAX_HEALTH = 5

    def __init__(self, x, y):
        self.x = float(x)
        self.y = float(y)
        self.vx = 0.0
        self.vy = 0.0
        self.grounded = False
        self.hovering = False       # close enough to ground to hover
        self.facing_right = True
        self._pulse_timer = 0.0
        self.alive = True
        self._coyote_timer = 0.0
        self._jump_buffer_timer = 0.0

        # Jump tracking
        self._jumps_used = 0        # how many jumps used since last grounded
        self._jump_released = True  # must release jump key between jumps
        self._jump_grace = 0.0      # hover-disable timer after jumping

        # Dash tracking
        self._dashing = False
        self._dash_timer = 0.0      # time remaining in current dash
        self._dash_cooldown = 0.0   # cooldown timer
        self._dash_dir = 1          # 1=right, -1=left

        # Wall slide tracking
        self.wall_sliding = False    # currently sliding on a wall
        self._wall_side = 0          # -1=left wall, 1=right wall, 0=none
        self._wall_stick_timer = 0.0 # brief stick before sliding

        # Energy
        self.energy = self.MAX_ENERGY
        self.max_energy = self.MAX_ENERGY

        # Health system
        self.max_health = self.MAX_HEALTH
        self.health = self.max_health
        self.invincible_timer = 0.0

        # Status flags
        self.near_beacon = False

        # --- Visual personality state ---
        self._idle_bob_phase = 0.0  # sine bob when idle
        self._squash_stretch = 1.0  # 1.0=normal, <1=squash, >1=stretch
        self._squash_timer = 0.0    # recovery timer
        self._halo_pulse = 0.0      # halo expansion from jumps/damage
        self._halo_intensity = 1.0  # halo brightness multiplier
        self._speed_factor = 0.0    # 0-1 how fast we're moving (for trail/stretch)
        self._last_vy = 0.0         # for landing detection

    def take_damage(self, amount=1):
        """Take damage if not invincible. Returns True if damage was applied."""
        if self.invincible_timer > 0:
            return False
        self.health -= amount
        self.invincible_timer = self.INVINCIBLE_DURATION
        self._halo_pulse = 1.0      # flash halo on damage
        self._halo_intensity = 2.0  # bright flash
        self._squash_stretch = 0.7  # squash on hit
        self._squash_timer = 0.3
        if self.health <= 0:
            self.health = 0
            self.alive = False
        return True

    @property
    def halo_color(self):
        """Energy halo color — reacts to state."""
        if self.invincible_timer > 0:
            # Pulsing red-orange
            t = math.sin(self.invincible_timer * 15.0) * 0.5 + 0.5
            return (255, int(40 + t * 60), int(20 + t * 30))
        if self._halo_pulse > 0.3:
            # Jump/burst flash — bright white-cyan
            return (200, 240, 255)
        if self.energy < 20:
            # Low energy — dim red-orange warning
            return (200, 80, 40)
        if self.near_beacon:
            return (100, 255, 100)
        if self._pulse_timer < 0.3:
            return (220, 240, 255)
        # Default: cool cyan-blue
        return (40, 180, 255)

    @property
    def energy_fraction(self):
        return self.energy / self.max_energy

    def update(self, dt, voxels, move_left, move_right, jump, dash=False):
        """Update orb physics: hover, glide, wave-force jumps, air dash, wall slide."""
        W, H = config.GRID_W, config.GRID_H

        # Invincibility countdown
        if self.invincible_timer > 0:
            self.invincible_timer = max(0, self.invincible_timer - dt)

        # --- Personality visual updates ---
        self._idle_bob_phase += dt * 2.5
        self._speed_factor = min(1.0, math.sqrt(self.vx ** 2 + self.vy ** 2) / self.MOVE_SPEED)

        # Squash/stretch recovery
        if self._squash_timer > 0:
            self._squash_timer -= dt
            if self._squash_timer <= 0:
                self._squash_stretch = 1.0
        else:
            self._squash_stretch += (1.0 - self._squash_stretch) * min(1.0, dt * 8.0)

        # Halo pulse decay
        self._halo_pulse = max(0, self._halo_pulse - dt * 3.0)
        self._halo_intensity += (1.0 - self._halo_intensity) * min(1.0, dt * 4.0)

        # Movement stretch
        if self._squash_timer <= 0 and not self._dashing:
            if abs(self.vy) > 40:
                self._squash_stretch = 1.0 + min(0.3, abs(self.vy) / 300.0)
            elif self._speed_factor > 0.5:
                self._squash_stretch = 1.0 + self._speed_factor * 0.1

        # --- Dash cooldown ---
        if self._dash_cooldown > 0:
            self._dash_cooldown -= dt

        # --- Active dash ---
        if self._dashing:
            self._dash_timer -= dt
            if self._dash_timer <= 0:
                self._dashing = False
            else:
                # During dash: override velocity, no gravity
                self.vx = self.DASH_SPEED * self._dash_dir
                self.vy = 0  # float during dash

        # --- Detect walls for wall slide ---
        wall_left = self._wall_check(voxels, self.x, self.y, W, H, -1)
        wall_right = self._wall_check(voxels, self.x, self.y, W, H, 1)

        # Determine wall contact
        prev_wall_side = self._wall_side
        self._wall_side = 0
        if wall_left and move_left:
            self._wall_side = -1
        elif wall_right and move_right:
            self._wall_side = 1

        # --- Horizontal movement (smooth glide) ---
        if not self._dashing:
            target_vx = 0.0
            if move_left:
                target_vx = -self.MOVE_SPEED
                self.facing_right = False
            if move_right:
                target_vx = self.MOVE_SPEED
                self.facing_right = True

            accel_rate = self.MOVE_ACCEL if self.grounded or self.hovering else self.AIR_ACCEL
            self.vx += (target_vx - self.vx) * min(1.0, dt * accel_rate)

            if target_vx == 0:
                self.vx *= self.DRAG

        # --- Detect ground distance for hover ---
        ground_dist = self._ground_distance(voxels, self.x, self.y, W, H)

        if ground_dist <= self.HOVER_HEIGHT + 2:
            self.hovering = True
            if ground_dist <= 1:
                self.grounded = True
            else:
                self.grounded = False
        else:
            self.hovering = False
            self.grounded = False

        # --- Wall slide logic ---
        was_wall_sliding = self.wall_sliding
        self.wall_sliding = False

        if (not self.grounded and not self.hovering and
                self._wall_side != 0 and self.vy > 0 and not self._dashing):
            # Touching a wall, falling, holding toward wall = wall slide
            self.wall_sliding = True
            self._jumps_used = 0  # reset jumps on wall (allows wall jump chains)

            # Wall stick: brief pause before sliding
            if not was_wall_sliding:
                self._wall_stick_timer = self.WALL_STICK_TIME
                self.vy = 0  # stop briefly

            if self._wall_stick_timer > 0:
                self._wall_stick_timer -= dt
                self.vy = 0  # held in place
            else:
                # Slow slide down
                if self.vy > self.WALL_SLIDE_SPEED:
                    self.vy = self.WALL_SLIDE_SPEED

        # --- Coyote time ---
        if self.grounded or self.hovering or self.wall_sliding:
            self._coyote_timer = self.COYOTE_TIME
            if self.grounded or self.hovering:
                self._jumps_used = 0
        else:
            self._coyote_timer = max(0, self._coyote_timer - dt)

        # --- Jump buffering ---
        if jump and self._jump_released:
            self._jump_buffer_timer = self.JUMP_BUFFER
        else:
            self._jump_buffer_timer = max(0, self._jump_buffer_timer - dt)

        if not jump:
            self._jump_released = True

        # --- Wave force jump / wall jump ---
        wants_jump = (jump and self._jump_released) or self._jump_buffer_timer > 0
        if wants_jump:
            jumped = False

            if self.wall_sliding:
                # Wall jump: push away from wall + upward
                self.vx = self.WALL_JUMP_FORCE_X * (-self._wall_side)  # push AWAY
                self.vy = -self.WALL_JUMP_FORCE_Y
                self.facing_right = (self._wall_side < 0)  # face away from wall
                self.wall_sliding = False
                self._wall_side = 0
                self._jumps_used = 1
                jumped = True
            elif self._jumps_used == 0 and (self.grounded or self.hovering or self._coyote_timer > 0):
                # IMPORTANT: zero vy first so hover/gravity residual doesn't eat the impulse
                self.vy = 0
                self.vy = -self.JUMP_FORCE
                self._jumps_used = 1
                self.grounded = False
                self.hovering = False  # leave hover state immediately
                jumped = True
            elif self._jumps_used == 1 and self._jumps_used < self.MAX_JUMPS:
                cost = self.JUMP_ENERGY_COST[1]
                if self.energy >= cost:
                    self.energy -= cost
                    self.vy = -self.JUMP2_FORCE
                    self._jumps_used = 2
                    jumped = True
            elif self._jumps_used == 2 and self._jumps_used < self.MAX_JUMPS:
                cost = self.JUMP_ENERGY_COST[2]
                if self.energy >= cost:
                    self.energy -= cost
                    self.vy = -self.JUMP3_FORCE
                    self._jumps_used = 3
                    jumped = True

            if jumped:
                self._jump_released = False
                self._jump_buffer_timer = 0
                self._coyote_timer = 0
                self._jump_grace = 0.3   # disable hover for 300ms so it can't recapture
                self._halo_pulse = 0.8
                self._halo_intensity = 1.8
                self._squash_stretch = 1.3
                self._squash_timer = 0.15

        # --- Air dash ---
        if dash and not self._dashing and self._dash_cooldown <= 0:
            if self.energy >= self.DASH_ENERGY_COST:
                self.energy -= self.DASH_ENERGY_COST
                self._dashing = True
                self._dash_timer = self.DASH_DURATION
                self._dash_cooldown = self.DASH_COOLDOWN
                self._dash_dir = 1 if self.facing_right else -1
                self.vy = 0  # cancel vertical momentum
                # Visual burst
                self._halo_pulse = 1.0
                self._halo_intensity = 2.0
                self._squash_stretch = 0.6  # flatten horizontally (wide dash)
                self._squash_timer = 0.1

        # --- Jump grace timer (prevents hover from eating jump impulse) ---
        jumped_this_frame = self._jump_grace >= 0.29  # just set to 0.3 this frame
        if self._jump_grace > 0:
            self._jump_grace -= dt

        # --- Gravity (lighter for floaty feel) ---
        # Skip gravity on the actual jump frame so it doesn't eat the impulse
        if not self._dashing and not jumped_this_frame:
            self.vy += self.GRAVITY * dt

        # --- Hover: smooth levitation, NOT bouncy spring ---
        # Skip hover entirely if we just jumped (grace period) or dashing
        if (self.hovering and ground_dist < self.HOVER_HEIGHT + 1
                and not self._dashing and self._jump_grace <= 0):
            # How far below hover height we are (0 = at hover, positive = too close to ground)
            penetration = self.HOVER_HEIGHT - ground_dist

            if penetration > 0 and self.vy >= 0:
                # Below hover height AND falling/stationary — push up gently
                # Only resist downward motion, never fight an upward jump
                push = penetration * self.HOVER_FORCE
                self.vy -= push * dt
                # Heavy velocity damping kills any oscillation
                self.vy *= max(0.0, 1.0 - self.HOVER_DAMP * dt)
            elif penetration <= 0 and self.vy > 0:
                # Above hover height but still in hover zone — just damp falling
                self.vy *= max(0.0, 1.0 - self.HOVER_DAMP * 0.5 * dt)

        # --- Terminal velocity (floaty fall, not a brick) ---
        if not self._dashing and self.vy > self.TERMINAL_VELOCITY:
            self.vy += (self.TERMINAL_VELOCITY - self.vy) * min(1.0, dt * 5.0)

        # --- Velocity limits ---
        max_vx = self.DASH_SPEED if self._dashing else self.MOVE_SPEED * 1.2
        self.vx = np.clip(self.vx, -max_vx, max_vx)
        self.vy = np.clip(self.vy, -self.JUMP_FORCE * 1.2, self.TERMINAL_VELOCITY * 1.2)

        # --- Collision ---
        self._last_vy = self.vy

        # Horizontal
        new_x = self.x + self.vx * dt
        if self._overlaps_solid(voxels, new_x, self.y, W, H):
            new_x = self.x
            if self._dashing:
                self._dashing = False  # dash ends on wall hit
            self.vx *= -0.2

        # Vertical
        new_y = self.y + self.vy * dt
        if self.vy >= 0:  # falling
            if self._overlaps_solid(voxels, new_x, new_y, W, H):
                lo, hi = self.y, new_y
                for _ in range(8):
                    mid = (lo + hi) * 0.5
                    if self._overlaps_solid(voxels, new_x, mid, W, H):
                        hi = mid
                    else:
                        lo = mid
                new_y = lo

                if self._last_vy > 50:
                    impact = min(0.4, self._last_vy / 400.0)
                    self._squash_stretch = 1.0 - impact
                    self._squash_timer = 0.2
                    self._halo_pulse = impact

                self.vy = 0
                self.grounded = True
        else:  # going up
            if self._overlaps_solid(voxels, new_x, new_y, W, H):
                new_y = self.y
                self.vy = 0

        # Apply position
        self.x = np.clip(new_x, 0, W - self.WIDTH)
        self.y = np.clip(new_y, 0, H - self.HEIGHT)

        # --- Energy regen ---
        if self.grounded or self.hovering:
            self.energy = min(self.max_energy, self.energy + self.ENERGY_REGEN * dt)
        elif self.wall_sliding:
            self.energy = min(self.max_energy, self.energy + self.ENERGY_REGEN * 0.5 * dt)
        else:
            self.energy = min(self.max_energy, self.energy + self.ENERGY_REGEN_AIR * dt)

        # --- Ambient pulse timer ---
        self._pulse_timer += dt

    def should_pulse(self):
        """Check if player should emit an ambient wave pulse."""
        if self._pulse_timer >= self.PULSE_INTERVAL:
            self._pulse_timer = 0
            return True
        return False

    @property
    def center_x(self):
        return int(self.x + self.WIDTH / 2)

    @property
    def center_y(self):
        return int(self.y + self.HEIGHT / 2)

    # --- Personality getters for renderer ---
    @property
    def idle_bob_offset(self):
        """Vertical bob when idle/hovering. Returns pixel offset."""
        if self._speed_factor < 0.2 and (self.grounded or self.hovering):
            return math.sin(self._idle_bob_phase) * 1.2
        return 0.0

    @property
    def squash_stretch(self):
        return self._squash_stretch

    @property
    def halo_radius_multiplier(self):
        """Halo expands on jumps/damage, contracts when calm."""
        return 1.0 + self._halo_pulse * 0.6

    @property
    def halo_brightness(self):
        return self._halo_intensity

    def _wall_check(self, voxels, x, y, W, H, direction):
        """Check if there's a solid wall on the given side (-1=left, 1=right).
        Checks 2 cells vertically for a wall next to the player."""
        ix = int(x)
        iy = int(y)
        if direction < 0:
            check_x = ix  # left edge of player
        else:
            check_x = ix + self.WIDTH  # right edge of player

        if check_x < 0 or check_x >= W:
            return False

        # Check a couple vertical cells to confirm it's a real wall
        wall_count = 0
        for dy in range(1, self.HEIGHT - 1):
            cy = iy + dy
            if 0 <= cy < H and materials.IS_SOLID[voxels[check_x, cy]]:
                wall_count += 1
        return wall_count >= 2

    def _ground_distance(self, voxels, x, y, W, H):
        """How many cells between player bottom and nearest solid below."""
        ix = int(x + self.WIDTH / 2)
        iy = int(y + self.HEIGHT)
        if ix < 0 or ix >= W:
            return 999
        for dy in range(0, 30):  # scan up to 30 cells down
            check_y = iy + dy
            if check_y >= H:
                return dy
            if materials.IS_SOLID[voxels[ix, check_y]]:
                return dy
        return 30

    def _overlaps_solid(self, voxels, x, y, W, H):
        """Check if player body at (x, y) overlaps any solid voxel.
        Uses a smaller collision shape than bounding box (circular feel)."""
        ix, iy = int(x), int(y)
        # Inset by 1 for rounder collision feel
        x0 = max(0, ix + 1)
        y0 = max(0, iy + 1)
        x1 = min(W, ix + self.WIDTH - 1)
        y1 = min(H, iy + self.HEIGHT - 1)
        if x0 >= x1 or y0 >= y1:
            return False
        region = voxels[x0:x1, y0:y1]
        return bool(np.any(materials.IS_SOLID[region]))

    def find_spawn(self, voxels):
        """Find a valid spawn position (clear air above solid ground)."""
        W, H = config.GRID_W, config.GRID_H
        center = W // 2

        x_offsets = [0]
        for offset in range(10, W // 2, 10):
            x_offsets.append(offset)
            x_offsets.append(-offset)

        for x_off in x_offsets:
            cx = center + x_off
            if cx < self.WIDTH or cx >= W - self.WIDTH:
                continue

            for y in range(H - self.HEIGHT - 1):
                body_clear = not self._overlaps_solid(voxels, cx, y, W, H)
                feet_y = y + self.HEIGHT
                if feet_y < H and body_clear:
                    has_ground = False
                    for dx in range(self.WIDTH):
                        fx = cx + dx
                        if 0 <= fx < W and materials.IS_SOLID[voxels[fx, feet_y]]:
                            has_ground = True
                            break
                    if has_ground:
                        self.x = float(cx)
                        self.y = float(y - int(self.HOVER_HEIGHT))
                        return

        self.x = float(center)
        self.y = float(H // 2)
