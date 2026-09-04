from __future__ import annotations

import json
import sqlite3
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest
from bd2rl._native import BatchSimulator, Simulator
from bd2rl.env import (
    ACTION_FEATURES,
    BLESSING_FEATURES,
    COSTUME_FEATURES,
    EFFECT_FEATURES,
    GLOBAL_FEATURES,
    GOLDEN_FEATURES,
    GRID_FEATURES,
    MAX_ACTIONS_PER_UNIT,
    MAX_ACTIVE_EFFECTS,
    MAX_BLESSINGS_PER_SIDE,
    MAX_COSTUMES_PER_UNIT,
    MAX_GRID_SIZE,
    MAX_MONSTER_LEVELS,
    MAX_TEAM_UNITS,
    MAX_TOTAL_UNITS,
    MONSTER_FEATURES,
    MONSTER_LEVEL_FEATURES,
    OBSERVATION_KEYS,
    UNIT_FEATURES,
    Bd2Env,
    EnvConfig,
    terminal_reward_for,
)


def test_training_import_does_not_load_gui_or_http_server() -> None:
    probe = """
import json
import sys
import bd2rl.train
forbidden = [name for name in sys.modules if name == 'bd2rl.gui' or name.startswith('http.server')]
print(json.dumps(forbidden))
"""
    completed = subprocess.run(
        [sys.executable, "-c", probe],
        check=True,
        capture_output=True,
        text=True,
    )
    assert json.loads(completed.stdout) == []


ROOT = Path(__file__).resolve().parents[2]
DATABASE = ROOT / "data/generated/bd2.sqlite"
CATALOG = ROOT / "data/generated/catalog.json"
MONSTER_SCENARIO = ROOT / "data/scenarios/monster-chaser-current.json"
GOLDEN_SCENARIO = ROOT / "data/scenarios/golden-colosseum-reference.json"


def event_kinds(transition: dict[str, object]) -> list[dict[str, object]]:
    return [event["kind"] for event in transition["events"]]  # type: ignore[index]


