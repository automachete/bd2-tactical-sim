from __future__ import annotations

import json
from pathlib import Path

import pytest
from bd2rl._native import Simulator
from hypothesis import HealthCheck, settings
from hypothesis.stateful import RuleBasedStateMachine, invariant, precondition, rule
from hypothesis.strategies import integers, sampled_from

ROOT = Path(__file__).resolve().parents[2]
DATABASE = ROOT / "data/generated/bd2.sqlite"
SCENARIOS = {
    mode: ROOT / path
    for mode, path in {
        "NORMAL": "data/scenarios/normal-demo.json",
        "MIRROR_WAR": "data/scenarios/mirror-war-demo.json",
        "MONSTER_CHASER": "data/scenarios/monster-chaser-current.json",
        "GOLDEN_COLOSSEUM": "data/scenarios/golden-colosseum-reference.json",
    }.items()
}


class BattleStateMachine(RuleBasedStateMachine):
    def __init__(self) -> None:
        super().__init__()
        self.setup_json = SCENARIOS["NORMAL"].read_text(encoding="utf-8")
        self.simulator = Simulator(str(DATABASE), self.setup_json, 0)

    @rule(mode=sampled_from(tuple(SCENARIOS)), seed=integers(min_value=0, max_value=2**64 - 1))
    def restart_in_any_mode(self, mode: str, seed: int) -> None:
        self.setup_json = SCENARIOS[mode].read_text(encoding="utf-8")
        self.simulator = self.simulator.new_battle(self.setup_json, seed)

    @precondition(lambda self: json.loads(self.simulator.state_json())["terminal"] is None)
    @rule()
    def step_and_replay_from_snapshot(self) -> None:
        before = self.simulator.state_json()
        sibling = self.simulator.new_battle(self.setup_json, 0)
        sibling.restore_json(before)
        first = self.simulator.step_auto_json()
        second = sibling.step_auto_json()
        assert first == second
        assert self.simulator.state_json() == sibling.state_json()

    @rule(corruption=integers(min_value=0, max_value=4))
    def corrupt_restore_fails_atomically(self, corruption: int) -> None:
        before = self.simulator.state_json()
        state = json.loads(before)
        if corruption == 0:
            state["teams"][0]["sp"] = 21
        elif corruption == 1:
            state["event_sequence"] += 1
        elif corruption == 2:
            state["game_turn"] = 0
        elif corruption == 3:
            first = next(iter(state["units"].values()))
            first["position"]["row"] = state["rules"]["grid"]["rows"]
        else:
            state["teams"].reverse()
        with pytest.raises(ValueError):
            self.simulator.restore_json(json.dumps(state, separators=(",", ":")))
        assert self.simulator.state_json() == before

    @invariant()
    def externally_visible_state_obeys_runtime_invariants(self) -> None:
        state = json.loads(self.simulator.state_json())
        assert [team["side"] for team in state["teams"]] == ["PLAYER", "ENEMY"]
        assert state["rules"]["sp_cap"] == 20
        assert all(0 <= team["sp"] <= 20 for team in state["teams"])
        assert state["event_sequence"] == len(state["event_log"])
        assert [event["sequence"] for event in state["event_log"]] == list(
            range(len(state["event_log"]))
        )
        for side in ("PLAYER", "ENEMY"):
            occupied = [
                (unit["position"]["row"], unit["position"]["depth"])
                for unit in state["units"].values()
                if unit["side"] == side and unit["alive"]
            ]
            assert len(occupied) == len(set(occupied))
        assert all(unit["hp"] >= 0 for unit in state["units"].values())
        assert all(unit["hp"] > 0 for unit in state["units"].values() if unit["alive"])


TestBattleStateMachine = BattleStateMachine.TestCase
TestBattleStateMachine.settings = settings(
    max_examples=32,
    stateful_step_count=24,
    deadline=None,
    suppress_health_check=(HealthCheck.too_slow,),
)
