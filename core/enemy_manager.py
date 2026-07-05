"""Enemy lifecycle management: spawn, update, remove dead."""
from .enemy import ShadowCreature


class EnemyManager:
    """Manages all shadow creature enemies in the level."""

    def __init__(self):
        self.enemies = []

    def spawn(self, x, y, patrol_left, patrol_right):
        """Create and add an enemy."""
        self.enemies.append(ShadowCreature(x, y, patrol_left, patrol_right))

    def update(self, dt, light_field, player, voxels):
        """Update all enemies, check contact damage, remove dead."""
        for enemy in self.enemies:
            enemy.update(dt, light_field, player, voxels)

            # Contact damage
            if enemy.overlaps_player(player):
                if enemy._contact_cooldown <= 0:
                    if player.take_damage(enemy.CONTACT_DAMAGE):
                        enemy._contact_cooldown = enemy.CONTACT_COOLDOWN

        # Remove dead enemies
        self.enemies = [e for e in self.enemies if not e.dead]

    def reset(self):
        """Clear all enemies."""
        self.enemies.clear()
