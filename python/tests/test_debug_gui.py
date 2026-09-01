from __future__ import annotations

import copy
import json
import threading
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

import pytest
from bd2rl._native import Simulator
from bd2rl.debug_setup import DebugSetupCatalog
from bd2rl.gui import GuiSession, _preview_footprint, handler_factory
from bd2rl.mcts import MctsConfig, MctsPlanner

ROOT = Path(__file__).resolve().parents[2]
DATABASE = ROOT / "data/generated/bd2.sqlite"
SCENARIOS = ROOT / "data/scenarios"
UI = ROOT / "ui"
FAST_MCTS = MctsConfig(simulations=6, rollout_depth=3, max_branching=8)


def wait_plan(simulator: Simulator, side: str) -> dict[str, object]:
    state = json.loads(simulator.state_json())
    index = 0 if side == "PLAYER" else 1
    order = state["teams"][index]["action_order"]
    return {
        "side": side,
        "order": order,
        "commands": {str(unit_id): {"type": "WAIT"} for unit_id in order},
        "formation": {},
    }


def maximum_loadout(catalog: DebugSetupCatalog, character_id: str) -> list[dict[str, object]]:
    return [
        {
            "costume_id": costume["id"],
            "enhancement": costume["max_enhancement"],
            "burst_level": costume["max_burst_level"],
            "potential_mask": costume["max_potential_mask"],
            "permanent_potential_enabled": True,
        }
        for costume in catalog.characters[character_id]["costumes"]
    ]


def test_debug_catalog_builds_all_three_modes_from_external_data() -> None:
    catalog = DebugSetupCatalog(DATABASE, SCENARIOS)
    public = catalog.public_payload()
    assert public["ruleset_id"] == "bd2-current-2026-09-02"
    assert len(public["characters"]) == 61
    first = public["characters"][0]
    assert {character["rarity"] for character in public["characters"]} == {5}
    assert "portrait_url" not in first
    costume = first["costumes"][0]
    assert "portrait_url" not in costume
    assert "http://" not in json.dumps(public)
    assert "https://" not in json.dumps(public)
    assert isinstance(costume["sp_cost"], int)
    assert isinstance(costume["cooldown"], int)
    assert isinstance(costume["range"], list)
    assert costume["operation_summary"]
    assert catalog.characters["Justia"]["name"] == "ユースティア"
    justia_costumes = {item["id"]: item for item in catalog.characters["Justia"]["costumes"]}
    assert justia_costumes["Justia_1"]["name"] == "白い死神"
    assert justia_costumes["Justia_1"]["range"] == [
        {"row": 0, "depth": 0},
        {"row": 0, "depth": 1},
    ]
    assert len(public["monster_skills"]) == 5
    assert all(skill["operation_summary"] for skill in public["monster_skills"])
    assert all(not isinstance(skill["condition"], dict) for skill in public["monster_skills"])
    conditional = next(skill for skill in public["monster_skills"] if skill["condition"])
    assert conditional["condition"] == "敵のいずれかのチェインが8以上"
    assert "[object Object]" not in json.dumps(public, ensure_ascii=False)
    assert all(
        raw not in json.dumps(public["monster_skills"], ensure_ascii=False)
        for raw in ("Conditional", "Instant Death", "Remove Effects By Tag")
    )
    entities = {item["id"]: item for item in public["entities"]}
    system_costumes = {item["id"]: item for item in public["system_costumes"]}
    assert entities["fiend:10072"]["name"] == "仇怨のキメラ（風）"  # noqa: RUF001
    assert entities["summon:PersonaOfWorship"]["name"] == "Persona of Worship"
    assert system_costumes["summon:PersonaOfWorship:skill"]["name"] == "精神崩潰"
    assert set(public["presets"]) == {"NORMAL", "MIRROR_WAR", "MONSTER_CHASER"}

    for mode, preset in public["presets"].items():
        setup = catalog.build_setup(preset)
        simulator = Simulator(str(DATABASE), json.dumps(setup), 13)
        state = json.loads(simulator.state_json())
        assert state["rules"]["mode"] == mode
        assert state["rules"]["allow_manual_commands"] == [True, False]
        assert state["active_side"] == "PLAYER"

    monster = catalog.build_setup(public["presets"]["MONSTER_CHASER"])
    parties = {unit["party_no"] for unit in monster["units"] if unit["side"] == "PLAYER"}
    assert parties == {1, 2}
    assert len([unit for unit in monster["units"] if unit["side"] == "ENEMY"]) == 8


def test_builder_defaults_to_every_costume_at_its_maximum_variant() -> None:
    catalog = DebugSetupCatalog(DATABASE, SCENARIOS)
    preset = catalog.public_payload()["presets"]["NORMAL"]
    unit_request = preset["player_units"][0]
    character = catalog.characters[unit_request["character_id"]]
    assert len(unit_request["costumes"]) == len(character["costumes"])
    by_id = {item["id"]: item for item in character["costumes"]}
    for loadout in unit_request["costumes"]:
        maximum = by_id[loadout["costume_id"]]
        assert loadout["enhancement"] == maximum["max_enhancement"]
        assert loadout["burst_level"] == maximum["max_burst_level"]
        assert loadout["potential_mask"] == maximum["max_potential_mask"]


