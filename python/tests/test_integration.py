from __future__ import annotations

import json
import sqlite3
import subprocess
from pathlib import Path

import numpy as np
import pytest
from bd2rl._native import BatchSimulator, Simulator
from bd2rl.env import (
    GLOBAL_FEATURES,
    MAX_TEAM_UNITS,
    MAX_TOTAL_UNITS,
    UNIT_FEATURES,
    Bd2Env,
    EnvConfig,
    terminal_reward_for,
)
from gymnasium.utils.env_checker import check_env

ROOT = Path(__file__).resolve().parents[2]
DATABASE = ROOT / "data/generated/bd2.sqlite"
CATALOG = ROOT / "data/generated/catalog.json"
MONSTER_SCENARIO = ROOT / "data/scenarios/monster-chaser-current.json"


def event_kinds(transition: dict[str, object]) -> list[dict[str, object]]:
    return [event["kind"] for event in transition["events"]]  # type: ignore[index]


def test_generated_catalog_and_database_have_every_variant() -> None:
    catalog = json.loads(CATALOG.read_text(encoding="utf-8"))
    variants = [
        variant for costume in catalog["costumes"].values() for variant in costume["variants"]
    ]
    assert len(catalog["characters"]) == 66
    assert len(catalog["costumes"]) == 164
    assert len(variants) == 12_509
    assert all(variant["executable"] for variant in variants)
    player_costumes = [
        costume
        for costume in catalog["costumes"].values()
        if not costume["id"].startswith(("fiend:", "summon:"))
    ]
    assert len(player_costumes) == 155
    assert all(costume["permanent_potential_modifiers"] for costume in player_costumes)
    assert all(costume["bonding_modifiers"] for costume in player_costumes)

    def max_variant(costume_id: str) -> dict[str, object]:
        return max(
            catalog["costumes"][costume_id]["variants"],
            key=lambda variant: (
                variant["enhancement"],
                variant["burst_level"],
                variant["potential_mask"],
            ),
        )

    assert [operation["op"] for operation in max_variant("Justia_3")["operations"][:2]] == [
        "REMOVE_EFFECTS_BY_TAG",
        "REMOVE_EFFECTS_BY_TAG",
    ]
    assert max_variant("Helena_3")["selector"] == "NEXT_ALLY_IN_ORDER"
    assert any(
        operation.get("effect", {}).get("on_hit_received_operations")
        for operation in max_variant("Aquila_1")["operations"]
    )
    assert any(
        operation.get("effect", {}).get("on_hit_received_operations")
        for operation in max_variant("Mamonir_2")["operations"]
    )
    with sqlite3.connect(DATABASE) as connection:
        assert connection.execute("SELECT COUNT(*) FROM skill_variants").fetchone()[0] == len(
            variants
        )


def test_every_source_semantic_tag_has_typed_catalog_evidence() -> None:
    result = subprocess.run(
        ["node", str(ROOT / "tools/validate-catalog.mjs"), str(CATALOG)],
        check=True,
        capture_output=True,
        text=True,
    )
    report = json.loads(result.stdout)
    assert report == {
        "catalog": str(CATALOG),
        "ruleset": "bd2-current-2026-09-01",
        "characters": 66,
        "costumes": 164,
        "variants": 12_509,
        "status": "ok",
    }


def test_current_monster_ai_conditional_and_two_party_handoff() -> None:
    catalog = json.loads(CATALOG.read_text(encoding="utf-8"))
    monster = catalog["monsters"]["10072"]
    skills = [catalog["costumes"][skill_id]["variants"][0] for skill_id in monster["skill_ids"]]
    assert [operation["op"] for operation in skills[0]["operations"]] == [
        "APPLY_EFFECT",
        "DEAL_DAMAGE",
        "APPLY_EFFECT",
    ]
    assert [operation["op"] for operation in skills[4]["operations"]] == [
        "DEAL_DAMAGE",
        "CONDITIONAL",
        "APPLY_EFFECT",
    ]

    simulator = Simulator(str(DATABASE), MONSTER_SCENARIO.read_text(encoding="utf-8"), 7)
    initial = json.loads(simulator.state_json())
    assert initial["monster_chaser"]["selected_level"] == 6
    assert initial["monster_chaser"]["current_level"] == 1
    assert initial["monster_chaser"]["party_limit"] == 2
    assert initial["teams"][1]["action_order"] == [1001]
    assert len([unit for unit in initial["units"].values() if unit["side"] == "ENEMY"]) == 8

    boss_skills: list[str] = []
    conditional_before_handoff = 0
    handoff_seen = False
    for _ in range(16):
        transition = json.loads(simulator.step_auto_json())
        for event in event_kinds(transition):
            if event["type"] == "ACTION_STARTED" and event["actor_id"] == 1001:
                costume_id = event["command"].get("costume_id")
                if costume_id:
                    boss_skills.append(costume_id)
                    if costume_id.endswith("skill-5") and not handoff_seen:
                        conditional_before_handoff += 1
            if event["type"] == "MONSTER_PARTY_ACTIVATED":
                handoff_seen = True
                assert event["party_no"] == 2
                assert event["unit_ids"] == [101, 102, 103, 104, 105]
        if handoff_seen:
            break

    # Conditional skill 5 interrupts immediately after the PLAYER action that
    # reaches eight chains; it must not advance or reorder the normal sequence.
    normal_boss_skills = [skill for skill in boss_skills if not skill.endswith("skill-5")]
    assert normal_boss_skills[0].endswith("skill-1")
    assert normal_boss_skills[1].endswith("skill-2")
    assert conditional_before_handoff == 1
    assert handoff_seen


