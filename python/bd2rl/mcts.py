from __future__ import annotations

import hashlib
import json
import math
import random
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from . import _native


@dataclass(frozen=True)
class MctsConfig:
    simulations: int = 48
    rollout_depth: int = 8
    max_branching: int = 24
    exploration: float = math.sqrt(2.0)

    def validate(self) -> None:
        if self.simulations < 1:
            raise ValueError("MCTS simulations must be positive")
        if self.simulations > 2_048:
            raise ValueError("MCTS simulations must not exceed 2048 in debug play")
        if self.rollout_depth < 1:
            raise ValueError("MCTS rollout depth must be positive")
        if self.rollout_depth > 64:
            raise ValueError("MCTS rollout depth must not exceed 64 in debug play")
        if self.max_branching < 2:
            raise ValueError("MCTS max branching must be at least two")
        if self.max_branching > 256:
            raise ValueError("MCTS max branching must not exceed 256 in debug play")
        if not math.isfinite(self.exploration) or self.exploration <= 0:
            raise ValueError("MCTS exploration must be finite and positive")


@dataclass
class MctsResult:
    plan: dict[str, Any]
    simulations: int
    root_value: float
    candidates: int


@dataclass
class _Node:
    state_json: str
    active_side: str | None
    terminal: dict[str, Any] | None
    action: dict[str, Any] | None = None
    visits: int = 0
    value_sum: float = 0.0
    unexpanded: list[dict[str, Any]] | None = None
    children: list[_Node] = field(default_factory=list)

    @property
    def mean_value(self) -> float:
        return self.value_sum / self.visits if self.visits else 0.0


