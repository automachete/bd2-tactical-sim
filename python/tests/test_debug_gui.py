from __future__ import annotations

import copy
import json
import shutil
import threading
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from itertools import permutations
from pathlib import Path

import pytest
from bd2rl._native import Simulator, knockback_offsets_json
from bd2rl.debug_setup import DebugSetupCatalog
from bd2rl.gui import GuiSession, _production_ui_root, handler_factory
from bd2rl.mcts import MctsConfig, MctsPlanner
from hypothesis import given, settings
from hypothesis.strategies import integers, sampled_from

ROOT = Path(__file__).resolve().parents[2]
DATABASE = ROOT / "data/generated/bd2.sqlite"
SCENARIOS = ROOT / "data/scenarios"
UI = ROOT / "ui" / "dist"
FAST_MCTS = MctsConfig(simulations=6, rollout_depth=3, max_branching=8)


def normal_attack_plan(simulator: Simulator, side: str) -> dict[str, object]:
    state = json.loads(simulator.state_json())
    index = 0 if side == "PLAYER" else 1
    order = state["teams"][index]["action_order"]
    return {
        "side": side,
        "order": order,
        "commands": {str(unit_id): {"type": "NORMAL_ATTACK"} for unit_id in order},
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


def action_events(events: list[dict[str, object]], actor_id: int) -> list[dict[str, object]]:
    result: list[dict[str, object]] = []
    active = False
    for event in events:
        kind = event["kind"]
        if kind["type"] == "ACTION_STARTED" and int(kind["actor_id"]) == actor_id:
            active = True
        if active:
            result.append(event)
        if kind["type"] == "ACTION_ENDED" and int(kind["actor_id"]) == actor_id:
            return result
    return result


def assert_preview_matches_events(
    preview: dict[str, object], events: list[dict[str, object]], actor_id: int
) -> None:
    actual = action_events(events, actor_id)
    assert preview["actor_events"] == actual
    starts = [
        event["kind"]["command"] for event in actual if event["kind"]["type"] == "ACTION_STARTED"
    ]
    resolved = preview["resolved_command"]
    assert (
        {key: value for key, value in resolved.items() if key != "ui"}
        if resolved is not None
        else None
    ) == (starts[-1] if starts else None)

    locks = [
        event["kind"]
        for event in actual
        if event["kind"]["type"] in {"TARGET_LOCKED", "TARGET_CELL_LOCKED"}
    ]
    expected_target = (
        int(locks[-1]["target_id"]) if locks and locks[-1]["type"] == "TARGET_LOCKED" else None
    )
    assert preview["target_id"] == expected_target

    areas = [event["kind"] for event in actual if event["kind"]["type"] == "TARGET_AREA_RESOLVED"]
    if areas:
        area = areas[-1]
        assert preview["target_side"] == area["target_side"]
        assert preview["anchor"] == area["anchor"]
        assert preview["affected_cells"] == area["cells"]
        assert preview["affected_unit_ids"] == area["target_ids"]
    else:
        assert preview["target_side"] is None
        assert preview["anchor"] is None
        assert preview["affected_cells"] == []
        assert preview["affected_unit_ids"] == []

    expected_movements = [
        {
            "unit_id": event["kind"]["unit_id"],
            "from": event["kind"]["from"],
            "to": event["kind"]["to"],
        }
        for event in actual
        if event["kind"]["type"] == "UNIT_MOVED"
    ]
    assert preview["movements"] == expected_movements

    damage: dict[int, dict[str, int]] = {}

    def forecast(target_id: int) -> dict[str, int]:
        return damage.setdefault(
            target_id,
            {
                "target_id": target_id,
                "amount": 0,
                "hits": 0,
                "critical_hits": 0,
                "evaded_hits": 0,
                "absorbed": 0,
                "collision_damage": 0,
            },
        )

    for event in actual:
        kind = event["kind"]
        if kind["type"] == "DAMAGE_APPLIED" and int(kind["actor_id"]) == actor_id:
            item = forecast(int(kind["target_id"]))
            item["amount"] += int(kind["amount"])
            item["hits"] += 1
            item["critical_hits"] += int(bool(kind["critical"]))
        elif kind["type"] == "DAMAGE_EVADED" and int(kind["actor_id"]) == actor_id:
            forecast(int(kind["target_id"]))["evaded_hits"] += 1
        elif kind["type"] == "BARRIER_ABSORBED":
            forecast(int(kind["target_id"]))["absorbed"] += int(kind["amount"])
        elif kind["type"] == "COLLISION_DAMAGE":
            forecast(int(kind["occupant_id"]))["collision_damage"] += int(kind["amount"])
    assert preview["damage_by_target"] == [damage[target_id] for target_id in sorted(damage)]
    assert preview["total_damage"] == sum(item["amount"] for item in damage.values())


def assert_costume_card_range_matches_resolved_area(
    preview: dict[str, object], state: dict[str, object]
) -> None:
    command = preview["command"]
    resolved = preview["resolved_command"]
    if (
        command["type"] != "USE_COSTUME"
        or resolved is None
        or {key: value for key, value in resolved.items() if key != "ui"}
        != {key: value for key, value in command.items() if key != "ui"}
    ):
        return
    metadata = command["ui"]
    anchor = preview["anchor"]
    assert anchor is not None
    grid = state["rules"]["grid"]
    blocked = {tuple(cell) for cell in grid["blocked"]}
    if metadata["target_all"]:
        coordinates = {
            (row, depth)
            for row in range(int(grid["rows"]))
            for depth in range(int(grid["depths"]))
            if (row, depth) not in blocked
        }
    else:
        offsets = metadata["range"] or [{"row": 0, "depth": 0}]
        coordinates = {
            (int(anchor["row"]) + int(offset["row"]), int(anchor["depth"]) + int(offset["depth"]))
            for offset in offsets
        }
        coordinates = {
            (row, depth)
            for row, depth in coordinates
            if 0 <= row < int(grid["rows"])
            and 0 <= depth < int(grid["depths"])
            and (row, depth) not in blocked
        }
    assert preview["affected_cells"] == [
        {"row": row, "depth": depth} for row, depth in sorted(coordinates)
    ]


def test_debug_catalog_builds_all_four_modes_from_external_data() -> None:
    catalog = DebugSetupCatalog(DATABASE, SCENARIOS)
    public = catalog.public_payload()
    assert public["ruleset_id"].startswith("bd2-current-")
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
    assert costume["description_ja"]
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
    assert entities["Lathel"]["knockback_direction"] == "DOWN_BACK"
    assert entities["Liberta"]["knockback_direction"] == "FRONT"
    assert entities["Blade"]["knockback_direction"] == "UP_BACK"
    assert entities["Darian"]["knockback_direction"] == "DOWN_FRONT"
    assert {item["knockback_direction"] for item in public["characters"]} <= {
        "BACK",
        "FRONT",
        "UP",
        "DOWN",
        "UP_BACK",
        "DOWN_BACK",
        "UP_FRONT",
        "DOWN_FRONT",
    }
    system_costumes = {item["id"]: item for item in public["system_costumes"]}
    assert entities["fiend:10072"]["name"] == "仇怨のキメラ（風）"  # noqa: RUF001
    assert entities["summon:PersonaOfWorship"]["name"] == "Persona of Worship"
    assert system_costumes["summon:PersonaOfWorship:skill"]["name"] == "精神崩潰"
    assert set(public["presets"]) == {
        "NORMAL",
        "MIRROR_WAR",
        "MONSTER_CHASER",
        "GOLDEN_COLOSSEUM",
    }
    assert len(public["blessings"]) == 47

    for mode, preset in public["presets"].items():
        setup = catalog.build_setup(preset)
        assert setup["rules"]["sp_cap"] == 20, mode
        simulator = Simulator(str(DATABASE), json.dumps(setup), 13)
        state = json.loads(simulator.state_json())
        assert state["rules"]["mode"] == mode
        if mode == "GOLDEN_COLOSSEUM":
            assert state["rules"]["allow_manual_commands"] == [False, False]
            assert state["golden_colosseum"]["initiative"] in {"PLAYER", "ENEMY"}
            assert state["active_side"] == state["golden_colosseum"]["initiative"]
            assert all(len(unit["costume_loadout"]) == 1 for unit in state["units"].values())
            assert all(not unit["equipment"] for unit in setup["units"])
        else:
            assert state["rules"]["allow_manual_commands"] == [True, False]
            assert state["active_side"] == "PLAYER"

    monster = catalog.build_setup(public["presets"]["MONSTER_CHASER"])
    parties = {unit["party_no"] for unit in monster["units"] if unit["side"] == "PLAYER"}
    assert parties == {1, 2}
    assert len([unit for unit in monster["units"] if unit["side"] == "ENEMY"]) == 8


def test_native_knockback_offsets_cover_every_direction_in_local_grid_coordinates() -> None:
    assert {item["direction"]: item["offset"] for item in json.loads(knockback_offsets_json())} == {
        "BACK": {"row": 0, "depth": 1},
        "FRONT": {"row": 0, "depth": -1},
        "UP": {"row": -1, "depth": 0},
        "DOWN": {"row": 1, "depth": 0},
        "UP_BACK": {"row": -1, "depth": 1},
        "DOWN_BACK": {"row": 1, "depth": 1},
        "UP_FRONT": {"row": -1, "depth": -1},
        "DOWN_FRONT": {"row": 1, "depth": -1},
    }


def test_knockback_metadata_preview_and_execution_match_for_every_catalog_direction() -> None:
    session = GuiSession(DATABASE, SCENARIOS, 89, FAST_MCTS)
    public = session.catalog.public_payload()
    representatives: dict[str, dict[str, object]] = {}
    for character in public["characters"]:
        representatives.setdefault(character["knockback_direction"], character)
    assert set(representatives) == set(session.catalog.knockback_offsets) - {"UP_FRONT"}

    for direction, character in representatives.items():
        request = copy.deepcopy(public["presets"]["NORMAL"])
        request["player_units"] = [
            {
                **request["player_units"][0],
                "character_id": character["id"],
                "costumes": maximum_loadout(session.catalog, str(character["id"])),
                "row": 1,
                "depth": 1,
            }
        ]
        request["enemy_units"] = [{**request["enemy_units"][0], "row": 1, "depth": 1}]
        payload = session.start(request)
        actor = int(payload["state"]["teams"][0]["action_order"][0])
        legal_entry = next(entry for entry in payload["legal"] if entry["unit_id"] == actor)
        knockback_index, knockback_command = next(
            (index, command)
            for index, command in enumerate(legal_entry["commands"])
            if command["type"] == "KNOCKBACK"
        )
        offset = session.catalog.knockback_offsets[direction]
        assert knockback_command["ui"] == {
            "knockback_direction": direction,
            "knockback_offset": offset,
            "knockback_distance": 1,
        }

        preview = session.preview(actor, knockback_index, [actor], {})
        assert len(preview["movements"]) == 1, direction
        movement = preview["movements"][0]
        assert {
            "row": movement["to"]["row"] - movement["from"]["row"],
            "depth": movement["to"]["depth"] - movement["from"]["depth"],
        } == offset, direction

        live_json = session.simulator.state_json()
        before_count = len(json.loads(live_json)["event_log"])
        direct = session.simulator.new_battle(session.setup_json, session.seed)
        direct.restore_json(live_json)
        raw_commands = json.loads(direct.legal_actions_json("PLAYER"))[0]["commands"]
        direct.step_json(
            json.dumps(
                {
                    "side": "PLAYER",
                    "order": [actor],
                    "commands": {str(actor): raw_commands[knockback_index]},
                    "formation": {},
                }
            )
        )
        events = json.loads(direct.state_json())["event_log"][before_count:]
        actual_actor_events = action_events(events, actor)
        area = next(
            event["kind"]
            for event in actual_actor_events
            if event["kind"]["type"] == "TARGET_AREA_RESOLVED"
        )
        assert preview["actor_events"] == actual_actor_events, direction
        assert preview["anchor"] == area["anchor"], direction
        assert preview["target_side"] == area["target_side"], direction
        assert preview["affected_cells"] == area["cells"], direction
        assert preview["affected_unit_ids"] == area["target_ids"], direction


def test_player_legal_actions_have_no_wait_and_japanese_skill_text_is_materialized() -> None:
    catalog = DebugSetupCatalog(DATABASE, SCENARIOS)
    public = catalog.public_payload()
    session = GuiSession(DATABASE, SCENARIOS, 37, FAST_MCTS)

    assert all(
        costume["description_ja"] and "{" not in costume["description_ja"]
        for character in public["characters"]
        for costume in character["costumes"]
    )
    loen = next(
        costume for costume in catalog.characters["Loen"]["costumes"] if costume["id"] == "Loen_1"
    )
    assert loen["name"] == "最後の希望"
    assert loen["description_ja"] == "敵に自身の魔法力1000%分の魔法ダメージを与えます。"

    legal = session.payload()["legal"]
    assert legal
    assert {command["type"] for entry in legal for command in entry["commands"]} <= {
        "NORMAL_ATTACK",
        "KNOCKBACK",
        "USE_COSTUME",
    }
    state = session.payload()["state"]
    order = state["teams"][0]["action_order"]
    invalid = {
        "side": "PLAYER",
        "order": order,
        "commands": {str(unit_id): {"type": "WAIT"} for unit_id in order},
        "formation": {},
    }
    with pytest.raises(ValueError, match="unknown variant `WAIT`"):
        session.simulator.step_json(json.dumps(invalid))


def test_content_presets_never_contain_runtime_summon_entities() -> None:
    public = DebugSetupCatalog(DATABASE, SCENARIOS).public_payload()
    assert any("MagicAmplifierET001" in item["id"] for item in public["entities"])
    for preset in public["presets"].values():
        unit_ids = [
            unit["character_id"]
            for side in ("player_units", "enemy_units")
            for unit in preset[side]
        ]
        assert all(not character_id.startswith(("summon:", "fiend:")) for character_id in unit_ids)
        assert all("ET001" not in character_id for character_id in unit_ids)


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


def test_every_burst_variant_has_a_nonincreasing_zero_burst_sp_baseline() -> None:
    catalog = DebugSetupCatalog(DATABASE, SCENARIOS)
    checked = 0
    for costume_id, record in catalog.costume_records.items():
        variants = record.get("variants", [])
        for variant in variants:
            if int(variant.get("burst_level", 0)) <= 0:
                continue
            baseline = next(
                (
                    item
                    for item in variants
                    if int(item["enhancement"]) == int(variant["enhancement"])
                    and int(item["potential_mask"]) == int(variant["potential_mask"])
                    and int(item["burst_level"]) == 0
                ),
                None,
            )
            assert baseline is not None, costume_id
            assert int(variant["sp_cost"]) >= int(baseline["sp_cost"]), costume_id
            checked += 1
    assert checked > 0


def test_gui_payload_describes_the_exact_configured_costume_variant() -> None:
    session = GuiSession(DATABASE, SCENARIOS, 11, FAST_MCTS)
    request = session.catalog.public_payload()["presets"]["NORMAL"]
    loen = next(unit for unit in request["player_units"] if unit["character_id"] == "Loen")
    loadout = next(item for item in loen["costumes"] if item["costume_id"] == "Loen_1")
    loadout.update(enhancement=0, burst_level=0, potential_mask=0)
    profile = session.character_profiles.get("Loen")
    profile_loadout = next(item for item in profile["costumes"] if item["costume_id"] == "Loen_1")
    profile_loadout.update(enhancement=0, burst_level=0, potential_mask=0)
    session.save_character_profile(profile)

    payload = session.start(request)
    loen_id = next(
        int(unit_id)
        for unit_id, unit in payload["state"]["units"].items()
        if unit["character_id"] == "Loen" and unit["side"] == "PLAYER"
    )
    legal = next(item for item in payload["legal"] if item["unit_id"] == loen_id)
    command = next(item for item in legal["commands"] if item.get("costume_id") == "Loen_1")

    assert command["ui"]["sp_cost"] == command["ui"]["base_sp_cost"]
    assert command["ui"]["burst_sp_cost"] == 0
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

    michaela_id = next(
        int(unit_id)
        for unit_id, unit in payload["state"]["units"].items()
        if unit["character_id"] == "Michaela" and unit["side"] == "PLAYER"
    )
    michaela_legal = next(item for item in payload["legal"] if item["unit_id"] == michaela_id)
    michaela_variants = [
        item for item in michaela_legal["commands"] if item.get("costume_id") == "Michaela_1"
    ]
    assert [item["burst_level"] for item in michaela_variants] == [0, 1, 2, 3]
    assert [item["ui"]["sp_cost"] for item in michaela_variants] == [3, 4, 5, 6]
    assert [item["ui"]["base_sp_cost"] for item in michaela_variants] == [3, 3, 3, 3]
    assert [item["ui"]["burst_sp_cost"] for item in michaela_variants] == [0, 1, 2, 3]


def test_gui_metadata_fails_closed_and_preserves_an_explicit_empty_range() -> None:
    session = GuiSession(DATABASE, SCENARIOS, 11, FAST_MCTS)
    payload = session.start(session.catalog.public_payload()["presets"]["NORMAL"])
    unit_id = payload["state"]["teams"][0]["action_order"][0]
    unit = payload["state"]["units"][str(unit_id)]
    command = next(
        item for item in payload["legal"][0]["commands"] if item["type"] == "USE_COSTUME"
    )

    with pytest.raises(ValueError, match="missing exact costume variant"):
        session.catalog.command_metadata(unit, {**command, "burst_level": 99})
    with pytest.raises(ValueError, match="missing costume"):
        session.catalog.command_metadata(unit, {**command, "costume_id": "missing"})
    with pytest.raises(ValueError, match="unsupported battle command"):
        session.catalog.command_metadata(unit, {"type": "WAIT"})
    with pytest.raises(ValueError, match="unsupported operation"):
        session.catalog._operation_summary(
            {"operations": [{"op": "UNKNOWN"}], "consume_remaining_sp": False}
        )
    with pytest.raises(ValueError, match="unsupported condition"):
        session.catalog._condition_summary({"type": "UNKNOWN"})

    record = session.catalog.costume_records[command["costume_id"]]
    loadout = next(
        item for item in unit["costume_loadout"] if item["costume_id"] == command["costume_id"]
    )
    variant = next(
        item
        for item in record["variants"]
        if item["enhancement"] == loadout["enhancement"]
        and item["burst_level"] == command["burst_level"]
        and item["potential_mask"] == loadout["potential_mask"]
    )
    original = variant["range_override"]
    try:
        variant["range_override"] = []
        assert session.catalog.command_metadata(unit, command)["range"] == []
    finally:
        variant["range_override"] = original


def test_gui_typed_equipment_changes_stats_but_not_skill_cost_metadata() -> None:
    session = GuiSession(DATABASE, SCENARIOS, 12, FAST_MCTS)
    request = session.catalog.public_payload()["presets"]["NORMAL"]
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
    configured_equipment = {
        "WEAPON": {
            "equipment_id": equipment["id"],
            "refinement_score": 18,
            "primary_stat": None,
            "secondary_stat": None,
            "substats": [equipment["allowed_substats"][0]["key"]] * 3,
        }
    }
    profile = session.character_profiles.get("Loen")
    profile["equipment"] = configured_equipment
    session.save_character_profile(profile)
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


def test_configured_burst_unlock_level_caps_runtime_action_stages() -> None:
    session = GuiSession(DATABASE, SCENARIOS, 19, FAST_MCTS)
    request = session.catalog.public_payload()["presets"]["NORMAL"]
    michaela = next(unit for unit in request["player_units"] if unit["character_id"] == "Michaela")
    loadout = next(item for item in michaela["costumes"] if item["costume_id"] == "Michaela_1")
    loadout["burst_level"] = 2
    profile = session.character_profiles.get("Michaela")
    next(item for item in profile["costumes"] if item["costume_id"] == "Michaela_1")[
        "burst_level"
    ] = 2
    session.save_character_profile(profile)

    payload = session.start(request)
    unit_id = next(
        int(raw_id)
        for raw_id, unit in payload["state"]["units"].items()
        if unit["side"] == "PLAYER" and unit["character_id"] == "Michaela"
    )
    legal = next(entry for entry in payload["legal"] if entry["unit_id"] == unit_id)
    assert [
        command["burst_level"]
        for command in legal["commands"]
        if command.get("costume_id") == "Michaela_1"
    ] == [0, 1, 2]


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
    template: Simulator | None = None
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
        simulator = (
            Simulator(str(DATABASE), json.dumps(setup), 101)
            if template is None
            else template.new_battle(json.dumps(setup), 101)
        )
        template = simulator
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
    with pytest.raises(ValueError, match="fixed as unlocked"):
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
    simulator.step_json(json.dumps(normal_attack_plan(simulator, "PLAYER")))
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
    normal = session.step([0, 0, 0])
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


def test_golden_colosseum_allows_same_character_costumes_and_only_auto_steps() -> None:
    session = GuiSession(DATABASE, SCENARIOS, 23, FAST_MCTS)
    request = session.catalog.public_payload()["presets"]["GOLDEN_COLOSSEUM"]
    loen = session.catalog.characters["Loen"]
    request["player_units"][1]["character_id"] = "Loen"
    request["player_units"][1]["costumes"] = [
        {
            "costume_id": costume["id"],
            "enhancement": costume["max_enhancement"],
            "burst_level": costume["max_burst_level"],
            "potential_mask": costume["max_potential_mask"],
            "permanent_potential_enabled": True,
            "enabled": costume["id"] == "Loen_2",
        }
        for costume in loen["costumes"]
    ]
    started = session.start(request)
    assert started["enemy_controller"] == "COLOSSEUM_AUTO"
    player_costumes = [
        unit["costume_loadout"][0]["costume_id"]
        for unit in started["state"]["units"].values()
        if unit["side"] == "PLAYER"
    ]
    assert player_costumes[:2] == ["Loen_1", "Loen_2"]
    with pytest.raises(RuntimeError, match="resolved automatically"):
        session.step([], [], {})

    before_sequence = started["state"]["action_sequence"]
    active_side = started["state"]["active_side"]
    advanced = session.ai_step()
    assert advanced["state"]["action_sequence"] == before_sequence + 1
    assert advanced["last_ai"] == {"controller": "COLOSSEUM_AUTO", "side": active_side}
    assert advanced["can_rollback"] is True


def test_gui_payload_preserves_the_exact_editor_setup_and_mcts_configuration() -> None:
    session = GuiSession(DATABASE, SCENARIOS, 71, FAST_MCTS)
    request = session.catalog.public_payload()["presets"]["NORMAL"]
    unit = request["player_units"][0]
    unit["costumes"] = [
        {
            **unit["costumes"][0],
            "enhancement": 0,
            "potential_mask": 0,
            "permanent_potential_enabled": True,
        }
    ]
    unit["build_settings"]["external_buffs"]["crit_damage_bp"] = 1234
    profile = session.character_profiles.get(unit["character_id"])
    profile_costume = next(
        item
        for item in profile["costumes"]
        if item["costume_id"] == unit["costumes"][0]["costume_id"]
    )
    profile_costume.update(enhancement=0, potential_mask=0)
    session.save_character_profile(profile)
    request["seed"] = 73
    request["mcts_simulations"] = 7

    payload = session.start(request)

    restored = payload["setup"]["player_units"][0]
    assert payload["seed"] == 73
    assert payload["mcts"]["simulations"] == 7
    assert len(restored["costumes"]) == 1
    assert restored["costumes"][0]["enhancement"] == 0
    assert restored["costumes"][0]["potential_mask"] == 0
    assert restored["costumes"][0]["permanent_potential_enabled"] is True
    assert restored["build_settings"]["external_buffs"]["crit_damage_bp"] == 1234
    assert payload["state"]["units"]["1"]["base_stats"]["crit_damage_bp"] >= 1234


def test_gui_saves_and_reloads_strict_training_scenario(tmp_path: Path) -> None:
    saved_directory = tmp_path / "saved"
    session = GuiSession(
        DATABASE,
        SCENARIOS,
        71,
        FAST_MCTS,
        saved_setup_directory=saved_directory,
    )
    request = session.catalog.public_payload()["presets"]["NORMAL"]
    unit = request["player_units"][0]
    costume = unit["costumes"][0]
    costume.update(enhancement=2, burst_level=0, potential_mask=0b101)
    unit["build_settings"]["awakening_enabled"] = False
    equipment = next(
        item
        for item in session.catalog.equipment.values()
        if item["kind"] == "CRAFTED_LEGENDARY" and item["allowed_substats"]
    )
    unit["equipment"] = {
        equipment["slot"]: {
            "equipment_id": equipment["id"],
            "refinement_score": 21,
            "primary_stat": None,
            "secondary_stat": None,
            "substats": [equipment["allowed_substats"][0]["key"]] * 3,
        }
    }
    profile = session.character_profiles.get(unit["character_id"])
    profile_costume = next(
        item for item in profile["costumes"] if item["costume_id"] == costume["costume_id"]
    )
    profile_costume.update(enhancement=2, burst_level=0, potential_mask=0b101)
    profile["awakening_enabled"] = False
    profile["equipment"] = copy.deepcopy(unit["equipment"])
    session.save_character_profile(profile)

    response = session.save_setup("涙ノード検証", request)

    assert response["saved"] == {
        "name": "涙ノード検証",
        "scenario": "涙ノード検証.json",
    }
    scenario_path = saved_directory / "涙ノード検証.json"
    canonical = json.loads(scenario_path.read_text(encoding="utf-8"))
    saved_unit = canonical["units"][0]
    assert saved_unit["costume_loadout"][0]["enhancement"] == 2
    assert saved_unit["costume_loadout"][0]["burst_level"] == 0
    assert saved_unit["costume_loadout"][0]["potential_mask"] == 0b101
    assert saved_unit["costume_loadout"][0]["permanent_potential_enabled"] is True
    assert saved_unit["build_settings"]["awakening_enabled"] is False
    assert saved_unit["equipment"] == unit["equipment"]
    Simulator(str(DATABASE), scenario_path.read_text(encoding="utf-8"), 99)

    loaded = session.load_setup("涙ノード検証")
    restored = loaded["setup"]["player_units"][0]
    assert loaded["loaded_setup"] == "涙ノード検証"
    assert restored["costumes"][0]["potential_mask"] == 0b101
    assert restored["build_settings"]["awakening_enabled"] is False
    assert restored["equipment"] == unit["equipment"]
    assert all(item["permanent_potential_enabled"] is True for item in restored["costumes"])

    with pytest.raises(ValueError, match="forbidden path character"):
        session.save_setup("../outside", request)


def test_character_profiles_are_complete_strict_and_formation_independent(tmp_path: Path) -> None:
    profile_path = tmp_path / "profiles" / "characters.json"
    session = GuiSession(
        DATABASE,
        SCENARIOS,
        73,
        FAST_MCTS,
        saved_setup_directory=tmp_path / "setups",
        character_profile_path=profile_path,
    )
    document = session.character_profiles.payload()
    assert document["schema_version"] == 1
    assert len(document["profiles"]) == 61
    assert {item["character_id"] for item in document["profiles"]} == set(
        session.catalog.characters
    )

    normal = session.catalog.public_payload()["presets"]["NORMAL"]
    character_id = "Michaela"
    character = session.catalog.characters[character_id]
    profile = session.character_profiles.get(character_id)
    burst_costume = next(item for item in character["costumes"] if item["max_burst_level"] == 3)
    configured_costume = next(
        item for item in profile["costumes"] if item["costume_id"] == burst_costume["id"]
    )
    configured_costume.update(enhancement=2, burst_level=1, potential_mask=0b101)
    profile["awakening_enabled"] = False
    equipment = next(
        item
        for item in session.catalog.equipment.values()
        if item["kind"] == "CRAFTED_LEGENDARY" and item["slot"] == "WEAPON"
    )
    profile["equipment"] = {
        "WEAPON": {
            "equipment_id": equipment["id"],
            "refinement_score": 22,
            "primary_stat": None,
            "secondary_stat": None,
            "substats": [equipment["allowed_substats"][0]["key"]] * 3,
        }
    }
    saved = session.save_character_profile(profile)
    assert saved["profile"]["is_default"] is False
    assert profile_path.is_file()
    persisted = json.loads(profile_path.read_text(encoding="utf-8"))
    assert set(persisted) == {"schema_version", "profiles"}
    assert len(persisted["profiles"]) == 61

    reloaded = GuiSession(
        DATABASE,
        SCENARIOS,
        73,
        FAST_MCTS,
        saved_setup_directory=tmp_path / "setups-reloaded",
        character_profile_path=profile_path,
    )
    assert reloaded.character_profiles.get(character_id) == profile

    request = copy.deepcopy(normal)
    player = next(unit for unit in request["player_units"] if unit["character_id"] == character_id)
    player["costumes"] = maximum_loadout(reloaded.catalog, character_id)
    player["equipment"] = {}
    player["build_settings"]["awakening_enabled"] = True
    request["enemy_units"] = [request["enemy_units"][0]]
    enemy = request["enemy_units"][0]
    enemy["character_id"] = character_id
    enemy["costumes"] = maximum_loadout(reloaded.catalog, character_id)
    enemy["equipment"] = {}
    enemy["build_settings"]["awakening_enabled"] = True
    payload = reloaded.start(request)
    restored_player = next(
        unit for unit in payload["setup"]["player_units"] if unit["character_id"] == character_id
    )
    restored_enemy = payload["setup"]["enemy_units"][0]
    restored_costume = next(
        item for item in restored_player["costumes"] if item["costume_id"] == burst_costume["id"]
    )
    assert restored_costume["enhancement"] == 2
    assert restored_costume["burst_level"] == 1
    assert restored_costume["potential_mask"] == 0b101
    assert restored_player["build_settings"]["awakening_enabled"] is False
    assert restored_player["equipment"] == profile["equipment"]
    assert restored_enemy["build_settings"]["awakening_enabled"] is True
    assert restored_enemy["equipment"] == {}

    invalid = copy.deepcopy(profile)
    invalid["legacy_fallback"] = True
    with pytest.raises(ValueError, match="must contain only"):
        reloaded.save_character_profile(invalid)

    legacy = copy.deepcopy(persisted)
    legacy["schema_version"] = 0
    profile_path.write_text(json.dumps(legacy), encoding="utf-8")
    with pytest.raises(ValueError, match="unsupported character profile schema"):
        GuiSession(
            DATABASE,
            SCENARIOS,
            73,
            FAST_MCTS,
            saved_setup_directory=tmp_path / "legacy-setups",
            character_profile_path=profile_path,
        )

    partial = copy.deepcopy(persisted)
    partial["profiles"] = partial["profiles"][:-1]
    profile_path.write_text(json.dumps(partial), encoding="utf-8")
    with pytest.raises(ValueError, match="exactly match the current catalog"):
        GuiSession(
            DATABASE,
            SCENARIOS,
            73,
            FAST_MCTS,
            saved_setup_directory=tmp_path / "partial-setups",
            character_profile_path=profile_path,
        )


def test_every_five_star_character_fixed_profile_round_trips_without_slot_scope(
    tmp_path: Path,
) -> None:
    profile_path = tmp_path / "profiles" / "characters.json"
    session = GuiSession(
        DATABASE,
        SCENARIOS,
        77,
        FAST_MCTS,
        saved_setup_directory=tmp_path / "setups",
        character_profile_path=profile_path,
    )
    equipment = next(
        item
        for item in session.catalog.equipment.values()
        if item["kind"] == "CRAFTED_LEGENDARY" and item["slot"] == "WEAPON"
    )
    expected: dict[str, dict[str, object]] = {}
    for character_id, character in session.catalog.characters.items():
        profile = session.character_profiles.get(character_id)
        profile["awakening_enabled"] = False
        for loadout in profile["costumes"]:
            costume = next(
                item for item in character["costumes"] if item["id"] == loadout["costume_id"]
            )
            loadout.update(
                enhancement=min(2, costume["max_enhancement"]),
                burst_level=min(1, costume["max_burst_level"]),
                potential_mask=costume["max_potential_mask"] & 0b101,
            )
        profile["equipment"] = {
            "WEAPON": {
                "equipment_id": equipment["id"],
                "refinement_score": 24,
                "primary_stat": None,
                "secondary_stat": None,
                "substats": [equipment["allowed_substats"][0]["key"]] * 3,
            }
        }
        session.save_character_profile(profile)
        expected[character_id] = profile

    reloaded = GuiSession(
        DATABASE,
        SCENARIOS,
        77,
        FAST_MCTS,
        saved_setup_directory=tmp_path / "setups-reloaded",
        character_profile_path=profile_path,
    )
    assert {
        character_id: reloaded.character_profiles.get(character_id)
        for character_id in reloaded.catalog.characters
    } == expected


def test_gui_turn_is_atomic_when_automatic_opponent_fails(monkeypatch: pytest.MonkeyPatch) -> None:
    session = GuiSession(DATABASE, SCENARIOS, 79, FAST_MCTS)
    before = session.payload()
    order = before["state"]["teams"][0]["action_order"]
    normal_attacks = [0 for _ in before["legal"]]

    def fail_enemy() -> None:
        raise RuntimeError("forced opponent failure")

    monkeypatch.setattr(session, "_advance_enemy", fail_enemy)
    with pytest.raises(RuntimeError, match="forced opponent failure"):
        session.step(normal_attacks, order, {})

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


def test_every_five_star_legal_action_preview_matches_engine_execution() -> None:
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
        direct = session.simulator.new_battle(session.setup_json, session.seed)

        for action_index, command in enumerate(legal_by_id[actor]):
            preview = session.preview(actor, action_index, order, {})
            commands: dict[str, object] = {}
            for unit_id in order:
                choices = legal_by_id[unit_id]
                commands[str(unit_id)] = (
                    command
                    if unit_id == actor
                    else next(
                        candidate for candidate in choices if candidate["type"] == "NORMAL_ATTACK"
                    )
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
            assert_preview_matches_events(preview, events, actor)
            assert_costume_card_range_matches_resolved_area(preview, live_state)
            assert preview["resolved_action_order"] == [
                int(event["kind"]["actor_id"])
                for event in events
                if event["kind"]["type"] == "ACTION_ENDED"
            ], (character["id"], command)
            coordinates = {(cell["row"], cell["depth"]) for cell in preview["affected_cells"]}
            assert len(coordinates) == len(preview["affected_cells"])
            assert all(0 <= row < 3 and 0 <= depth < 4 for row, depth in coordinates)
            for unit_id in preview["affected_unit_ids"]:
                unit = live_state["units"][str(unit_id)]
                assert unit["alive"] is True
                assert (unit["position"]["row"], unit["position"]["depth"]) in coordinates
            checked += 1

    assert checked >= 250


@settings(max_examples=30, deadline=None, derandomize=True)
@given(
    seed=integers(min_value=1, max_value=2**31 - 1),
    order_indices=sampled_from(tuple(permutations(range(3)))),
    formation_cells=sampled_from(
        (
            ((0, 0), (1, 1), (2, 2)),
            ((2, 3), (1, 2), (0, 1)),
            ((0, 3), (2, 0), (1, 1)),
        )
    ),
    actor_slot=integers(min_value=0, max_value=2),
    action_ordinal=integers(min_value=0, max_value=127),
)
def test_preview_matches_execution_across_seed_order_formation_and_action(
    seed: int,
    order_indices: tuple[int, ...],
    formation_cells: tuple[tuple[int, int], ...],
    actor_slot: int,
    action_ordinal: int,
) -> None:
    session = GuiSession(DATABASE, SCENARIOS, seed, FAST_MCTS)
    payload = session.payload()
    base_order = [int(value) for value in payload["state"]["teams"][0]["action_order"]]
    order = [base_order[index] for index in order_indices]
    formation = {
        str(unit_id): {"row": row, "depth": depth}
        for unit_id, (row, depth) in zip(base_order, formation_cells, strict=True)
    }
    raw_legal = json.loads(session.simulator.legal_actions_json("PLAYER"))
    legal_by_id = {int(entry["unit_id"]): entry["commands"] for entry in raw_legal}
    actor = order[actor_slot]
    selected = action_ordinal % len(legal_by_id[actor])
    actions = [
        selected
        if unit_id == actor
        else next(
            index
            for index, command in enumerate(legal_by_id[unit_id])
            if command["type"] == "NORMAL_ATTACK"
        )
        for unit_id in order
    ]

    live_json = session.simulator.state_json()
    before_count = len(json.loads(live_json)["event_log"])
    preview = session.preview(actor, selected, order, formation, actions)
    direct = session.simulator.new_battle(session.setup_json, session.seed)
    direct.restore_json(live_json)
    direct.step_json(
        json.dumps(
            {
                "side": "PLAYER",
                "order": order,
                "commands": {
                    str(unit_id): {
                        key: value
                        for key, value in legal_by_id[unit_id][actions[slot]].items()
                        if key != "ui"
                    }
                    for slot, unit_id in enumerate(order)
                },
                "formation": formation,
            },
            separators=(",", ":"),
        )
    )
    events = json.loads(direct.state_json())["event_log"][before_count:]

    assert_preview_matches_events(preview, events, actor)
    assert_costume_card_range_matches_resolved_area(preview, payload["state"])
    assert preview["resolved_action_order"] == [
        int(event["kind"]["actor_id"])
        for event in events
        if event["kind"]["type"] == "ACTION_ENDED"
    ]


def test_reserved_skill_still_executes_after_an_earlier_action_reduces_live_sp() -> None:
    session = GuiSession(DATABASE, SCENARIOS, 97, FAST_MCTS)
    request = copy.deepcopy(session.catalog.public_payload()["presets"]["NORMAL"])
    for unit, character_id in zip(
        request["player_units"], ("Michaela", "Lathel", "Loen"), strict=True
    ):
        unit["character_id"] = character_id
        unit["costumes"] = maximum_loadout(session.catalog, character_id)
    payload = session.start(request)
    order = [int(value) for value in payload["state"]["teams"][0]["action_order"]]
    legal_by_id = {int(entry["unit_id"]): entry["commands"] for entry in payload["legal"]}

    def costume_index(unit_id: int, costume_id: str, sp_cost: int) -> int:
        return next(
            index
            for index, command in enumerate(legal_by_id[unit_id])
            if command.get("costume_id") == costume_id and int(command["ui"]["sp_cost"]) == sp_cost
        )

    actions = [
        costume_index(order[0], "Michaela_2", 2),
        costume_index(order[1], "Lathel_3", 5),
        costume_index(order[2], "Loen_3", 6),
    ]
    actor = order[2]
    live_json = session.simulator.state_json()
    before_count = len(json.loads(live_json)["event_log"])

    preview = session.preview(actor, actions[2], order, {}, actions)
    direct = session.simulator.new_battle(session.setup_json, session.seed)
    direct.restore_json(live_json)
    direct.step_json(
        json.dumps(
            {
                "side": "PLAYER",
                "order": order,
                "commands": {
                    str(unit_id): {
                        key: value
                        for key, value in legal_by_id[unit_id][actions[slot]].items()
                        if key != "ui"
                    }
                    for slot, unit_id in enumerate(order)
                },
                "formation": {},
            },
            separators=(",", ":"),
        )
    )
    events = json.loads(direct.state_json())["event_log"][before_count:]

    assert preview["command"]["costume_id"] == "Loen_3"
    assert preview["resolved_command"]["costume_id"] == "Loen_3"
    actor_kinds = [event["kind"] for event in action_events(events, actor)]
    assert [kind["type"] for kind in actor_kinds].count("ACTION_STARTED") == 1
    assert not any(kind["type"] == "ACTION_SKIPPED" for kind in actor_kinds)
    assert_preview_matches_events(preview, events, actor)


def test_preview_exposes_later_action_skipped_after_battle_ends() -> None:
    session = GuiSession(DATABASE, SCENARIOS, 101, FAST_MCTS)
    request = copy.deepcopy(session.catalog.public_payload()["presets"]["NORMAL"])
    request["enemy_units"] = [request["enemy_units"][0]]
    request["player_units"][0]["character_id"] = "Loen"
    request["player_units"][0]["costumes"] = maximum_loadout(session.catalog, "Loen")
    payload = session.start(request)
    order = [int(value) for value in payload["state"]["teams"][0]["action_order"]]
    raw_legal = json.loads(session.simulator.legal_actions_json("PLAYER"))
    legal_by_id = {int(entry["unit_id"]): entry["commands"] for entry in raw_legal}
    first_skill = next(
        index
        for index, command in enumerate(legal_by_id[order[0]])
        if command.get("costume_id") == "Loen_1"
    )
    actions = [first_skill, 0, 0]
    actor = order[1]
    live_json = session.simulator.state_json()
    before_count = len(json.loads(live_json)["event_log"])

    preview = session.preview(actor, 0, order, {}, actions)
    direct = session.simulator.new_battle(session.setup_json, session.seed)
    direct.restore_json(live_json)
    direct.step_json(
        json.dumps(
            {
                "side": "PLAYER",
                "order": order,
                "commands": {
                    str(unit_id): legal_by_id[unit_id][actions[slot]]
                    for slot, unit_id in enumerate(order)
                },
                "formation": {},
            },
            separators=(",", ":"),
        )
    )
    events = json.loads(direct.state_json())["event_log"][before_count:]

    assert preview["resolved_command"] is None
    assert_preview_matches_events(preview, events, actor)


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
            else next(
                index
                for index, command in enumerate(commands)
                if command["type"] == "NORMAL_ATTACK"
            )
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
    actual_damage = {
        target_id: sum(
            int(event["kind"]["amount"])
            for event in advanced["state"]["event_log"]
            if event["kind"]["type"] == "DAMAGE_APPLIED"
            and int(event["kind"].get("actor_id", -1)) == actor
            and int(event["kind"]["target_id"]) == target_id
        )
        for target_id in damage_targets
    }
    predicted_damage = {
        int(item["target_id"]): int(item["amount"]) for item in preview["damage_by_target"]
    }
    assert predicted_damage == actual_damage
    assert preview["total_damage"] == sum(actual_damage.values())
    assert all(item["hits"] > 0 for item in preview["damage_by_target"])
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
    final_normal = next(
        index
        for index, command in enumerate(legal_by_id[final])
        if command["type"] == "NORMAL_ATTACK"
    )
    actions = [loen_skill, 0, final_normal]

    isolated = session.preview(later, 0, order, {}, [0, 0, final_normal])
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
                    if command["type"] == "NORMAL_ATTACK"
                )
            )

    before_ids = {int(unit_id) for unit_id in payload["state"]["units"]}
    preview = session.preview(actor, wide_ally_index, order, {}, actions)
    temporary = Simulator(str(DATABASE), session.setup_json, session.seed)
    temporary.restore_json(session.simulator.state_json())
    commands = {
        str(unit_id): {
            key: value for key, value in legal_by_id[unit_id][actions[slot]].items() if key != "ui"
        }
        for slot, unit_id in enumerate(order)
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
            index
            for index, command in enumerate(legal_by_id[unit_id])
            if command["type"] == "NORMAL_ATTACK"
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
            else next(
                index
                for index, command in enumerate(commands)
                if command["type"] == "NORMAL_ATTACK"
            )
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
    normal_attacks = [0 for _ in payload["legal"]]
    before = session.simulator.state_json()

    with pytest.raises(ValueError, match=r"actions\[0\] must be an integer"):
        session.step([0.5, *normal_attacks[1:]], order, {})
    assert session.simulator.state_json() == before

    with pytest.raises(ValueError, match=r"turn order\[0\] must be an integer"):
        session.step(normal_attacks, [float(order[0]), *order[1:]], {})
    assert session.simulator.state_json() == before

    with pytest.raises(ValueError, match="formation row must be an integer"):
        session.step(normal_attacks, order, {str(order[0]): {"row": 0.5, "depth": 0}})
    assert session.simulator.state_json() == before

    with pytest.raises(ValueError, match="one selection for every active unit"):
        session.step(normal_attacks[:-1], order, {})
    assert session.simulator.state_json() == before

    with pytest.raises(ValueError, match="preview action_index must be an integer"):
        session.preview(order[0], 0.5, order, {})
    assert session.simulator.state_json() == before


def test_gui_http_catalog_start_and_turn_round_trip(tmp_path: Path) -> None:
    session = GuiSession(DATABASE, SCENARIOS, 29, FAST_MCTS)
    static_root = tmp_path / "dist"
    (static_root / "assets/character-icons/64").mkdir(parents=True)
    (static_root / "index.html").write_text("<!doctype html><title>BD2</title>", encoding="utf-8")
    (static_root / "assets/app.js").write_text("export {};", encoding="utf-8")
    (static_root / "assets/app.css").write_text(":root {}", encoding="utf-8")
    shutil.copy2(
        ROOT / "ui/public/assets/character-icons/64/Lathel.png",
        static_root / "assets/character-icons/64/Lathel.png",
    )
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler_factory(session, static_root))
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
        advanced = post("/api/step", {"actions": [0, 0], "order": list(reversed(current_order))})
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

        with urllib.request.urlopen(base + "/assets/app.js", timeout=10) as response:
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


def test_production_ui_root_requires_a_complete_vite_bundle(tmp_path: Path) -> None:
    with pytest.raises(RuntimeError, match=r"npm ci.*npm run build"):
        _production_ui_root(tmp_path)

    dist = tmp_path / "ui/dist"
    assets = dist / "assets"
    assets.mkdir(parents=True)
    (dist / "index.html").write_text("<!doctype html>", encoding="utf-8")
    (assets / "app.js").write_text("export {};", encoding="utf-8")
    (assets / "app.css").write_text(":root {}", encoding="utf-8")

    assert _production_ui_root(tmp_path) == dist


@pytest.mark.parametrize(
    "disconnect",
    [BrokenPipeError(), ConnectionAbortedError(), ConnectionResetError()],
)
def test_gui_response_body_tolerates_clients_that_disconnect_during_write(
    disconnect: OSError,
) -> None:
    class DisconnectedStream:
        def write(self, body: bytes) -> None:
            assert body == b"response"
            raise disconnect

    handler_type = handler_factory(object(), UI)  # type: ignore[arg-type]
    handler = object.__new__(handler_type)
    handler.wfile = DisconnectedStream()

    handler._write_body(b"response")
