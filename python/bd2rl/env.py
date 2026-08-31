from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, ClassVar

import gymnasium as gym
import numpy as np

from . import _native

MAX_TEAM_UNITS = 5
MAX_TOTAL_UNITS = 32
MAX_ACTIONS_PER_UNIT = 32
UNIT_FEATURES = 56
GLOBAL_FEATURES = 16


@dataclass(frozen=True)
class EnvConfig:
    database_path: Path
    setup_path: Path
    seed: int = 0
    control_side: str = "PLAYER"
    auto_opponent: bool = True
    max_auto_turns: int = 128


class Bd2Env(gym.Env[dict[str, np.ndarray], np.ndarray]):
    """Gymnasium facade over the deterministic Rust battle core.

    One environment step submits a complete team-turn plan. The opposing side
    is advanced automatically when ``auto_opponent`` is enabled. Rendering and
    GUI services are intentionally absent from this hot path.
    """

    metadata: ClassVar[dict[str, Any]] = {"render_modes": ["ansi"], "render_fps": 4}

    def __init__(self, config: EnvConfig, render_mode: str | None = None) -> None:
        super().__init__()
        self.config = config
        self.render_mode = render_mode
        self._setup_json = config.setup_path.read_text(encoding="utf-8")
        self._episode_seed = config.seed
        self._simulator: _native.Simulator | None = None
        self._last_state: dict[str, Any] = {}
        self._last_damage = 0
        self._action_lookup: list[list[dict[str, Any]]] = []

        self.action_space = gym.spaces.MultiDiscrete(
            np.full(MAX_TEAM_UNITS, MAX_ACTIONS_PER_UNIT, dtype=np.int64)
        )
        self.observation_space = gym.spaces.Dict(
            {
                "units": gym.spaces.Box(
                    low=-1_000_000.0,
                    high=1_000_000.0,
                    shape=(MAX_TOTAL_UNITS, UNIT_FEATURES),
                    dtype=np.float32,
                ),
                "unit_mask": gym.spaces.MultiBinary(MAX_TOTAL_UNITS),
                "global": gym.spaces.Box(
                    low=-1_000_000.0,
                    high=1_000_000.0,
                    shape=(GLOBAL_FEATURES,),
                    dtype=np.float32,
                ),
                "action_mask": gym.spaces.Box(
                    low=0,
                    high=1,
                    shape=(MAX_TEAM_UNITS, MAX_ACTIONS_PER_UNIT),
                    dtype=np.int8,
                ),
                "actor_indices": gym.spaces.Box(
                    low=0,
                    high=MAX_TOTAL_UNITS,
                    shape=(MAX_TEAM_UNITS,),
                    dtype=np.int64,
                ),
            }
        )

    @property
    def simulator(self) -> _native.Simulator:
        if self._simulator is None:
            raise RuntimeError("reset() must be called before using the environment")
        return self._simulator

    def reset(
        self,
        *,
        seed: int | None = None,
        options: dict[str, Any] | None = None,
    ) -> tuple[dict[str, np.ndarray], dict[str, Any]]:
        super().reset(seed=seed)
        del options
        if seed is not None:
            self._episode_seed = seed
        self._simulator = _native.Simulator(
            str(self.config.database_path), self._setup_json, self._episode_seed
        )
        self._last_state = json.loads(self.simulator.state_json())
        self._last_damage = self._controlled_damage(self._last_state)
        observation = self._observation(self.config.control_side)
        return observation, self._info()

    def step(
        self, action: np.ndarray
    ) -> tuple[dict[str, np.ndarray], float, bool, bool, dict[str, Any]]:
        action = np.asarray(action, dtype=np.int64)
        self.submit_turn(action, self.config.control_side, strict=False)

        auto_turns = 0
        state = json.loads(self.simulator.state_json())
        while (
            self.config.auto_opponent
            and state["terminal"] is None
            and state["active_side"] != self.config.control_side
        ):
            self.simulator.step_auto_json()
            auto_turns += 1
            if auto_turns > self.config.max_auto_turns:
                raise RuntimeError("opponent auto-play exceeded safety limit")
            state = json.loads(self.simulator.state_json())

        current_damage = self._controlled_damage(state)
        dense_damage = (current_damage - self._last_damage) / 1_000_000.0
        self._last_damage = current_damage
        terminal = state["terminal"]
        terminal_reward = 0.0
        if terminal is not None:
            terminal_reward = {
                "WIN": 1.0,
                "LOSS": -1.0,
                "DRAW": 0.0,
                "SCORE_ONLY": 0.0,
            }[terminal["outcome"]]
        reward = float(terminal_reward + np.clip(dense_damage, -0.1, 0.1))
        self._last_state = state
        return (
            self._observation(self.config.control_side),
            reward,
            terminal is not None,
            False,
            self._info(),
        )

    def observation_for(self, side: str) -> dict[str, np.ndarray]:
        """Return an ego-centric policy observation for either side."""
        return self._observation(side.upper())

    def info(self) -> dict[str, Any]:
        """Return the current simulator metadata without advancing the battle."""
        return self._info()

    def submit_turn(self, action: np.ndarray, side: str, *, strict: bool = True) -> None:
        """Submit one side's team turn without automatically advancing its opponent."""
        side = side.upper()
        action = np.asarray(action, dtype=np.int64)
        if action.shape != (MAX_TEAM_UNITS,):
            raise ValueError(f"expected action shape {(MAX_TEAM_UNITS,)}, got {action.shape}")
        state = json.loads(self.simulator.state_json())
        if state["terminal"] is not None:
            raise RuntimeError("turn submitted after terminal state")
        if state["active_side"] != side:
            raise RuntimeError(f"submitted side is {side}, active side is {state['active_side']}")
        side_index = 0 if side == "PLAYER" else 1
        order = state["teams"][side_index]["action_order"]
        lookup = self._legal_action_lookup(side, order)
        commands: dict[str, dict[str, Any]] = {}
        for slot, unit_id in enumerate(order[:MAX_TEAM_UNITS]):
            selected = int(action[slot])
            if selected < 0 or selected >= len(lookup[slot]):
                if strict:
                    raise ValueError(f"masked action selected: slot={slot}, action={selected}")
                selected = 0
            commands[str(unit_id)] = lookup[slot][selected]
        plan = {"side": side, "order": order, "commands": commands, "formation": {}}
        self.simulator.step_json(json.dumps(plan, separators=(",", ":")))

    def snapshot_json(self) -> str:
        return self.simulator.state_json()

    def restore_json(self, snapshot: str) -> dict[str, np.ndarray]:
        self.simulator.restore_json(snapshot)
        self._last_state = json.loads(snapshot)
        self._last_damage = self._controlled_damage(self._last_state)
        return self._observation(self.config.control_side)

    def render(self) -> str | None:
        if self.render_mode != "ansi":
            return None
        state = json.loads(self.simulator.state_json())
        lines = [
            f"turn={state['game_turn']} active={state['active_side']} "
            f"sp={state['teams'][0]['sp']}/{state['teams'][1]['sp']}"
        ]
        for side in ("PLAYER", "ENEMY"):
            units = [unit for unit in state["units"].values() if unit["side"] == side]
            lines.append(
                side
                + ": "
                + " | ".join(
                    f"#{unit['id']} hp={unit['hp']}/{unit['base_stats']['max_hp']} "
                    f"@{unit['position']['row']},{unit['position']['depth']}"
                    for unit in units
                )
            )
        return "\n".join(lines)

    def _legal_action_lookup(self, side: str, order: list[int]) -> list[list[dict[str, Any]]]:
        legal = json.loads(self.simulator.legal_actions_json(side))
        legal_by_id = {entry["unit_id"]: entry["commands"] for entry in legal}
        lookup = [legal_by_id.get(unit_id, [{"type": "WAIT"}]) for unit_id in order]
        while len(lookup) < MAX_TEAM_UNITS:
            lookup.append([{"type": "WAIT"}])
        return lookup

    def _observation(self, perspective_side: str) -> dict[str, np.ndarray]:
        perspective_side = perspective_side.upper()
        state = json.loads(self.simulator.state_json())
        order = state["teams"][0 if perspective_side == "PLAYER" else 1]["action_order"]
        action_lookup = self._legal_action_lookup(perspective_side, order)
        if perspective_side == self.config.control_side:
            self._action_lookup = action_lookup
        frame = json.loads(self.simulator.training_frame_json(perspective_side))
        return {
            "units": np.asarray(frame["units"], dtype=np.float32),
            "unit_mask": np.asarray(frame["unit_mask"], dtype=np.int8),
            "global": np.asarray(frame["global"], dtype=np.float32),
            "action_mask": np.asarray(frame["action_mask"], dtype=np.int8),
            "actor_indices": np.asarray(frame["actor_indices"], dtype=np.int64),
        }

    def _controlled_damage(self, state: dict[str, Any]) -> int:
        controlled_side = self.config.control_side
        unit_sides = {int(unit_id): unit["side"] for unit_id, unit in state["units"].items()}
        return sum(
            amount
            for unit_id, amount in state["damage_by_source"].items()
            if unit_sides.get(int(unit_id)) == controlled_side
        )

    def _info(self) -> dict[str, Any]:
        state = json.loads(self.simulator.state_json())
        return {
            "state": state,
            "event_count": len(state["event_log"]),
            "rng_draws": state["rng"]["draws"],
            "terminal": state["terminal"],
        }
