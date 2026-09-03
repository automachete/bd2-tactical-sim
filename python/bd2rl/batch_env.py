from __future__ import annotations

from pathlib import Path

import numpy as np

from . import _native


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
        return {
            "units": np.asarray(items["units"], dtype=np.float32),
            "unit_mask": np.asarray(items["unit_mask"], dtype=np.bool_),
            "global": np.asarray(items["global"], dtype=np.float32),
            "action_mask": np.asarray(items["action_mask"], dtype=np.bool_),
            "actor_indices": np.asarray(items["actor_indices"], dtype=np.int64),
        }

    @staticmethod
    def _stack(items: list[dict[str, object]]) -> dict[str, np.ndarray]:
        return {
            "units": np.asarray([item["units"] for item in items], dtype=np.float32),
            "unit_mask": np.asarray([item["unit_mask"] for item in items], dtype=np.bool_),
            "global": np.asarray([item["global"] for item in items], dtype=np.float32),
            "action_mask": np.asarray([item["action_mask"] for item in items], dtype=np.bool_),
            "actor_indices": np.asarray([item["actor_indices"] for item in items], dtype=np.int64),
        }