def test_snapshot_replay_and_gym_observation_cover_all_parts() -> None:
    config = EnvConfig(DATABASE, MONSTER_SCENARIO, seed=19)
    environment = Bd2Env(config)
    observation, _ = environment.reset()
    assert observation["units"].shape == (MAX_TOTAL_UNITS, UNIT_FEATURES)
    assert observation["global"].shape == (GLOBAL_FEATURES,)
    assert observation["actor_indices"].shape == (MAX_TEAM_UNITS,)
    assert int(observation["unit_mask"].sum()) == 18
    snapshot = environment.snapshot_json()
    actions = np.zeros(5, dtype=np.int64)
    first = environment.step(actions)
    environment.restore_json(snapshot)
    second = environment.step(actions)
    np.testing.assert_array_equal(first[0]["units"], second[0]["units"])
    assert first[1:] == second[1:]


def test_native_batch_frame_has_valid_padding_masks() -> None:
    batch = BatchSimulator(str(DATABASE), MONSTER_SCENARIO.read_text(encoding="utf-8"), 4, 23)
    observations = json.loads(batch.observations_json())
    assert len(observations) == 4
    assert all(len(frame["units"]) == MAX_TOTAL_UNITS for frame in observations)
    assert all(sum(frame["unit_mask"]) == 18 for frame in observations)
    assert all(all(any(slot) for slot in frame["action_mask"]) for frame in observations)
    assert all(len(frame["units"][0]) == UNIT_FEATURES for frame in observations)
    assert all(len(frame["global"]) == GLOBAL_FEATURES for frame in observations)
    assert all(len(frame["actor_indices"]) == MAX_TEAM_UNITS for frame in observations)

    environment = Bd2Env(EnvConfig(DATABASE, MONSTER_SCENARIO, seed=23))
    python_observation, _ = environment.reset(seed=23)
    np.testing.assert_allclose(observations[0]["units"], python_observation["units"])
    np.testing.assert_allclose(observations[0]["global"], python_observation["global"])
    np.testing.assert_array_equal(
        observations[0]["actor_indices"], python_observation["actor_indices"]
    )


def test_gymnasium_contract() -> None:
    config = EnvConfig(DATABASE, ROOT / "data/scenarios/normal-demo.json", seed=31)
    environment = Bd2Env(config)
    check_env(environment, skip_render_check=True)


def test_enemy_control_is_case_insensitive_starts_on_its_turn_and_inverts_outcome() -> None:
    environment = Bd2Env(
        EnvConfig(
            DATABASE,
            MONSTER_SCENARIO,
            seed=37,
            control_side="enemy",
            auto_opponent=True,
        )
    )
    observation, info = environment.reset()
    assert info["state"]["active_side"] == "ENEMY"
    assert observation["action_mask"].any()
    _, _, terminated, _, next_info = environment.step(np.zeros(MAX_TEAM_UNITS, dtype=np.int64))
    assert terminated or next_info["state"]["active_side"] == "ENEMY"
    assert terminal_reward_for("WIN", "ENEMY") == -1.0
    assert terminal_reward_for("LOSS", "enemy") == 1.0
    assert terminal_reward_for("DRAW", "ENEMY") == 0.0


def test_environment_rejects_an_unknown_control_side() -> None:
    with pytest.raises(ValueError, match="control_side"):
        Bd2Env(
            EnvConfig(
                DATABASE,
                ROOT / "data/scenarios/normal-demo.json",
                control_side="SPECTATOR",
            )
        )