def test_gui_payload_describes_the_exact_configured_costume_variant() -> None:
    session = GuiSession(DATABASE, SCENARIOS, 11, FAST_MCTS)
    request = session.catalog.public_payload()["presets"]["NORMAL"]
    loen = next(unit for unit in request["player_units"] if unit["character_id"] == "Loen")
    loadout = next(item for item in loen["costumes"] if item["costume_id"] == "Loen_1")
    loadout.update(enhancement=0, burst_level=0, potential_mask=0)

    payload = session.start(request)
    loen_id = next(
        int(unit_id)
        for unit_id, unit in payload["state"]["units"].items()
        if unit["character_id"] == "Loen" and unit["side"] == "PLAYER"
    )
    legal = next(item for item in payload["legal"] if item["unit_id"] == loen_id)
    command = next(item for item in legal["commands"] if item.get("costume_id") == "Loen_1")

    assert command["ui"]["range"] == [
        {"row": -1, "depth": 0},
        {"row": 0, "depth": -1},
        {"row": 0, "depth": 0},
        {"row": 0, "depth": 1},
        {"row": 1, "depth": 0},
    ]
    assert len(command["ui"]["range"]) < len(
        session.catalog.characters["Loen"]["costumes"][0]["range"]
    )


def test_gui_typed_equipment_changes_stats_but_not_skill_cost_metadata() -> None:
    session = GuiSession(DATABASE, SCENARIOS, 12, FAST_MCTS)
    request = session.catalog.public_payload()["presets"]["NORMAL"]
    loen = next(unit for unit in request["player_units"] if unit["character_id"] == "Loen")
    baseline = session.start(copy.deepcopy(request))
    baseline_loen = next(
        unit
        for unit in baseline["state"]["units"].values()
        if unit["character_id"] == "Loen" and unit["side"] == "PLAYER"
    )
    equipment = next(
        item
        for item in session.catalog.equipment.values()
        if item["kind"] == "CRAFTED_LEGENDARY" and item["slot"] == "WEAPON"
    )
    loen["equipment"] = {
        "WEAPON": {
            "equipment_id": equipment["id"],
            "refinement_score": 18,
            "primary_stat": None,
            "secondary_stat": None,
            "substats": [equipment["allowed_substats"][0]["key"]] * 3,
        }
    }
    payload = session.start(request)
    unit_id = next(
        int(unit_id)
        for unit_id, unit in payload["state"]["units"].items()
        if unit["character_id"] == "Loen" and unit["side"] == "PLAYER"
    )
    legal = next(entry for entry in payload["legal"] if entry["unit_id"] == unit_id)
    command = next(item for item in legal["commands"] if item.get("costume_id") == "Loen_1")
    variant = next(
        item for item in session.catalog.characters["Loen"]["costumes"] if item["id"] == "Loen_1"
    )

    assert command["ui"]["sp_cost"] == variant["sp_cost"]
    assert command["ui"]["cooldown"] == variant["cooldown"]
    assert payload["state"]["units"][str(unit_id)]["base_stats"] != baseline_loen["base_stats"]


def test_every_supported_equipment_can_initialize_a_real_battle_for_its_owner() -> None:
    catalog = DebugSetupCatalog(DATABASE, SCENARIOS)
    public = catalog.public_payload()
    characters = public["characters"]
    default_build = public["build_settings_default"]
    by_id = {character["id"]: character for character in characters}

    def unit(character_id: str, row: int, equipment: dict[str, object]) -> dict[str, object]:
        character = by_id[character_id]
        return {
            "character_id": character_id,
            "row": row,
            "depth": 0,
            "party_no": 1,
            "costumes": [
                {
                    "costume_id": costume["id"],
                    "enhancement": costume["max_enhancement"],
                    "burst_level": costume["max_burst_level"],
                    "potential_mask": costume["max_potential_mask"],
                    "permanent_potential_enabled": True,
                }
                for costume in character["costumes"]
            ],
            "costume_link_target": None,
            "equipment": equipment,
            "build_settings": copy.deepcopy(default_build),
        }

    fallback = characters[0]["id"]
    enemy_id = characters[1]["id"]
    initialized = 0
    for definition in catalog.equipment.values():
        character_id = definition["owner_character_id"] or fallback
        primary = (
            definition["primary_stat_options"][0]["key"]
            if definition["primary_stat_options"]
            else None
        )
        secondary = (
            definition["secondary_stat_options"][0]["key"]
            if definition["secondary_stat_options"]
            else None
        )
        substat = definition["allowed_substats"][0]["key"]
        loadout = {
            definition["slot"]: {
                "equipment_id": definition["id"],
                "refinement_score": 18,
                "primary_stat": primary,
                "secondary_stat": secondary,
                "substats": [substat, substat, substat],
            }
        }
        request = {
            "mode": "NORMAL",
            "player_units": [unit(character_id, 0, loadout)],
            "enemy_units": [unit(enemy_id, 1, {})],
        }
        setup = catalog.build_setup(request)
        simulator = Simulator(str(DATABASE), json.dumps(setup), 101)
        state = json.loads(simulator.state_json())
        assert state["units"]["1"]["character_id"] == character_id
        initialized += 1

    assert initialized == 91


