from __future__ import annotations

from torchrl.envs.libs.gym import GymWrapper

from .env import Bd2Env, EnvConfig


def make_torchrl_env(config: EnvConfig) -> GymWrapper:
    """Return the official TorchRL wrapper around the Gymnasium environment."""
    return GymWrapper(Bd2Env(config), categorical_action_encoding=False)
