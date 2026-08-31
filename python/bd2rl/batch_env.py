from __future__ import annotations

import json
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
        return self._stack(json.loads(self.native.reset_all_json()))

    def observe(self) -> dict[str, np.ndarray]:
        return self._stack(json.loads(self.native.observations_json()))

    def step(self, actions: np.ndarray) -> tuple[dict[str, np.ndarray], np.ndarray, np.ndarray]:
        payload = json.loads(
            self.native.step_json(
                json.dumps(np.asarray(actions, dtype=np.int64).tolist(), separators=(",", ":"))
            )
        )
        observations = self._stack([item["observation"] for item in payload])
        rewards = np.asarray([item["reward"] for item in payload], dtype=np.float32)
        dones = np.asarray([item["done"] for item in payload], dtype=np.float32)
        return observations, rewards, dones

    @staticmethod
    def _stack(items: list[dict[str, object]]) -> dict[str, np.ndarray]:
        return {
            "units": np.asarray([item["units"] for item in items], dtype=np.float32),
            "unit_mask": np.asarray([item["unit_mask"] for item in items], dtype=np.bool_),
            "global": np.asarray([item["global"] for item in items], dtype=np.float32),
            "action_mask": np.asarray([item["action_mask"] for item in items], dtype=np.bool_),
            "actor_indices": np.asarray([item["actor_indices"] for item in items], dtype=np.int64),
        }