def test_exclusive_equipment_rejects_wrong_owner_and_missing_main_ability() -> None:
    catalog = DebugSetupCatalog(DATABASE, SCENARIOS)
    request = catalog.public_payload()["presets"]["NORMAL"]
    unit = request["player_units"][0]
    definition = next(item for item in catalog.equipment.values() if item["kind"] == "EXCLUSIVE")
    substat = definition["allowed_substats"][0]["key"]
    unit["equipment"] = {
        definition["slot"]: {
            "equipment_id": definition["id"],
            "refinement_score": 18,
            "primary_stat": definition["primary_stat_options"][0]["key"],
            "secondary_stat": definition["secondary_stat_options"][0]["key"],
            "substats": [substat] * 3,
        }
    }
    if unit["character_id"] == definition["owner_character_id"]:
        unit["character_id"] = next(
            character_id
            for character_id in catalog.characters
            if character_id != definition["owner_character_id"]
        )
    with pytest.raises(ValueError, match="belongs to"):
        catalog.build_setup(request)

    unit["character_id"] = definition["owner_character_id"]
    owner = catalog.characters[definition["owner_character_id"]]
    unit["costumes"] = [
        {
            "costume_id": costume["id"],
            "enhancement": costume["max_enhancement"],
            "burst_level": costume["max_burst_level"],
            "potential_mask": costume["max_potential_mask"],
            "permanent_potential_enabled": True,
        }
        for costume in owner["costumes"]
    ]
    unit["equipment"][definition["slot"]]["primary_stat"] = None
    with pytest.raises(ValueError, match="primary_stat"):
        catalog.build_setup(request)


def test_preview_footprint_clips_deduplicates_and_tracks_only_occupied_targets() -> None:
    state = {
        "rules": {"grid": {"rows": 3, "depths": 4}},
        "units": {
            "1": {"alive": True, "side": "PLAYER"},
            "101": {"alive": True, "side": "ENEMY"},
            "102": {"alive": True, "side": "ENEMY"},
            "103": {"alive": False, "side": "ENEMY"},
        },
    }
    positions = {
        1: {"row": 2, "depth": 3},
        101: {"row": 0, "depth": 0},
        102: {"row": 1, "depth": 1},
        103: {"row": 1, "depth": 0},
    }
    command = {
        "type": "USE_COSTUME",
        "ui": {
            "range": [
                {"row": -1, "depth": 0},
                {"row": 0, "depth": 0},
                {"row": 0, "depth": 0},
                {"row": 0, "depth": 1},
                {"row": 1, "depth": 0},
            ]
        },
    }

    cells, targets = _preview_footprint(
        state, 1, command, "ENEMY", {"row": 0, "depth": 0}, positions
    )

    assert cells == [{"row": 0, "depth": 0}, {"row": 0, "depth": 1}, {"row": 1, "depth": 0}]
    assert targets == [101]


def test_preview_footprint_handles_normal_wait_and_target_all_without_guessing() -> None:
    state = {
        "rules": {"grid": {"rows": 3, "depths": 4}},
        "units": {
            "1": {"alive": True, "side": "PLAYER"},
            "2": {"alive": True, "side": "PLAYER"},
            "101": {"alive": True, "side": "ENEMY"},
        },
    }
    positions = {
        1: {"row": 0, "depth": 0},
        2: {"row": 2, "depth": 3},
        101: {"row": 1, "depth": 2},
    }

    normal_cells, normal_targets = _preview_footprint(
        state,
        1,
        {"type": "NORMAL_ATTACK"},
        "ENEMY",
        {"row": 1, "depth": 2},
        positions,
    )
    wait_cells, wait_targets = _preview_footprint(state, 1, {"type": "WAIT"}, None, None, positions)
    all_cells, all_targets = _preview_footprint(
        state,
        1,
        {"type": "USE_COSTUME", "ui": {"target_all": True, "range": []}},
        "PLAYER",
        {"row": 0, "depth": 0},
        positions,
    )

    assert normal_cells == [{"row": 1, "depth": 2}]
    assert normal_targets == [101]
    assert wait_cells == []
    assert wait_targets == []
    assert len(all_cells) == 12
    assert all_targets == [1, 2]


def test_builder_rejects_duplicate_character_in_the_same_party() -> None:
    catalog = DebugSetupCatalog(DATABASE, SCENARIOS)
    preset = catalog.public_payload()["presets"]["NORMAL"]
    preset["player_units"][1]["character_id"] = preset["player_units"][0]["character_id"]
    preset["player_units"][1]["costumes"] = json.loads(
        json.dumps(preset["player_units"][0]["costumes"])
    )
    with pytest.raises(ValueError, match="duplicate character"):
        catalog.build_setup(preset)