def test_new_battle_reuses_catalog_without_sharing_runtime_state() -> None:
    setup_json = MONSTER_SCENARIO.read_text(encoding="utf-8")
    source = Simulator(str(DATABASE), setup_json, 7)
    sibling = source.new_battle(setup_json, 7)
    baseline = sibling.state_json()

    assert source.state_json() == baseline
    source.step_auto_json()
    assert source.state_json() != baseline
    assert sibling.state_json() == baseline


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
    for costume in player_costumes:
        masks_by_progression: dict[tuple[int, int], set[int]] = {}
        for variant in costume["variants"]:
            key = (variant["enhancement"], variant["burst_level"])
            masks_by_progression.setdefault(key, set()).add(variant["potential_mask"])
        assert masks_by_progression
        assert all(masks == set(range(8)) for masks in masks_by_progression.values())
    all_range_costumes = {
        costume["id"]
        for costume in player_costumes
        if costume["source"]["raw_payload"]["range"].endswith("_all")
    }
    assert all_range_costumes == {
        "Lathel_3",
        "Rou_2",
        "Teresse_3",
        "Helena_1",
        "Helena_2",
        "Eleaneer_3",
        "Liberta_1",
        "Liberta_2",
        "Granadair_1",
    }
    assert all(
        variant["target_all"]
        for costume_id in all_range_costumes
        for variant in catalog["costumes"][costume_id]["variants"]
    )

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
    assert (
        sum(
            character["target_selector"] == "SKIP"
            for character in catalog["characters"].values()
            if ":" not in character["id"]
        )
        == 24
    )
    blade = max_variant("Blade_1")
    blade_damage = next(
        operation for operation in blade["operations"] if operation["op"] == "DEAL_DAMAGE"
    )
    blade_counter = next(
        operation["effect"]["counter"]
        for operation in blade["operations"]
        if operation.get("effect", {}).get("counter")
    )
    assert blade_damage["coefficient_bp"] == 70_000
    assert blade_counter["coefficient_bp"] == 20_000
    for counter_only in ("Sylvia_1", "Lecliss_2"):
        assert all(
            operation["op"] != "DEAL_DAMAGE"
            for operation in max_variant(counter_only)["operations"]
        )
    elise = max_variant("Elise_3")
    assert any(
        operation.get("effect", {}).get("modifiers", {}).get("outgoing_damage_bp") == 15_000
        for operation in elise["operations"]
    )
    rou_evasion = next(
        operation["effect"]
        for operation in max_variant("Rou_1")["operations"]
        if "EVASION" in operation.get("effect", {}).get("tags", [])
    )
    assert rou_evasion["modifiers"]["evasion_bp"] == 7_500
    assert rou_evasion["evasion_decay_bp"] == 500
    yuri_stacked = next(
        variant
        for variant in catalog["costumes"]["Yuri_2"]["variants"]
        if variant["enhancement"] == 5
        and variant["burst_level"] == 3
        and variant["potential_mask"] == 0
    )
    assert (
        sum(
            operation.get("effect", {}).get("effect_id") == "Yuri_2:STAT:0"
            for operation in yuri_stacked["operations"]
        )
        == 2
    )
    for multi_stat_costume in (
        "Lathel_3",
        "Gray_4",
        "Rou_2",
        "Elise_1",
        "Helena_2",
        "Michaela_3",
        "Liberta_2",
        "Granadair_1",
    ):
        effect_ids = [
            operation["effect"]["effect_id"]
            for operation in max_variant(multi_stat_costume)["operations"]
            if operation["op"] == "APPLY_EFFECT" and ":STAT:" in operation["effect"]["effect_id"]
        ]
        assert len(effect_ids) >= 2
        assert len(effect_ids) == len(set(effect_ids))
    assert [operation["op"] for operation in max_variant("Gray_2")["operations"][:2]] == [
        "DEAL_DAMAGE",
        "APPLY_EFFECT",
    ]
    assert [operation["op"] for operation in max_variant("Venaka_1")["operations"][:2]] == [
        "APPLY_EFFECT",
        "DEAL_DAMAGE",
    ]
    venaka_burst_cooldowns = [
        variant["cooldown"]
        for variant in catalog["costumes"]["Venaka_1"]["variants"]
        if variant["enhancement"] == 5 and variant["potential_mask"] == 0
    ]
    assert venaka_burst_cooldowns == [5, 3, 3, 3]
    rafina_operations = max_variant("Rafina_1")["operations"]
    rafina_order = [
        next(
            index
            for index, operation in enumerate(rafina_operations)
            if operation["op"] == "REMOVE_EFFECTS_BY_TAG" and operation["tag"] == tag
        )
        for tag in ("BARRIER", "ENERGY_GUARD")
    ]
    rafina_order.append(
        next(
            index
            for index, operation in enumerate(rafina_operations)
            if operation["op"] == "DEAL_DAMAGE"
        )
    )
    assert rafina_order == sorted(rafina_order)
    assert [operation["op"] for operation in max_variant("Scheherazade_1")["operations"][:2]] == [
        "DEAL_DAMAGE",
        "REMOVE_EFFECTS",
    ]
    luvencia = max_variant("Luvencia_3")
    assert not any(
        operation.get("effect", {}).get("effect_id") == "Luvencia_3:STAT:0"
        for operation in luvencia["operations"]
    )
    assert any(
        operation.get("effect", {}).get("on_chain_dealt") for operation in luvencia["operations"]
    )
    for costume_id, potential_index, expected_cooldown in (
        ("Scheherazade_4", 2, 3),
        ("Anastasia_1", 1, 3),
        ("Eleaneer_3", 1, 13),
        ("Yuri_1", 0, 3),
        ("Olivier_4", 2, 13),
    ):
        costume = catalog["costumes"][costume_id]
        enhanced = max(variant["enhancement"] for variant in costume["variants"])
        unlocked = next(
            variant
            for variant in costume["variants"]
            if variant["enhancement"] == enhanced
            and variant["burst_level"] == 0
            and variant["potential_mask"] == (1 << potential_index)
        )
        assert unlocked["cooldown"] == expected_cooldown
    assert any(
        operation.get("effect", {}).get("on_hit_received_operations")
        for operation in max_variant("Aquila_1")["operations"]
    )
    assert any(
        operation.get("effect", {}).get("on_hit_received_operations")
        for operation in max_variant("Mamonir_2")["operations"]
    )
    refithea_guard = next(
        operation["effect"]["barrier"]
        for operation in max_variant("Refithea_2")["operations"]
        if operation.get("effect", {}).get("barrier")
    )
    rou_guard = next(
        operation["effect"]["barrier"]
        for operation in max_variant("Rou_2")["operations"]
        if operation.get("effect", {}).get("barrier")
    )
    assert refithea_guard["reference"] == "TARGET_MAX_HP"
    assert rou_guard["reference"] == "MAX_HP"
    with sqlite3.connect(DATABASE) as connection:
        active_ruleset = connection.execute(
            "SELECT ruleset_id FROM catalog_versions WHERE active = 1"
        ).fetchone()[0]
        assert connection.execute(
            "SELECT COUNT(*) FROM skill_variants WHERE ruleset_id = ?", (active_ruleset,)
        ).fetchone()[0] == len(variants)


