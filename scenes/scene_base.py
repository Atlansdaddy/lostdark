"""Abstract scene base class."""
from abc import ABC, abstractmethod


class Scene(ABC):
    """Base class for all scenes. Manages update/render lifecycle."""

    @abstractmethod
    def update(self, dt, input_state):
        """Update scene logic. dt in seconds."""
        pass

    @abstractmethod
    def render(self, screen):
        """Render scene to screen."""
        pass

    def on_enter(self):
        """Called when scene becomes active."""
        pass

    def on_exit(self):
        """Called when scene is deactivated."""
        pass