def test_builder_rejects_malformed_nested_values_instead_of_coercing_them() -> None:
    catalog = DebugSetupCatalog(DATABASE, SCENARIOS)
    preset = catalog.public_payload()["presets"]["NORMAL"]
    preset["player_units"][0]["costumes"][0]["permanent_potential_enabled"] = "false"
    with pytest.raises(ValueError, match="permanent_potential_enabled must be a boolean"):
        catalog.build_setup(preset)

    preset = catalog.public_payload()["presets"]["NORMAL"]
    preset["player_units"][0] = "Loen"
    with pytest.raises(ValueError, match="PLAYER unit entries must be objects"):
        catalog.build_setup(preset)


def test_mcts_is_deterministic_legal_and_does_not_mutate_live_state() -> None:
    catalog = DebugSetupCatalog(DATABASE, SCENARIOS)
    setup = catalog.build_setup(catalog.public_payload()["presets"]["MIRROR_WAR"])
    setup_json = json.dumps(setup)
    simulator = Simulator(str(DATABASE), setup_json, 17)
    simulator.step_json(json.dumps(wait_plan(simulator, "PLAYER")))
    before = simulator.state_json()

    first = MctsPlanner(DATABASE, setup_json, 17, FAST_MCTS).choose(simulator, "ENEMY")
    second = MctsPlanner(DATABASE, setup_json, 17, FAST_MCTS).choose(simulator, "ENEMY")
    assert first.plan == second.plan
    assert first.simulations == FAST_MCTS.simulations
    assert first.candidates >= 2
    assert simulator.state_json() == before

    simulator.step_json(json.dumps(first.plan))
    assert json.loads(simulator.state_json())["active_side"] == "PLAYER"


def test_gui_session_uses_mcts_and_monster_rule_controller() -> None:
    session = GuiSession(DATABASE, SCENARIOS, 23, FAST_MCTS)
    normal = session.step([2, 2, 2])
    assert normal["state"]["active_side"] == "PLAYER"
    assert normal["last_ai"]["controller"] == "MCTS"
    assert normal["last_ai"]["simulations"] == FAST_MCTS.simulations

    monster_request = session.catalog.public_payload()["presets"]["MONSTER_CHASER"]
    monster_request["mcts_simulations"] = FAST_MCTS.simulations
    monster = session.start(monster_request)
    assert monster["enemy_controller"] == "RULE_BASED"
    after_turn = session.step([2, 2, 2, 2, 2])
    assert after_turn["state"]["active_side"] == "PLAYER"
    assert after_turn["last_ai"] == {"controller": "RULE_BASED", "side": "ENEMY"}


def test_gui_payload_preserves_the_exact_editor_setup_and_mcts_configuration() -> None:
    session = GuiSession(DATABASE, SCENARIOS, 71, FAST_MCTS)
    request = session.catalog.public_payload()["presets"]["NORMAL"]
    unit = request["player_units"][0]
    unit["costumes"] = [
        {
            **unit["costumes"][0],
            "enhancement": 0,
            "potential_mask": 0,
            "permanent_potential_enabled": False,
        }
    ]
    unit["build_settings"]["external_buffs"]["crit_damage_bp"] = 1234
    request["seed"] = 73
    request["mcts_simulations"] = 7

    payload = session.start(request)

    restored = payload["setup"]["player_units"][0]
    assert payload["seed"] == 73
    assert payload["mcts"]["simulations"] == 7
    assert len(restored["costumes"]) == 1
    assert restored["costumes"][0]["enhancement"] == 0
    assert restored["costumes"][0]["potential_mask"] == 0
    assert restored["costumes"][0]["permanent_potential_enabled"] is False
    assert restored["build_settings"]["external_buffs"]["crit_damage_bp"] == 1234
    assert payload["state"]["units"]["1"]["base_stats"]["crit_damage_bp"] >= 1234


def test_gui_turn_is_atomic_when_automatic_opponent_fails(monkeypatch: pytest.MonkeyPatch) -> None:
    session = GuiSession(DATABASE, SCENARIOS, 79, FAST_MCTS)
    before = session.payload()
    order = before["state"]["teams"][0]["action_order"]
    waits = []
    for entry in before["legal"]:
        waits.append(
            next(i for i, command in enumerate(entry["commands"]) if command["type"] == "WAIT")
        )

    def fail_enemy() -> None:
        raise RuntimeError("forced opponent failure")

    monkeypatch.setattr(session, "_advance_enemy", fail_enemy)
    with pytest.raises(RuntimeError, match="forced opponent failure"):
        session.step(waits, order, {})

    after = session.payload()
    assert after["state"] == before["state"]
    assert after["can_rollback"] is False
    assert after["last_ai"] == before["last_ai"]


@pytest.mark.parametrize("invalid", [3.5, 0, 2049])
def test_invalid_mcts_configuration_is_rejected_without_replacing_the_battle(
    invalid: float | int,
) -> None:
    session = GuiSession(DATABASE, SCENARIOS, 81, FAST_MCTS)
    before = session.payload()
    request = session.catalog.public_payload()["presets"]["NORMAL"]
    request["mcts_simulations"] = invalid

    with pytest.raises(ValueError, match=r"MCTS|mcts_simulations"):
        session.start(request)

    after = session.payload()
    assert after["state"] == before["state"]
    assert after["mcts"] == before["mcts"]