def test_every_source_semantic_tag_has_typed_catalog_evidence() -> None:
    result = subprocess.run(
        ["node", str(ROOT / "tools/validate-catalog.mjs"), str(CATALOG)],
        check=True,
        capture_output=True,
        text=True,
    )
    report = json.loads(result.stdout)
    assert report["catalog"] == str(CATALOG)
    assert report["ruleset"].startswith("bd2-current-")
    assert report["characters"] == 66
    assert report["costumes"] == 164
    assert report["variants"] == 12_509
    assert report["lineageChecks"] >= 40_000
    assert report["status"] == "ok"


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
    # Lathel_4 is a current preemptive skill and pays 1 SP during initialization.
    assert observation["global"][10] == pytest.approx(14 / 20)
    assert observation["global"][11] == pytest.approx(0 / 20)
    assert observation["actor_indices"].shape == (MAX_TEAM_UNITS,)
    assert observation["costumes"].shape == (
        MAX_TOTAL_UNITS,
        MAX_COSTUMES_PER_UNIT,
        COSTUME_FEATURES,
    )
    assert observation["effects"].shape == (MAX_ACTIVE_EFFECTS, EFFECT_FEATURES)
    assert observation["monster"].shape == (MONSTER_FEATURES,)
    assert observation["monster_levels"].shape == (
        MAX_MONSTER_LEVELS,
        MONSTER_LEVEL_FEATURES,
    )
    assert observation["golden"].shape == (GOLDEN_FEATURES,)
    assert observation["blessings"].shape == (
        2,
        MAX_BLESSINGS_PER_SIDE,
        BLESSING_FEATURES,
    )
    assert observation["grid"].shape == (MAX_GRID_SIZE, MAX_GRID_SIZE, GRID_FEATURES)
    assert observation["action_features"].shape == (
        MAX_TEAM_UNITS,
        MAX_ACTIONS_PER_UNIT,
        ACTION_FEATURES,
    )
    assert observation["team_order_indices"].shape == (2, MAX_TEAM_UNITS)
    assert int(observation["unit_mask"].sum()) == 18
    snapshot = environment.snapshot_json()
    actions = np.zeros(MAX_TEAM_UNITS, dtype=np.int64)
    first = environment.step(actions)
    environment.restore_json(snapshot)
    second = environment.step(actions)
    for key in OBSERVATION_KEYS:
        np.testing.assert_array_equal(first[0][key], second[0][key])
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