class MctsPlanner:
    """Deterministic, pretraining-free UCT search over complete team-turn plans."""

    def __init__(
        self,
        database: Path,
        setup_json: str,
        seed: int,
        config: MctsConfig | None = None,
    ) -> None:
        self.database = database.resolve()
        self.setup_json = setup_json
        self.seed = seed
        self.config = config or MctsConfig()
        self.config.validate()
        self._sandbox = _native.Simulator(str(self.database), setup_json, seed)

    def choose(self, live_simulator: _native.Simulator, side: str) -> MctsResult:
        side = side.upper()
        root_json = live_simulator.state_json()
        root_state = json.loads(root_json)
        if root_state["terminal"] is not None:
            raise RuntimeError("MCTS cannot act in a terminal state")
        if root_state["active_side"] != side:
            raise RuntimeError(
                f"MCTS side is {side}, but active side is {root_state['active_side']}"
            )
        digest = hashlib.blake2b(root_json.encode(), digest_size=8).digest()
        search_seed = self.seed ^ int.from_bytes(digest, "little")
        rng = random.Random(search_seed)
        self._sandbox.restore_json(root_json)
        root = self._node(root_json, rng)
        root_candidates = len(root.unexpanded or [])
        if root_candidates == 0:
            raise RuntimeError("MCTS found no legal team-turn plan")

        for _ in range(self.config.simulations):
            node = root
            path = [root]
            while node.terminal is None:
                if node.unexpanded:
                    action = node.unexpanded.pop(rng.randrange(len(node.unexpanded)))
                    self._sandbox.restore_json(node.state_json)
                    self._sandbox.step_json(self._canonical(action))
                    child_json = self._sandbox.state_json()
                    child = self._node(child_json, rng, action)
                    node.children.append(child)
                    node = child
                    path.append(node)
                    break
                if not node.children:
                    break
                node = self._select_child(node, side)
                path.append(node)

            value = self._rollout(node.state_json, side, rng)
            for visited in path:
                visited.visits += 1
                visited.value_sum += value

        best = max(
            root.children,
            key=lambda child: (child.visits, child.mean_value, -len(self._canonical(child.action))),
        )
        return MctsResult(
            plan=best.action or {},
            simulations=self.config.simulations,
            root_value=root.mean_value,
            candidates=root_candidates,
        )

    def _node(
        self,
        state_json: str,
        rng: random.Random,
        action: dict[str, Any] | None = None,
    ) -> _Node:
        state = json.loads(state_json)
        terminal = state["terminal"]
        active_side = None if terminal is not None else state["active_side"]
        unexpanded: list[dict[str, Any]] = []
        if terminal is None:
            self._sandbox.restore_json(state_json)
            unexpanded = self._candidate_plans(active_side, rng)
        return _Node(state_json, active_side, terminal, action, unexpanded=unexpanded)

    def _candidate_plans(self, side: str, rng: random.Random) -> list[dict[str, Any]]:
        legal = json.loads(self._sandbox.legal_actions_json(side))
        auto_plan = json.loads(self._sandbox.auto_plan_json(side))
        order = [entry["unit_id"] for entry in legal]
        commands_by_actor = [entry["commands"] or [{"type": "NORMAL_ATTACK"}] for entry in legal]
        candidates: dict[str, dict[str, Any]] = {}

        def add(commands: list[dict[str, Any]], action_order: list[int] | None = None) -> None:
            plan = {
                "side": side,
                "order": action_order or order,
                "commands": {
                    str(actor): command for actor, command in zip(order, commands, strict=True)
                },
                "formation": {},
            }
            candidates.setdefault(self._canonical(plan), plan)

        if order:
            candidates[self._canonical(auto_plan)] = auto_plan
            add([commands[0] for commands in commands_by_actor])
            add([commands[-1] for commands in commands_by_actor])
            auto_commands = [
                auto_plan.get("commands", {}).get(str(actor), commands[0])
                for actor, commands in zip(order, commands_by_actor, strict=True)
            ]
            if len(order) > 1:
                add(auto_commands, list(reversed(order)))
                for actor in order[1:]:
                    add(auto_commands, [actor, *(item for item in order if item != actor)])
            for actor_index, commands in enumerate(commands_by_actor):
                for command in commands:
                    varied = list(auto_commands)
                    varied[actor_index] = command
                    add(varied)
                    if len(candidates) >= self.config.max_branching:
                        break
                if len(candidates) >= self.config.max_branching:
                    break
            attempts = 0
            while len(candidates) < self.config.max_branching and attempts < 256:
                shuffled = list(order)
                rng.shuffle(shuffled)
                add([rng.choice(commands) for commands in commands_by_actor], shuffled)
                attempts += 1
        return list(candidates.values())[: self.config.max_branching]

    def _select_child(self, node: _Node, root_side: str) -> _Node:
        maximize = node.active_side == root_side
        log_parent = math.log(max(node.visits, 1))

        def score(child: _Node) -> float:
            exploit = child.mean_value if maximize else -child.mean_value
            explore = self.config.exploration * math.sqrt(log_parent / max(child.visits, 1))
            return exploit + explore

        return max(node.children, key=score)

    def _rollout(self, state_json: str, root_side: str, rng: random.Random) -> float:
        self._sandbox.restore_json(state_json)
        state = json.loads(state_json)
        for _ in range(self.config.rollout_depth):
            if state["terminal"] is not None:
                break
            side = state["active_side"]
            if rng.random() < 0.75:
                plan = self._sandbox.auto_plan_json(side)
            else:
                plans = self._candidate_plans(side, rng)
                plan = self._canonical(rng.choice(plans))
            self._sandbox.step_json(plan)
            state = json.loads(self._sandbox.state_json())
        return self._evaluate(state, root_side)

    @staticmethod
    def _evaluate(state: dict[str, Any], root_side: str) -> float:
        terminal = state["terminal"]
        if terminal is not None:
            player_value = {"WIN": 1.0, "LOSS": -1.0, "DRAW": 0.0, "SCORE_ONLY": 0.0}[
                terminal["outcome"]
            ]
            return player_value if root_side == "PLAYER" else -player_value

        def side_score(side: str) -> tuple[float, int]:
            units = [
                unit
                for unit in state["units"].values()
                if unit["side"] == side and unit.get("can_act", True)
            ]
            hp = sum(
                max(0.0, min(1.0, unit["hp"] / max(1, unit["base_stats"]["max_hp"])))
                for unit in units
                if unit["alive"]
            )
            alive = sum(bool(unit["alive"]) for unit in units)
            return hp / max(1, len(units)), alive

        opponent = "ENEMY" if root_side == "PLAYER" else "PLAYER"
        own_hp, own_alive = side_score(root_side)
        other_hp, other_alive = side_score(opponent)
        material = (own_hp - other_hp) * 0.65
        survival = (own_alive - other_alive) / 5.0 * 0.35
        return max(-0.99, min(0.99, material + survival))

    @staticmethod
    def _canonical(value: Any) -> str:
        return json.dumps(value, sort_keys=True, separators=(",", ":"))