def test_summon_legal_action_has_external_name_cost_range_and_summary() -> None:
    session = GuiSession(DATABASE, SCENARIOS, 83, FAST_MCTS)
    request = session.catalog.public_payload()["presets"]["NORMAL"]
    request["player_units"][0]["character_id"] = "Morpeah"
    request["player_units"][0]["costumes"] = maximum_loadout(session.catalog, "Morpeah")
    payload = session.start(request)
    summon = next(
        unit
        for unit in payload["state"]["units"].values()
        if unit["character_id"] == "summon:PersonaOfWorship"
    )
    legal = next(entry for entry in payload["legal"] if entry["unit_id"] == summon["id"])
    skill = next(command for command in legal["commands"] if command["type"] == "USE_COSTUME")

    assert skill["costume_id"] == "summon:PersonaOfWorship:skill"
    assert skill["ui"]["sp_cost"] >= 0
    assert skill["ui"]["range"]
    assert skill["ui"]["operation_summary"]


def test_gui_session_applies_formation_and_rolls_back_the_complete_player_turn() -> None:
    session = GuiSession(DATABASE, SCENARIOS, 31, FAST_MCTS)
    before = session.payload()
    order = before["state"]["teams"][0]["action_order"]
    moving = order[0]
    target = {"row": 2, "depth": 3}

    advanced = session.step([2] * len(order), order, {str(moving): target})

    assert advanced["state"]["units"][str(moving)]["position"] == target
    assert advanced["can_rollback"] is True
    restored = session.rollback()
    assert restored["state"] == before["state"]
    assert restored["can_rollback"] is False
    assert restored["last_ai"] is None


def test_gui_session_rejects_colliding_formation_without_mutating_state() -> None:
    session = GuiSession(DATABASE, SCENARIOS, 37, FAST_MCTS)
    before = session.payload()
    order = before["state"]["teams"][0]["action_order"]
    occupied = before["state"]["units"][str(order[1])]["position"]

    with pytest.raises(ValueError, match="invalid or occupied formation cell"):
        session.step([2] * len(order), order, {str(order[0]): occupied})

    assert session.payload()["state"] == before["state"]
    assert session.payload()["can_rollback"] is False


def test_gui_session_rejects_runtime_formation_in_mirror_war() -> None:
    session = GuiSession(DATABASE, SCENARIOS, 41, FAST_MCTS)
    mirror = session.catalog.public_payload()["presets"]["MIRROR_WAR"]
    before = session.start(mirror)
    order = before["state"]["teams"][0]["action_order"]

    with pytest.raises(ValueError, match="formation is locked"):
        session.step(
            [2] * len(order),
            order,
            {str(order[0]): {"row": 2, "depth": 3}},
        )

    assert session.payload()["state"] == before["state"]


def test_gui_target_preview_uses_rust_rules_without_mutating_live_state() -> None:
    session = GuiSession(DATABASE, SCENARIOS, 43, FAST_MCTS)
    before_json = session.simulator.state_json()
    preview_simulator_id = id(session.preview_simulator)
    payload = session.payload()
    order = payload["state"]["teams"][0]["action_order"]
    actor = order[0]
    actor_legal = next(item for item in payload["legal"] if item["unit_id"] == actor)
    skill_index = next(
        index
        for index, command in enumerate(actor_legal["commands"])
        if command.get("costume_id") == "Loen_1"
    )

    normal = session.preview(actor, 0, order, {})
    skill = session.preview(actor, skill_index, order, {})

    assert normal["command"] == {"type": "NORMAL_ATTACK"}
    assert normal["target_side"] == "ENEMY"
    assert normal["anchor"] == {"row": 0, "depth": 0}
    assert normal["affected_cells"] == [{"row": 0, "depth": 0}]
    assert normal["affected_unit_ids"] == [101]
    assert skill["command"]["type"] == "USE_COSTUME"
    assert len(skill["command"]["ui"]["range"]) == 9
    assert skill["anchor"] == {"row": 0, "depth": 0}
    assert skill["affected_cells"] == [
        {"row": 0, "depth": 0},
        {"row": 0, "depth": 1},
        {"row": 1, "depth": 0},
        {"row": 1, "depth": 1},
    ]
    assert skill["affected_unit_ids"] == [101, 102]
    assert session.simulator.state_json() == before_json
    assert id(session.preview_simulator) == preview_simulator_id