def test_native_numpy_batch_path_is_exactly_equivalent_to_json_path() -> None:
    setup_json = MONSTER_SCENARIO.read_text(encoding="utf-8")
    direct = BatchSimulator(str(DATABASE), setup_json, 4, 97)
    legacy = BatchSimulator(str(DATABASE), setup_json, 4, 97)

    direct_observations = direct.observations_numpy()
    legacy_observations = json.loads(legacy.observations_json())
    for key in OBSERVATION_KEYS:
        expected = np.asarray(
            [frame[key] for frame in legacy_observations],
            dtype=np.asarray(direct_observations[key]).dtype,
        )
        np.testing.assert_array_equal(np.asarray(direct_observations[key]), expected)

    actions = [[0] * MAX_TEAM_UNITS for _ in range(4)]
    direct_frames, direct_rewards, direct_dones = direct.step_numpy(actions)
    legacy_outputs = json.loads(legacy.step_json(json.dumps(actions)))
    for key in OBSERVATION_KEYS:
        expected = np.asarray(
            [item["observation"][key] for item in legacy_outputs],
            dtype=np.asarray(direct_frames[key]).dtype,
        )
        np.testing.assert_array_equal(np.asarray(direct_frames[key]), expected)
    np.testing.assert_array_equal(
        np.asarray(direct_rewards),
        np.asarray([item["reward"] for item in legacy_outputs], dtype=np.float32),
    )
    np.testing.assert_array_equal(
        np.asarray(direct_dones),
        np.asarray([item["done"] for item in legacy_outputs], dtype=np.bool_),
    )

    direct_reset = direct.reset_all_numpy()
    legacy_reset = json.loads(legacy.reset_all_json())
    for key in OBSERVATION_KEYS:
        expected = np.asarray(
            [frame[key] for frame in legacy_reset],
            dtype=np.asarray(direct_reset[key]).dtype,
        )
        np.testing.assert_array_equal(np.asarray(direct_reset[key]), expected)


def test_gymnasium_contract() -> None:
    config = EnvConfig(DATABASE, ROOT / "data/scenarios/normal-demo.json", seed=31)
    environment = Bd2Env(config)
    observation, _ = environment.reset(seed=31)
    assert environment.observation_space.contains(observation)
    action = np.zeros(MAX_TEAM_UNITS, dtype=np.int64)
    assert environment.action_space.contains(action)
    transition = environment.step(action)
    assert len(transition) == 5
    with pytest.raises(ValueError, match="masked action selected"):
        environment.reset(seed=31)
        environment.step(np.full(MAX_TEAM_UNITS, MAX_ACTIONS_PER_UNIT - 1, dtype=np.int64))


def test_golden_colosseum_environment_exposes_eleven_slots_and_only_auto_advances() -> None:
    environment = Bd2Env(EnvConfig(DATABASE, GOLDEN_SCENARIO, seed=5))
    observation, info = environment.reset()
    assert observation["actor_indices"].shape == (11,)
    assert observation["action_mask"].shape == (MAX_TEAM_UNITS, MAX_ACTIONS_PER_UNIT)
    assert observation["action_mask"][:, 0].all()
    assert not observation["action_mask"][:, 1:].any()
    assert observation["global"].shape == (GLOBAL_FEATURES,)
    assert observation["global"][3] == 1.0
    initial_sequence = info["state"]["action_sequence"]
    _, _, _, _, next_info = environment.step(
        np.full(MAX_TEAM_UNITS, MAX_ACTIONS_PER_UNIT - 1, dtype=np.int64)
    )
    # The policy indices cannot override a fully automatic Colosseum action.
    assert next_info["state"]["action_sequence"] > initial_sequence


def test_native_batch_auto_advances_golden_colosseum_without_team_plan() -> None:
    batch = BatchSimulator(str(DATABASE), GOLDEN_SCENARIO.read_text(encoding="utf-8"), 3, 9)
    frames = json.loads(batch.observations_json())
    assert all(frame["global"][3] == 1.0 for frame in frames)
    result = json.loads(
        batch.step_json(json.dumps([[MAX_ACTIONS_PER_UNIT - 1] * MAX_TEAM_UNITS] * 3))
    )
    assert len(result) == 3
    assert all(len(item["observation"]["actor_indices"]) == MAX_TEAM_UNITS for item in result)


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
