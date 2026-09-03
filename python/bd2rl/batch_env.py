from __future__ import annotations

from pathlib import Path

import numpy as np

from . import _native
from .env import (
    FLOAT_OBSERVATION_KEYS,
    INDEX_OBSERVATION_KEYS,
    MASK_OBSERVATION_KEYS,
    OBSERVATION_KEYS,
)


class NativeBatchEnv:
    """Parallel Rust-resident environment batch used by the collector."""

    def __init__(
        self,
        database: Path,
        scenario: Path,
        num_envs: int,
        seed: int,
    ) -> None:
        setup_json = scenario.read_text(encoding="utf-8")
        self.native = _native.BatchSimulator(str(database), setup_json, num_envs, seed)
        self.num_envs = num_envs

    def reset(self) -> dict[str, np.ndarray]:
        return self._native_arrays(self.native.reset_all_numpy())

    def observe(self) -> dict[str, np.ndarray]:
        return self._native_arrays(self.native.observations_numpy())

    def step(self, actions: np.ndarray) -> tuple[dict[str, np.ndarray], np.ndarray, np.ndarray]:
        action_array = np.asarray(actions, dtype=np.int64)
        observations, rewards, dones = self.native.step_numpy(action_array.tolist())
        return (
            self._native_arrays(observations),
            np.asarray(rewards, dtype=np.float32),
            np.asarray(dones, dtype=np.float32),
        )

    @staticmethod
    def _native_arrays(items: dict[str, np.ndarray]) -> dict[str, np.ndarray]:
        if set(items) != set(OBSERVATION_KEYS):
            missing = sorted(set(OBSERVATION_KEYS) - set(items))
            extra = sorted(set(items) - set(OBSERVATION_KEYS))
            raise RuntimeError(f"native batch observation mismatch: {missing=}, {extra=}")
        return {
            **{key: np.asarray(items[key], dtype=np.float32) for key in FLOAT_OBSERVATION_KEYS},
            **{key: np.asarray(items[key], dtype=np.bool_) for key in MASK_OBSERVATION_KEYS},
            **{key: np.asarray(items[key], dtype=np.int64) for key in INDEX_OBSERVATION_KEYS},
        }

    @staticmethod
    def _stack(items: list[dict[str, object]]) -> dict[str, np.ndarray]:
        return {
            **{
                key: np.asarray([item[key] for item in items], dtype=np.float32)
                for key in FLOAT_OBSERVATION_KEYS
            },
            **{
                key: np.asarray([item[key] for item in items], dtype=np.bool_)
                for key in MASK_OBSERVATION_KEYS
            },
            **{
                key: np.asarray([item[key] for item in items], dtype=np.int64)
                for key in INDEX_OBSERVATION_KEYS
            },
        }