def test_every_five_star_legal_action_preview_matches_engine_target_lock() -> None:
    session = GuiSession(DATABASE, SCENARIOS, 83, FAST_MCTS)
    public = session.catalog.public_payload()
    checked = 0

    for character in public["characters"]:
        request = json.loads(json.dumps(public["presets"]["NORMAL"]))
        request["player_units"] = [
            request["player_units"][0],
            *[
                unit
                for unit in request["player_units"][1:]
                if unit["character_id"] != character["id"]
            ],
        ]
        request["player_units"][0]["character_id"] = character["id"]
        request["player_units"][0]["costumes"] = maximum_loadout(session.catalog, character["id"])
        payload = session.start(request)
        live_json = session.simulator.state_json()
        live_state = json.loads(live_json)
        before_count = len(live_state["event_log"])
        order = payload["state"]["teams"][0]["action_order"]
        actor = order[0]
        raw_legal = json.loads(session.simulator.legal_actions_json("PLAYER"))
        legal_by_id = {entry["unit_id"]: entry["commands"] for entry in raw_legal}
        direct = Simulator(str(DATABASE), session.setup_json, session.seed)

        for action_index, command in enumerate(legal_by_id[actor]):
            if command["type"] == "WAIT":
                continue
            preview = session.preview(actor, action_index, order, {})
            commands: dict[str, object] = {}
            for unit_id in order:
                choices = legal_by_id[unit_id]
                commands[str(unit_id)] = (
                    command
                    if unit_id == actor
                    else next(candidate for candidate in choices if candidate["type"] == "WAIT")
                )
            direct.restore_json(live_json)
            direct.step_json(
                json.dumps(
                    {
                        "side": "PLAYER",
                        "order": order,
                        "commands": commands,
                        "formation": {},
                    }
                )
            )
            events = json.loads(direct.state_json())["event_log"][before_count:]
            target_event = next(
                (
                    event["kind"]
                    for event in events
                    if event["kind"].get("actor_id") == actor
                    and event["kind"]["type"] in {"TARGET_LOCKED", "TARGET_CELL_LOCKED"}
                ),
                None,
            )
            actual_target = (
                int(target_event["target_id"])
                if target_event and target_event["type"] == "TARGET_LOCKED"
                else None
            )
            actual_anchor = None
            if target_event and target_event["type"] == "TARGET_CELL_LOCKED":
                actual_anchor = target_event["cell"]
            elif actual_target is not None:
                actual_anchor = live_state["units"][str(actual_target)]["position"]

            assert preview["target_id"] == actual_target, (character["id"], command)
            assert preview["anchor"] == actual_anchor, (character["id"], command)
            coordinates = {(cell["row"], cell["depth"]) for cell in preview["affected_cells"]}
            assert len(coordinates) == len(preview["affected_cells"])
            assert all(0 <= row < 3 and 0 <= depth < 4 for row, depth in coordinates)
            for unit_id in preview["affected_unit_ids"]:
                unit = live_state["units"][str(unit_id)]
                assert unit["alive"] is True
                assert (unit["position"]["row"], unit["position"]["depth"]) in coordinates
            checked += 1

    assert checked >= 250


def test_preview_matches_real_damage_after_formation_order_and_multi_action_planning() -> None:
    session = GuiSession(DATABASE, SCENARIOS, 47, FAST_MCTS)
    payload = session.payload()
    order = payload["state"]["teams"][0]["action_order"]
    actor = order[0]
    reordered = [order[1], actor, order[2]]
    formation = {str(actor): {"row": 2, "depth": 3}}
    legal_by_id = {entry["unit_id"]: entry["commands"] for entry in payload["legal"]}
    skill_index = next(
        index
        for index, command in enumerate(legal_by_id[actor])
        if command.get("costume_id") == "Loen_1"
    )

    preview = session.preview(actor, skill_index, reordered, formation)

    assert preview["anchor"] == {"row": 2, "depth": 0}
    assert preview["affected_cells"] == [
        {"row": 1, "depth": 0},
        {"row": 1, "depth": 1},
        {"row": 2, "depth": 0},
        {"row": 2, "depth": 1},
    ]
    assert preview["affected_unit_ids"] == [102, 103]

    action_indices = []
    for unit_id in reordered:
        commands = legal_by_id[unit_id]
        action_indices.append(
            skill_index
            if unit_id == actor
            else next(index for index, command in enumerate(commands) if command["type"] == "WAIT")
        )
    advanced = session.step(action_indices, reordered, formation)
    player_actions = [
        int(event["kind"]["actor_id"])
        for event in advanced["state"]["event_log"]
        if event["kind"]["type"] == "ACTION_STARTED" and int(event["kind"]["actor_id"]) < 100
    ]
    damage_targets = sorted(
        {
            int(event["kind"]["target_id"])
            for event in advanced["state"]["event_log"]
            if event["kind"]["type"] == "DAMAGE_APPLIED"
            and int(event["kind"].get("actor_id", -1)) == actor
        }
    )

    assert player_actions[:3] == reordered
    assert damage_targets == preview["affected_unit_ids"]
    assert advanced["state"]["units"][str(actor)]["position"] == formation[str(actor)]


def test_later_actor_preview_applies_earlier_reserved_kills_before_targeting() -> None:
    session = GuiSession(DATABASE, SCENARIOS, 59, FAST_MCTS)
    payload = session.payload()
    order = payload["state"]["teams"][0]["action_order"]
    legal_by_id = {entry["unit_id"]: entry["commands"] for entry in payload["legal"]}
    loen, later, final = order
    loen_skill = next(
        index
        for index, command in enumerate(legal_by_id[loen])
        if command.get("costume_id") == "Loen_1"
    )
    final_wait = next(
        index for index, command in enumerate(legal_by_id[final]) if command["type"] == "WAIT"
    )
    actions = [loen_skill, 0, final_wait]

    isolated = session.preview(later, 0, order, {}, [0, 0, final_wait])
    planned = session.preview(later, 0, order, {}, actions)

    assert isolated["target_id"] == 102
    assert isolated["anchor"] == {"row": 1, "depth": 0}
    assert planned["target_id"] == 103
    assert planned["anchor"] == {"row": 2, "depth": 0}
    assert planned["affected_unit_ids"] == [103]

    advanced = session.step(actions, order, {})
    actual = next(
        int(event["kind"]["target_id"])
        for event in advanced["state"]["event_log"]
        if event["kind"]["type"] == "TARGET_LOCKED"
        and int(event["kind"].get("actor_id", -1)) == later
    )
    assert actual == planned["target_id"]


def test_later_actor_preview_includes_a_summon_created_by_an_earlier_reservation() -> None:
    session = GuiSession(DATABASE, SCENARIOS, 61, FAST_MCTS)
    request = session.catalog.public_payload()["presets"]["NORMAL"]
    request["player_units"][0]["character_id"] = "Morpeah"
    request["player_units"][0]["costumes"] = maximum_loadout(session.catalog, "Morpeah")
    request["player_units"][1]["character_id"] = "Granadair"
    request["player_units"][1]["costumes"] = maximum_loadout(session.catalog, "Granadair")
    payload = session.start(request)
    order = payload["state"]["teams"][0]["action_order"]
    legal_by_id = {entry["unit_id"]: entry["commands"] for entry in payload["legal"]}
    summoner, actor = order[:2]
    summon_index = next(
        index
        for index, command in enumerate(legal_by_id[summoner])
        if command.get("costume_id") == "Morpeah_2"
    )
    wide_ally_index = next(
        index
        for index, command in enumerate(legal_by_id[actor])
        if command.get("costume_id") == "Granadair_2"
    )
    actions = []
    for unit_id in order:
        if unit_id == summoner:
            actions.append(summon_index)
        elif unit_id == actor:
            actions.append(wide_ally_index)
        else:
            actions.append(
                next(
                    index
                    for index, command in enumerate(legal_by_id[unit_id])
                    if command["type"] == "WAIT"
                )
            )

    before_ids = {int(unit_id) for unit_id in payload["state"]["units"]}
    preview = session.preview(actor, wide_ally_index, order, {}, actions)
    temporary = Simulator(str(DATABASE), session.setup_json, session.seed)
    temporary.restore_json(session.simulator.state_json())
    commands = {
        str(unit_id): legal_by_id[unit_id][actions[slot]] for slot, unit_id in enumerate(order)
    }
    temporary.step_json(
        json.dumps(
            {"side": "PLAYER", "order": order, "commands": commands, "formation": {}},
            separators=(",", ":"),
        )
    )
    after_state = json.loads(temporary.state_json())
    summoned_id = next(
        int(unit_id) for unit_id in after_state["units"] if int(unit_id) not in before_ids
    )

    assert summoned_id in preview["affected_unit_ids"]
    assert after_state["units"][str(summoned_id)]["position"] in preview["affected_cells"]


def test_payload_keeps_cooldown_costume_visible_as_a_disabled_option() -> None:
    session = GuiSession(DATABASE, SCENARIOS, 67, FAST_MCTS)
    payload = session.payload()
    order = payload["state"]["teams"][0]["action_order"]
    legal_by_id = {entry["unit_id"]: entry["commands"] for entry in payload["legal"]}
    actor = order[0]
    skill_index = next(
        index
        for index, command in enumerate(legal_by_id[actor])
        if command.get("costume_id") == "Loen_1"
    )
    actions = [
        skill_index
        if unit_id == actor
        else next(
            index for index, command in enumerate(legal_by_id[unit_id]) if command["type"] == "WAIT"
        )
        for unit_id in order
    ]

    advanced = session.step(actions, order, {})
    actor_entry = next(entry for entry in advanced["legal"] if entry["unit_id"] == actor)
    disabled = next(
        command
        for command in actor_entry["unavailable_commands"]
        if command["costume_id"] == "Loen_1"
    )

    assert all(command.get("costume_id") != "Loen_1" for command in actor_entry["commands"])
    assert disabled["unavailable_reason"] == "COOLDOWN"
    assert disabled["cooldown_remaining"] == 2
    assert len(disabled["ui"]["range"]) == 9


def test_next_ally_preview_tracks_dragged_action_order_and_real_target_lock() -> None:
    session = GuiSession(DATABASE, SCENARIOS, 53, FAST_MCTS)
    request = session.catalog.public_payload()["presets"]["NORMAL"]
    request["player_units"][0]["character_id"] = "Helena"
    request["player_units"][0]["costumes"] = maximum_loadout(session.catalog, "Helena")
    payload = session.start(request)
    order = payload["state"]["teams"][0]["action_order"]
    actor = order[0]
    legal_by_id = {entry["unit_id"]: entry["commands"] for entry in payload["legal"]}
    skill_index = next(
        index
        for index, command in enumerate(legal_by_id[actor])
        if command.get("costume_id") == "Helena_3"
    )

    before = session.preview(actor, skill_index, order, {})
    reordered = [order[1], actor, order[2]]
    after = session.preview(actor, skill_index, reordered, {})

    assert before["target_side"] == "PLAYER"
    assert before["target_id"] == order[1]
    assert before["affected_unit_ids"] == [order[1]]
    assert after["target_id"] == order[2]
    assert after["affected_unit_ids"] == [order[2]]

    action_indices = []
    for unit_id in reordered:
        commands = legal_by_id[unit_id]
        action_indices.append(
            skill_index
            if unit_id == actor
            else next(index for index, command in enumerate(commands) if command["type"] == "WAIT")
        )
    advanced = session.step(action_indices, reordered, {})
    locked_targets = [
        int(event["kind"]["target_id"])
        for event in advanced["state"]["event_log"]
        if event["kind"]["type"] == "TARGET_LOCKED"
        and int(event["kind"].get("actor_id", -1)) == actor
    ]
    assert locked_targets[0] == order[2]


def test_gui_rejects_fractional_turn_payload_without_mutating_battle() -> None:
    session = GuiSession(DATABASE, SCENARIOS, 73, FAST_MCTS)
    payload = session.payload()
    order = payload["state"]["teams"][0]["action_order"]
    waits = [
        next(index for index, command in enumerate(entry["commands"]) if command["type"] == "WAIT")
        for entry in payload["legal"]
    ]
    before = session.simulator.state_json()

    with pytest.raises(ValueError, match=r"actions\[0\] must be an integer"):
        session.step([0.5, *waits[1:]], order, {})
    assert session.simulator.state_json() == before

    with pytest.raises(ValueError, match=r"turn order\[0\] must be an integer"):
        session.step(waits, [float(order[0]), *order[1:]], {})
    assert session.simulator.state_json() == before

    with pytest.raises(ValueError, match="formation row must be an integer"):
        session.step(waits, order, {str(order[0]): {"row": 0.5, "depth": 0}})
    assert session.simulator.state_json() == before

    with pytest.raises(ValueError, match="one selection for every active unit"):
        session.step(waits[:-1], order, {})
    assert session.simulator.state_json() == before

    with pytest.raises(ValueError, match="preview action_index must be an integer"):
        session.preview(order[0], 0.5, order, {})
    assert session.simulator.state_json() == before


def test_gui_http_catalog_start_and_turn_round_trip() -> None:
    session = GuiSession(DATABASE, SCENARIOS, 29, FAST_MCTS)
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler_factory(session, UI))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{server.server_port}"

    def get(path: str) -> dict[str, object]:
        with urllib.request.urlopen(base + path, timeout=10) as response:
            return json.load(response)

    def post(path: str, payload: dict[str, object]) -> dict[str, object]:
        request = urllib.request.Request(
            base + path,
            data=json.dumps(payload).encode(),
            headers={"content-type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=10) as response:
            return json.load(response)

    try:
        catalog = get("/api/catalog")
        assert len(catalog["characters"]) == 61
        malformed = urllib.request.Request(
            base + "/api/reset",
            data=b"[]",
            headers={"content-type": "application/json"},
            method="POST",
        )
        with pytest.raises(urllib.error.HTTPError) as rejected:
            urllib.request.urlopen(malformed, timeout=10)
        assert rejected.value.code == 400
        assert json.load(rejected.value)["error"] == "request body must be a JSON object"

        mirror = catalog["presets"]["MIRROR_WAR"]
        mirror["mcts_simulations"] = 4
        started = post("/api/start", mirror)
        assert started["state"]["rules"]["mode"] == "MIRROR_WAR"
        current_order = started["state"]["teams"][0]["action_order"]
        advanced = post("/api/step", {"actions": [2, 2], "order": list(reversed(current_order))})
        assert advanced["last_ai"]["controller"] == "MCTS"
        assert advanced["state"]["active_side"] == "PLAYER"
        assert advanced["can_rollback"] is True
        restored = post("/api/rollback", {})
        assert restored["state"] == started["state"]
        assert restored["can_rollback"] is False

        normal = catalog["presets"]["NORMAL"]
        normal["mcts_simulations"] = 4
        started = post("/api/start", normal)
        current_order = started["state"]["teams"][0]["action_order"]
        preview = post(
            "/api/preview",
            {"unit_id": current_order[0], "action_index": 0, "order": current_order},
        )
        assert preview["target_side"] == "ENEMY"
        assert preview["anchor"] is not None
        moving = current_order[0]
        target = {"row": 2, "depth": 3}
        advanced = post(
            "/api/step",
            {
                "actions": [2] * len(current_order),
                "order": current_order,
                "formation": {str(moving): target},
            },
        )
        assert advanced["state"]["units"][str(moving)]["position"] == target
        restored = post("/api/rollback", {})
        assert restored["state"] == started["state"]

        with urllib.request.urlopen(base + "/battle-ui-model.mjs", timeout=10) as response:
            assert response.headers.get_content_type() == "text/javascript"
        with urllib.request.urlopen(
            base + "/assets/character-icons/64/Lathel.png", timeout=10
        ) as response:
            assert response.headers.get_content_type() == "image/png"
            assert response.read(8) == b"\x89PNG\r\n\x1a\n"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
