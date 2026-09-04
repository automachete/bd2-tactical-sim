from __future__ import annotations

import copy
import json
import sqlite3
from pathlib import Path
from typing import Any

from . import _native

MODE_SCENARIOS = {
    "NORMAL": "normal-demo.json",
    "MIRROR_WAR": "mirror-war-demo.json",
    "MONSTER_CHASER": "monster-chaser-current.json",
    "GOLDEN_COLOSSEUM": "golden-colosseum-reference.json",
}

DEFAULT_CELLS = (
    {"row": 0, "depth": 0},
    {"row": 1, "depth": 0},
    {"row": 2, "depth": 0},
    {"row": 0, "depth": 1},
    {"row": 2, "depth": 1},
)

EQUIPMENT_SLOTS = ("WEAPON", "ARMOR", "HELMET", "JEWELRY", "GLOVES")
EQUIPMENT_STAT_LABELS = {
    "MAX_HP_FLAT": "HP",
    "MAX_HP_PERCENT": "HP%",
    "ATTACK_FLAT": "攻撃力",
    "ATTACK_PERCENT": "攻撃力%",
    "MAGIC_FLAT": "魔法力",
    "MAGIC_PERCENT": "魔法力%",
    "DEFENSE": "防御力",
    "MAGIC_RESIST": "魔法抵抗",
    "CRIT_RATE": "クリ率",
    "CRIT_DAMAGE": "クリダメ",
}

DEFAULT_BUILD_SETTINGS = {
    "engraving_enabled": True,
    "awakening_enabled": True,
    "collection": {
        "max_hp_bp": 8_000,
        "attack_bp": 8_000,
        "magic_bp": 8_000,
        "crit_rate_bp": 5_000,
    },
    "external_buffs": {
        "attack_bonus_bp": 0,
        "crit_rate_bp": 0,
        "crit_damage_bp": 0,
        "property_damage_bp": 0,
        "shield_percent_bp": 0,
        "shield_flat": 0,
    },
    "calculator": {
        "damage_type": "NORMAL",
        "elemental_advantage": True,
        "defense_type": "NONE",
        "target_condition": {
            "min_hp": 0,
            "min_defense_bp": 0,
            "min_magic_resist_bp": 0,
        },
        "option_count": 15,
        "gear_filters": {
            "exclusive": True,
            "ur4": True,
            "ur3": True,
            "monster": True,
        },
        "world_buff_enabled": False,
    },
}


def _strict_int(value: Any, name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError(f"{name} must be an integer")
    return value


def _strict_bool(value: Any, name: str) -> bool:
    if not isinstance(value, bool):
        raise ValueError(f"{name} must be a boolean")
    return value


class DebugSetupCatalog:
    """Read the active external catalog and build GUI-authored battle setups."""

    def __init__(self, database: Path, scenario_directory: Path) -> None:
        self.database = database.resolve()
        self.scenario_directory = scenario_directory.resolve()
        self.knockback_offsets = {
            str(item["direction"]): copy.deepcopy(item["offset"])
            for item in json.loads(_native.knockback_offsets_json())
        }
        self.templates = {
            mode: json.loads((self.scenario_directory / filename).read_text(encoding="utf-8"))
            for mode, filename in MODE_SCENARIOS.items()
        }
        self.ruleset_id, self.characters = self._load_characters()
        self.monster_skills = self._load_monster_skills()

    def _load_characters(self) -> tuple[str, dict[str, dict[str, Any]]]:
        self.costume_records: dict[str, dict[str, Any]] = {}
        with sqlite3.connect(self.database) as connection:
            ruleset_row = connection.execute(
                "SELECT ruleset_id FROM catalog_versions WHERE active = 1 LIMIT 1"
            ).fetchone()
            if ruleset_row is None:
                raise ValueError("the simulator database has no active ruleset")
            ruleset_id = str(ruleset_row[0])
            character_rows = connection.execute(
                """
                SELECT character_id, rarity, record_json
                FROM characters
                WHERE ruleset_id = ?
                ORDER BY character_id
                """,
                (ruleset_id,),
            ).fetchall()
            costume_rows = connection.execute(
                """
                SELECT costume_id, character_id, record_json
                FROM costumes
                WHERE ruleset_id = ?
                ORDER BY costume_id
                """,
                (ruleset_id,),
            ).fetchall()
            equipment_rows = connection.execute(
                """
                SELECT equipment_id, record_json
                FROM equipment
                WHERE ruleset_id = ?
                ORDER BY equipment_id
                """,
                (ruleset_id,),
            ).fetchall()
            blessing_rows = connection.execute(
                """
                SELECT blessing_id, record_json
                FROM blessings
                WHERE ruleset_id = ?
                ORDER BY blessing_id
                """,
                (ruleset_id,),
            ).fetchall()

        self.blessings = []
        for blessing_id, record_json in blessing_rows:
            record = json.loads(record_json)
            self.blessings.append(
                {
                    "id": str(blessing_id),
                    "name": self._display_name(record["names"], str(blessing_id)),
                    "description_ja": "\n".join(str(line) for line in record["descriptions"]["ja"]),
                    "category": str(record["category"]),
                    "levels": [
                        {
                            "level": int(level["level"]),
                            "point_cost": int(level["point_cost"]),
                        }
                        for level in record["levels"]
                    ],
                }
            )

        self.equipment: dict[str, dict[str, Any]] = {}
        for equipment_id, record_json in equipment_rows:
            record = json.loads(record_json)
            equipment_id = str(equipment_id)

            def stat_option(key: str) -> dict[str, str]:
                return {
                    "key": key,
                    "label": EQUIPMENT_STAT_LABELS.get(key, key),
                }

            self.equipment[equipment_id] = {
                "id": equipment_id,
                "name": self._display_name(record["names"], equipment_id),
                "names": record["names"],
                "kind": record["kind"],
                "tier": record["tier"],
                "owner_character_id": record["owner_character_id"],
                "slot": record["slot"],
                "modifiers_by_refinement_score": record["modifiers_by_refinement_score"],
                "primary_stat_options": [
                    stat_option(key) for key in record["primary_stat_options"]
                ],
                "secondary_stat_options": [
                    stat_option(key) for key in record["secondary_stat_options"]
                ],
                "primary_modifiers_by_refinement_score": record[
                    "primary_modifiers_by_refinement_score"
                ],
                "secondary_modifiers_by_refinement_score": record[
                    "secondary_modifiers_by_refinement_score"
                ],
                "allowed_substats": [
                    {
                        "key": key,
                        "label": EQUIPMENT_STAT_LABELS.get(key, key),
                        "modifiers": record["substat_modifiers"][key],
                    }
                    for key in record["allowed_substats"]
                ],
            }

        costumes_by_character: dict[str, list[dict[str, Any]]] = {}
        self.system_costumes: dict[str, dict[str, Any]] = {}
        for costume_id, character_id, record_json in costume_rows:
            record = json.loads(record_json)
            self.costume_records[str(costume_id)] = record
            maximum = max(
                record["variants"],
                key=lambda variant: (
                    variant["enhancement"],
                    variant["burst_level"],
                    variant["potential_mask"],
                ),
            )
            skill_range = (
                maximum["range_override"]
                if maximum["range_override"] is not None
                else record["range"]
            )
            public_costume = {
                "id": str(costume_id),
                "name": self._display_name(record["names"], str(costume_id)),
                "skill_name": self._display_name(
                    record["skill_names"],
                    self._display_name(record["names"], str(costume_id)),
                ),
                "character_id": str(character_id),
                "max_enhancement": int(maximum["enhancement"]),
                "max_burst_level": int(maximum["burst_level"]),
                "max_potential_mask": int(maximum["potential_mask"]),
                "goddess_tear_nodes": [
                    {
                        "index": index + 1,
                        "bit": 1 << index,
                        "available": bool(int(maximum["potential_mask"]) & (1 << index)),
                    }
                    for index in range(3)
                ],
                "sp_cost": int(maximum["sp_cost"]),
                "cooldown": int(maximum["cooldown"]),
                "selector": str(maximum["selector"]),
                "target_all": bool(maximum["target_all"]),
                "range": skill_range,
                "operation_summary": self._operation_summary(maximum),
                "description_ja": str(maximum["description_ja"]),
                "permanent_potential_modifiers": record["permanent_potential_modifiers"],
                "bonding_modifiers": record["bonding_modifiers"],
            }
            if str(costume_id).startswith(("fiend:", "summon:")):
                self.system_costumes[str(costume_id)] = public_costume
                continue
            costumes_by_character.setdefault(str(character_id), []).append(public_costume)

        characters: dict[str, dict[str, Any]] = {}
        self.entities: dict[str, dict[str, Any]] = {}
        for character_id, rarity, record_json in character_rows:
            character_id = str(character_id)
            record = json.loads(record_json)
            self.entities[character_id] = {
                "id": character_id,
                "name": self._display_name(record["names"], character_id),
                "element": record["element"],
                "attack_type": record["attack_type"],
                "knockback_direction": record["knockback_direction"],
                "level_100": record["level_100"],
                "engraving_modifiers": record["engraving_modifiers"],
                "awakening_modifiers": record["awakening_modifiers"],
            }
            costumes = costumes_by_character.get(character_id, [])
            if int(rarity) != 5 or ":" in character_id or not costumes:
                continue
            characters[character_id] = {
                **self.entities[character_id],
                "rarity": int(rarity),
                "costumes": costumes,
            }
        if not characters:
            raise ValueError("the active catalog contains no playable 5-star characters")
        return ruleset_id, characters

    def command_metadata(
        self, unit: dict[str, Any], command: dict[str, Any]
    ) -> dict[str, Any] | None:
        command_type = command["type"]
        if command_type == "NORMAL_ATTACK":
            return None
        if command_type == "KNOCKBACK":
            character_id = str(unit["character_id"])
            character = self.entities.get(character_id)
            if character is None:
                raise ValueError(f"knockback command references missing character {character_id}")
            direction = str(character["knockback_direction"])
            offset = self.knockback_offsets.get(direction)
            if offset is None:
                raise ValueError(f"unsupported knockback direction: {direction}")
            return {
                "knockback_direction": direction,
                "knockback_offset": copy.deepcopy(offset),
                "knockback_distance": 1,
            }
        if command_type != "USE_COSTUME":
            raise ValueError(f"unsupported battle command: {command_type}")
        costume_id = str(command["costume_id"])
        record = self.costume_records.get(costume_id)
        if record is None:
            raise ValueError(f"command references missing costume {costume_id}")
        loadout = next(
            (item for item in unit["costume_loadout"] if item["costume_id"] == costume_id),
            None,
        )
        if loadout is None:
            raise ValueError(f"unit command references unequipped costume {costume_id}")
        enhancement = int(loadout["enhancement"])
        burst_level = int(command["burst_level"])
        potential_mask = int(loadout["potential_mask"])
        variant = next(
            (
                item
                for item in record["variants"]
                if int(item["enhancement"]) == enhancement
                and int(item["burst_level"]) == burst_level
                and int(item["potential_mask"]) == potential_mask
            ),
            None,
        )
        if variant is None:
            raise ValueError(
                f"missing exact costume variant {costume_id}/+{enhancement}/B{burst_level}/"
                f"P{potential_mask}"
            )
        base_variant = next(
            (
                item
                for item in record["variants"]
                if int(item["enhancement"]) == enhancement
                and int(item["burst_level"]) == 0
                and int(item["potential_mask"]) == potential_mask
            ),
            None,
        )
        if base_variant is None:
            raise ValueError(
                f"costume {costume_id} burst variant has no matching burst-level-zero baseline"
            )
        passive = unit["passive_modifiers"]
        effects = unit["effects"]
        sp_delta = int(passive.get("sp_cost_delta", 0)) + sum(
            int(effect.get("spec", {}).get("modifiers", {}).get("sp_cost_delta", 0))
            for effect in effects
        )
        cooldown_delta = int(passive.get("cooldown_delta", 0)) + sum(
            int(effect.get("spec", {}).get("modifiers", {}).get("cooldown_delta", 0))
            for effect in effects
        )
        sp_cost = max(0, int(variant["sp_cost"]) + sp_delta)
        base_sp_cost = max(0, int(base_variant["sp_cost"]) + sp_delta)
        return {
            "sp_cost": sp_cost,
            "base_sp_cost": base_sp_cost,
            "burst_sp_cost": max(0, sp_cost - base_sp_cost),
            "cooldown": max(0, int(variant["cooldown"]) + cooldown_delta),
            "selector": str(variant["selector"]),
            "target_all": bool(variant["target_all"]),
            "range": (
                variant["range_override"]
                if variant["range_override"] is not None
                else record["range"]
            ),
            "operation_summary": self._operation_summary(variant),
            "description_ja": str(variant["description_ja"]),
        }

    @staticmethod
    def _display_name(names: dict[str, str], fallback: str) -> str:
        for language in ("ja", "ko", "en", "zh-TW"):
            if names.get(language):
                return str(names[language])
        return fallback

    @staticmethod
    def _operation_summary(variant: dict[str, Any]) -> str:
        """Return a compact, data-derived HUD summary without inventing prose."""
        labels = {
            "ABSORB_EFFECTS_AND_APPLY_STACKS": "効果吸収・スタック付与",
            "DEAL_DAMAGE": "ダメージ",
            "HEAL": "回復",
            "APPLY_EFFECT": "効果付与",
            "APPLY_EFFECT_PER_MATCHING_ENEMY": "条件一致数に応じて効果付与",
            "REMOVE_EFFECTS": "効果解除",
            "REMOVE_EFFECTS_BY_TAG": "指定効果解除",
            "CHANGE_SP": "SP変化",
            "CHANGE_SP_PER_SUCCESSFUL_HIT": "命中数に応じてSP変化",
            "CHANGE_COOLDOWN": "クールタイム変化",
            "CHANGE_COSTUME_COOLDOWN": "指定コスチュームのクールタイム変化",
            "CONDITIONAL": "条件分岐",
            "CONSUME_HP": "HP消費",
            "EXTEND_EFFECTS": "効果時間延長",
            "INSTANT_DEATH": "即死",
            "KNOCKBACK": "ノックバック",
            "SELF_DESTRUCT": "自爆",
            "SUMMON": "召喚",
        }
        operations = variant["operations"]
        parts: list[str] = []
        for operation in operations[:3]:
            op = str(operation["op"])
            if op not in labels:
                raise ValueError(f"unsupported operation in GUI metadata: {op}")
            label = labels[op]
            hits = int(operation["hits"]) if op == "DEAL_DAMAGE" else 1
            coefficient = operation.get("coefficient_bp")
            if coefficient is not None:
                label += f" {int(coefficient) / 100:g}%"
            if hits > 1:
                label += f" / {hits}ヒット"
            parts.append(label)
        if variant["consume_remaining_sp"]:
            parts.append("残SP消費")
        return " / ".join(parts) if parts else "固有効果"

    @staticmethod
    def _condition_summary(condition: dict[str, Any] | None) -> str | None:
        if condition is None:
            return None
        kind = str(condition["type"])
        if not kind:
            raise ValueError("condition type cannot be empty")
        value = condition.get("value")
        percent = condition.get("percent_bp")
        tag = condition.get("tag")
        polarity = {
            "BENEFICIAL": "有利効果",
            "HARMFUL": "不利効果",
            "NEUTRAL": "中立効果",
        }.get(str(condition.get("polarity", "")), "効果")
        labels = {
            "TARGET_CHAIN_AT_LEAST": f"対象チェインが{value}以上",
            "TARGET_CHAIN_AT_MOST": f"対象チェインが{value}以下",
            "TARGET_CHAIN_MULTIPLE_OF": f"対象チェインが{value}の倍数",
            "TARGET_CHAIN_NOT_MULTIPLE_OF": f"対象チェインが{value}の倍数ではない",
            "ANY_OPPONENT_CHAIN_AT_LEAST": f"敵のいずれかのチェインが{value}以上",
            "TARGET_HP_AT_MOST": f"対象HPが{int(percent or 0) / 100:g}%以下",
            "ACTOR_HP_AT_MOST": f"使用者HPが{int(percent or 0) / 100:g}%以下",
            "TARGET_HAS_TAG": f"対象に{tag}がある",
            "TARGET_LACKS_TAG": f"対象に{tag}がない",
            "ACTOR_HAS_TAG": f"使用者に{tag}がある",
            "ACTOR_LACKS_TAG": f"使用者に{tag}がない",
            "IS_MAIN_TARGET": "主対象である",
            "IS_NOT_MAIN_TARGET": "主対象ではない",
            "TARGET_EFFECT_COUNT_AT_LEAST": f"対象の{polarity}が{value}個以上",
            "TARGET_EFFECT_COUNT_AT_MOST": f"対象の{polarity}が{value}個以下",
            "ACTOR_EFFECT_COUNT_AT_LEAST": f"使用者の{polarity}が{value}個以上",
            "TARGET_ATTACK_TYPE": f"対象の攻撃種別が{condition.get('attack_type')}",
            "TARGET_NOT_ATTACK_TYPE": f"対象の攻撃種別が{condition.get('attack_type')}ではない",
            "TARGET_ELEMENT": f"対象属性が{condition.get('element')}",
            "TARGET_NOT_ELEMENT": f"対象属性が{condition.get('element')}ではない",
        }
        if kind in {"ANY", "ALL"}:
            joiner = " または " if kind == "ANY" else " かつ "
            nested = [
                DebugSetupCatalog._condition_summary(item) for item in condition["conditions"]
            ]
            if not nested or any(item is None for item in nested):
                raise ValueError(f"empty nested condition: {kind}")
            return joiner.join(item for item in nested if item)
        if kind not in labels:
            raise ValueError(f"unsupported condition in GUI metadata: {kind}")
        return labels[kind]

    def public_payload(self) -> dict[str, Any]:
        return {
            "ruleset_id": self.ruleset_id,
            "characters": list(self.characters.values()),
            "entities": list(self.entities.values()),
            "system_costumes": list(self.system_costumes.values()),
            "monster_skills": self.monster_skills,
            "equipment": list(self.equipment.values()),
            "blessings": copy.deepcopy(self.blessings),
            "build_settings_default": copy.deepcopy(DEFAULT_BUILD_SETTINGS),
            "presets": {
                mode: self._preset_from_template(mode, template)
                for mode, template in self.templates.items()
            },
        }

    def default_character_profile(self, character_id: str) -> dict[str, Any]:
        character = self.characters.get(character_id)
        if character is None:
            raise ValueError(f"unknown character profile: {character_id}")
        return {
            "character_id": character_id,
            "awakening_enabled": True,
            "costumes": [
                {
                    "costume_id": costume["id"],
                    "enhancement": costume["max_enhancement"],
                    "burst_level": costume["max_burst_level"],
                    "potential_mask": costume["max_potential_mask"],
                }
                for costume in character["costumes"]
            ],
            "equipment": {},
        }

    def normalize_character_profile(self, value: Any) -> dict[str, Any]:
        """Validate the only supported character-profile schema."""

        required = {"character_id", "awakening_enabled", "costumes", "equipment"}
        if not isinstance(value, dict) or set(value) != required:
            raise ValueError(
                "character profile must contain only character_id, awakening_enabled, "
                "costumes and equipment"
            )
        character_id = value["character_id"]
        if not isinstance(character_id, str) or character_id not in self.characters:
            raise ValueError(f"unknown character profile: {character_id}")
        awakening_enabled = _strict_bool(value["awakening_enabled"], "awakening_enabled")
        costumes = value["costumes"]
        if not isinstance(costumes, list):
            raise ValueError("character profile costumes must be an array")
        normalized_input: list[dict[str, Any]] = []
        for index, costume in enumerate(costumes):
            expected = {"costume_id", "enhancement", "burst_level", "potential_mask"}
            if not isinstance(costume, dict) or set(costume) != expected:
                raise ValueError(
                    f"character profile costumes[{index}] must contain only "
                    "costume_id, enhancement, burst_level and potential_mask"
                )
            normalized_input.append(
                {
                    **costume,
                    "permanent_potential_enabled": True,
                }
            )
        expected_costumes = {item["id"] for item in self.characters[character_id]["costumes"]}
        actual_costumes = [str(item["costume_id"]) for item in normalized_input]
        if len(actual_costumes) != len(set(actual_costumes)):
            raise ValueError(f"duplicate costume in character profile: {character_id}")
        if set(actual_costumes) != expected_costumes:
            raise ValueError(
                f"character profile {character_id} must contain every current costume exactly once"
            )
        normalized_loadout = self._build_loadout(
            self.characters[character_id],
            {"costumes": normalized_input, "costume_link_target": None},
        )
        equipment = self._build_equipment({"equipment": value["equipment"]}, character_id)
        return {
            "character_id": character_id,
            "awakening_enabled": awakening_enabled,
            "costumes": [
                {
                    "costume_id": item["costume_id"],
                    "enhancement": item["enhancement"],
                    "burst_level": item["burst_level"],
                    "potential_mask": item["potential_mask"],
                }
                for item in normalized_loadout
            ],
            "equipment": equipment,
        }

    def _load_monster_skills(self) -> list[dict[str, Any]]:
        template = self.templates["MONSTER_CHASER"]
        ids = [
            costume["costume_id"]
            for unit in template["units"]
            if unit["side"] == "ENEMY" and unit.get("can_act", True)
            for costume in unit["costume_loadout"]
        ]
        if not ids:
            return []
        placeholders = ",".join("?" for _ in ids)
        with sqlite3.connect(self.database) as connection:
            rows = connection.execute(
                f"SELECT costume_id, record_json FROM costumes "
                f"WHERE ruleset_id = ? AND costume_id IN ({placeholders})",
                (self.ruleset_id, *ids),
            ).fetchall()
        records = {str(costume_id): json.loads(record_json) for costume_id, record_json in rows}
        result: list[dict[str, Any]] = []
        for index, costume_id in enumerate(ids):
            record = records.get(costume_id)
            if record is None:
                raise ValueError(f"Monster Chaser template references missing skill {costume_id}")
            variant = max(
                record["variants"],
                key=lambda item: (item["enhancement"], item["burst_level"], item["potential_mask"]),
            )
            result.append(
                {
                    "id": costume_id,
                    "name": self._display_name(record["names"], f"魔物スキル {index + 1}"),
                    "sequence": int(
                        variant["ai_sequence_index"]
                        if variant["ai_sequence_index"] is not None
                        else index
                    ),
                    "condition": self._condition_summary(variant["activation_condition"]),
                    "range": (
                        variant["range_override"]
                        if variant["range_override"] is not None
                        else record["range"]
                    ),
                    "operation_summary": self._operation_summary(variant),
                    "description_ja": str(variant["description_ja"]),
                }
            )
        return sorted(result, key=lambda item: item["sequence"])

    def _preset_from_template(self, mode: str, template: dict[str, Any]) -> dict[str, Any]:
        return self._editor_payload(mode, template, preserve_loadout=False)

    def editor_payload_from_setup(self, setup: dict[str, Any]) -> dict[str, Any]:
        """Return the exact current setup in the GUI editor's external schema."""
        return self._editor_payload(str(setup["rules"]["mode"]), setup, preserve_loadout=True)

    def _editor_payload(
        self, mode: str, setup: dict[str, Any], *, preserve_loadout: bool
    ) -> dict[str, Any]:
        player_units = [
            self._editor_unit(unit, mode=mode, preserve_loadout=preserve_loadout)
            for unit in setup["units"]
            if unit["side"] == "PLAYER" and unit["character_id"] in self.characters
        ]
        enemy_units = [
            self._editor_unit(unit, mode=mode, preserve_loadout=preserve_loadout)
            for unit in setup["units"]
            if unit["side"] == "ENEMY" and unit["character_id"] in self.characters
        ]
        payload: dict[str, Any] = {
            "mode": mode,
            "grid": copy.deepcopy(setup["rules"]["grid"]),
            "player_units": player_units,
            "enemy_units": enemy_units,
        }
        if setup.get("monster_chaser"):
            payload["monster_level"] = setup["monster_chaser"]["selected_level"]
        if setup.get("golden_colosseum"):
            payload["golden_colosseum"] = copy.deepcopy(setup["golden_colosseum"])
        return payload

    def _editor_unit(
        self, unit: dict[str, Any], *, mode: str, preserve_loadout: bool = False
    ) -> dict[str, Any]:
        character = self.characters.get(unit["character_id"])
        if character is not None and mode == "GOLDEN_COLOSSEUM":
            configured = {item["costume_id"]: item for item in unit["costume_loadout"]}
            costumes = []
            for costume in character["costumes"]:
                loadout = configured.get(costume["id"])
                costumes.append(
                    {
                        "costume_id": costume["id"],
                        "enhancement": (
                            loadout["enhancement"] if loadout else costume["max_enhancement"]
                        ),
                        "burst_level": (
                            loadout["burst_level"] if loadout else costume["max_burst_level"]
                        ),
                        "potential_mask": (
                            loadout.get("potential_mask", 7)
                            if loadout
                            else costume["max_potential_mask"]
                        ),
                        # Non-skill potential nodes do not consume Goddess Tears and
                        # are always considered unlocked by the simulator build.
                        "permanent_potential_enabled": True,
                        "enabled": loadout is not None,
                    }
                )
        elif character is not None and not preserve_loadout:
            costumes = [
                {
                    "costume_id": costume["id"],
                    "enhancement": costume["max_enhancement"],
                    "burst_level": costume["max_burst_level"],
                    "potential_mask": costume["max_potential_mask"],
                    "permanent_potential_enabled": True,
                }
                for costume in character["costumes"]
            ]
        else:
            costumes = [
                {
                    "costume_id": loadout["costume_id"],
                    "enhancement": loadout["enhancement"],
                    "burst_level": loadout["burst_level"],
                    "potential_mask": loadout.get("potential_mask", 7),
                    "permanent_potential_enabled": True,
                }
                for loadout in unit["costume_loadout"]
            ]
        return {
            "character_id": unit["character_id"],
            "row": unit["position"]["row"],
            "depth": unit["position"]["depth"],
            "party_no": unit.get("party_no", 1),
            "costumes": costumes,
            "costume_link_target": next(
                (
                    item["costume_link_target"]
                    for item in unit["costume_loadout"]
                    if item.get("costume_link_target")
                ),
                None,
            ),
            "equipment": unit.get("equipment", {}),
            "build_settings": copy.deepcopy(unit.get("build_settings", DEFAULT_BUILD_SETTINGS)),
        }

    def build_setup(self, request: dict[str, Any]) -> dict[str, Any]:
        mode = str(request.get("mode", "")).upper()
        if mode not in self.templates:
            raise ValueError(f"unknown battle mode: {mode}")
        setup = copy.deepcopy(self.templates[mode])
        setup["scenario_id"] = f"gui-{mode.lower().replace('_', '-')}"
        # Debug play intentionally enables the human PLAYER side where the mode permits it.
        if mode != "GOLDEN_COLOSSEUM":
            setup["rules"]["allow_manual_commands"] = [True, False]

        grid = setup["rules"]["grid"]
        limit = int(grid["deployment_limit"])

        player_request = request.get("player_units")
        if not isinstance(player_request, list):
            raise ValueError("player_units must be a list")
        player_units = self._build_side_units(mode, "PLAYER", player_request, grid, limit)
        if mode == "MONSTER_CHASER":
            enemy_units = [unit for unit in setup["units"] if unit["side"] == "ENEMY"]
            monster = setup["monster_chaser"]
            selected_level = _strict_int(
                request.get("monster_level", monster["selected_level"]), "monster_level"
            )
            if selected_level < 1 or selected_level > len(monster["cumulative_hp_by_level"]):
                raise ValueError("monster_level is outside the available range")
            monster["selected_level"] = selected_level
            parties = {unit["party_no"] for unit in player_units}
            if parties != {1, 2}:
                raise ValueError("Monster Chaser requires at least one unit in both parties")
        else:
            enemy_request = request.get("enemy_units")
            if not isinstance(enemy_request, list):
                raise ValueError("enemy_units must be a list")
            enemy_units = self._build_side_units(mode, "ENEMY", enemy_request, grid, limit)
        if mode == "GOLDEN_COLOSSEUM":
            setup["golden_colosseum"] = self._build_golden_colosseum(
                request.get("golden_colosseum"), setup["golden_colosseum"], grid
            )
        setup["units"] = player_units + enemy_units
        return setup

    def _build_side_units(
        self,
        mode: str,
        side: str,
        requests: list[dict[str, Any]],
        grid: dict[str, Any],
        deployment_limit: int,
    ) -> list[dict[str, Any]]:
        limit = 10 if mode == "MONSTER_CHASER" and side == "PLAYER" else deployment_limit
        if not 1 <= len(requests) <= limit:
            raise ValueError(f"{side} must contain between 1 and {limit} units")
        party_counts: dict[int, int] = {}
        occupied: set[tuple[int, int, int]] = set()
        characters_by_party: set[tuple[int, str]] = set()
        costumes_by_party: set[tuple[int, str]] = set()
        units: list[dict[str, Any]] = []
        for index, request in enumerate(requests):
            if not isinstance(request, dict):
                raise ValueError(f"{side} unit entries must be objects")
            character_id = str(request.get("character_id", ""))
            character = self.characters.get(character_id)
            if character is None:
                raise ValueError(f"unknown playable 5-star character: {character_id}")
            party_no = _strict_int(request.get("party_no", 1), "party_no")
            if mode != "MONSTER_CHASER" or side != "PLAYER":
                party_no = 1
            if party_no not in (1, 2):
                raise ValueError("party_no must be 1 or 2")
            party_counts[party_no] = party_counts.get(party_no, 0) + 1
            party_limit = deployment_limit if mode == "GOLDEN_COLOSSEUM" else 5
            if party_counts[party_no] > party_limit:
                raise ValueError(
                    f"party {party_no} exceeds the {party_limit}-unit deployment limit"
                )
            character_key = (party_no, character_id)
            if mode != "GOLDEN_COLOSSEUM" and character_key in characters_by_party:
                raise ValueError(f"duplicate character in party {party_no}: {character_id}")
            characters_by_party.add(character_key)
            row = _strict_int(request.get("row", DEFAULT_CELLS[index % 5]["row"]), "row")
            depth = _strict_int(request.get("depth", DEFAULT_CELLS[index % 5]["depth"]), "depth")
            if not 0 <= row < int(grid["rows"]) or not 0 <= depth < int(grid["depths"]):
                raise ValueError(f"invalid formation cell: row={row}, depth={depth}")
            if [row, depth] in grid.get("blocked", []):
                raise ValueError(f"blocked formation cell: row={row}, depth={depth}")
            cell_key = (party_no, row, depth)
            if cell_key in occupied:
                raise ValueError(f"duplicate formation cell in party {party_no}: {row},{depth}")
            occupied.add(cell_key)
            loadout = self._build_loadout(
                character, request, maximum_costumes=1 if mode == "GOLDEN_COLOSSEUM" else None
            )
            costume_key = (party_no, loadout[0]["costume_id"])
            if mode == "GOLDEN_COLOSSEUM" and costume_key in costumes_by_party:
                raise ValueError(
                    f"duplicate costume in party {party_no}: {loadout[0]['costume_id']}"
                )
            costumes_by_party.add(costume_key)
            unit_id = self._unit_id(side, party_no, index, party_counts[party_no])
            units.append(
                {
                    "unit_id": unit_id,
                    "character_id": character_id,
                    "side": side,
                    "position": {"row": row, "depth": depth},
                    "costume_loadout": loadout,
                    "stat_overrides": None,
                    "build_settings": self._build_settings(request),
                    "equipment": (
                        {}
                        if mode == "GOLDEN_COLOSSEUM"
                        else self._build_equipment(request, character_id)
                    ),
                    "ai_priority": [item["costume_id"] for item in loadout],
                    "party_no": party_no,
                    "hp_owner": None,
                    "weak_point_bonus_bp": 0,
                    "can_act": True,
                }
            )
        return units

    @staticmethod
    def _unit_id(side: str, party_no: int, index: int, party_position: int) -> int:
        if side == "ENEMY":
            return 100 + index + 1
        if party_no == 2:
            return 100 + party_position
        return party_position

    def _build_loadout(
        self,
        character: dict[str, Any],
        request: dict[str, Any],
        maximum_costumes: int | None = None,
    ) -> list[dict[str, Any]]:
        available = {item["id"]: item for item in character["costumes"]}
        requested = request.get("costumes")
        if requested is None:
            requested = [{"costume_id": costume_id} for costume_id in available]
        if not isinstance(requested, list) or not requested:
            raise ValueError(f"{character['id']} must equip at least one costume")
        link_target = request.get("costume_link_target")
        seen: set[str] = set()
        result: list[dict[str, Any]] = []
        for value in requested:
            if not isinstance(value, dict):
                raise ValueError("costume entries must be objects")
            enabled = value.get("enabled", True)
            if not isinstance(enabled, bool):
                raise ValueError("costume enabled must be a boolean")
            if not enabled:
                continue
            costume_id = str(value.get("costume_id", ""))
            maximum = available.get(costume_id)
            if maximum is None:
                raise ValueError(f"costume {costume_id} does not belong to {character['id']}")
            if costume_id in seen:
                raise ValueError(f"duplicate costume in loadout: {costume_id}")
            seen.add(costume_id)
            enhancement = _strict_int(
                value.get("enhancement", maximum["max_enhancement"]), "enhancement"
            )
            burst = _strict_int(value.get("burst_level", maximum["max_burst_level"]), "burst_level")
            potential = _strict_int(
                value.get("potential_mask", maximum["max_potential_mask"]), "potential_mask"
            )
            if not 0 <= enhancement <= maximum["max_enhancement"]:
                raise ValueError(f"invalid enhancement for {costume_id}")
            if not 0 <= burst <= maximum["max_burst_level"]:
                raise ValueError(f"invalid burst level for {costume_id}")
            if not 0 <= potential <= 7:
                raise ValueError(f"invalid potential mask for {costume_id}")
            if value.get("permanent_potential_enabled", True) is not True:
                raise ValueError(
                    "non-Tear potential stats are fixed as unlocked; "
                    "permanent_potential_enabled must be true"
                )
            result.append(
                {
                    "costume_id": costume_id,
                    "enhancement": enhancement,
                    "burst_level": burst,
                    "potential_mask": potential,
                    # Only the three skill nodes represented by potential_mask are
                    # configurable. All non-Tear stat nodes are fixed as unlocked.
                    "permanent_potential_enabled": True,
                    "costume_link_target": None,
                }
            )
        if not result:
            raise ValueError(f"{character['id']} must equip at least one enabled costume")
        if maximum_costumes is not None and len(result) > maximum_costumes:
            raise ValueError(
                f"{character['id']} may equip at most {maximum_costumes} costume in this mode"
            )
        if link_target:
            if link_target not in seen:
                raise ValueError("costume_link_target must be an equipped costume")
            result[0]["costume_link_target"] = str(link_target)
        return result

    def _build_golden_colosseum(
        self, value: Any, fallback: dict[str, Any], grid: dict[str, Any]
    ) -> dict[str, Any]:
        if value is None:
            return copy.deepcopy(fallback)
        if not isinstance(value, dict):
            raise ValueError("golden_colosseum must be an object")
        required = {
            "season_label",
            "weekly_attempts",
            "refill_limit",
            "starting_rating",
            "undeployable_grid_count",
            "death_time_all_turn",
            "banned_costume_ids",
            "banned_blessing_ids",
            "side_blessings",
        }
        if set(value) != required:
            raise ValueError("golden_colosseum has unknown or missing fields")
        if not isinstance(value["season_label"], str) or not value["season_label"].strip():
            raise ValueError("golden_colosseum.season_label must be non-empty")
        weekly_attempts = _strict_int(value["weekly_attempts"], "weekly_attempts")
        refill_limit = _strict_int(value["refill_limit"], "refill_limit")
        starting_rating = _strict_int(value["starting_rating"], "starting_rating")
        undeployable_count = _strict_int(
            value["undeployable_grid_count"], "undeployable_grid_count"
        )
        if weekly_attempts < 1 or refill_limit < 0 or starting_rating < 1:
            raise ValueError("Golden Colosseum season counters must be non-negative")
        if undeployable_count != len(grid["blocked"]):
            raise ValueError("undeployable_grid_count must match the materialized blocked cells")
        death_turn = _strict_int(value["death_time_all_turn"], "death_time_all_turn")
        if death_turn < 1:
            raise ValueError("death_time_all_turn must be positive")
        known_blessings = {item["id"] for item in self.blessings}
        banned_costumes = value["banned_costume_ids"]
        banned_blessings = value["banned_blessing_ids"]
        if not isinstance(banned_costumes, list) or not all(
            isinstance(item, str) and item in self.costume_records for item in banned_costumes
        ):
            raise ValueError("banned_costume_ids contains an unknown costume")
        if not isinstance(banned_blessings, list) or not all(
            isinstance(item, str) and item in known_blessings for item in banned_blessings
        ):
            raise ValueError("banned_blessing_ids contains an unknown blessing")
        sides = value["side_blessings"]
        if not isinstance(sides, list) or len(sides) != 2:
            raise ValueError("side_blessings must contain PLAYER and ENEMY")
        normalized_sides: list[dict[str, Any]] = []
        by_id = {item["id"]: item for item in self.blessings}
        for side_index, side in enumerate(sides):
            if not isinstance(side, dict) or set(side) != {"going_first", "going_second"}:
                raise ValueError(f"side_blessings[{side_index}] has an invalid schema")
            normalized: dict[str, Any] = {}
            for initiative in ("going_first", "going_second"):
                loadout = side[initiative]
                if not isinstance(loadout, dict) or set(loadout) != {"point_limit", "selected"}:
                    raise ValueError(f"{initiative} blessing loadout has an invalid schema")
                point_limit = _strict_int(loadout["point_limit"], f"{initiative}.point_limit")
                selected = loadout["selected"]
                if not 3 <= point_limit <= 15 or not isinstance(selected, list):
                    raise ValueError(f"{initiative} blessing loadout is outside current ranges")
                normalized_selected: list[dict[str, Any]] = []
                seen: set[str] = set()
                spent = 0
                for selection in selected:
                    if not isinstance(selection, dict) or set(selection) != {
                        "blessing_id",
                        "level",
                    }:
                        raise ValueError("blessing selection has an invalid schema")
                    blessing_id = str(selection["blessing_id"])
                    level_number = _strict_int(selection["level"], "blessing level")
                    definition = by_id.get(blessing_id)
                    if definition is None or blessing_id in banned_blessings or blessing_id in seen:
                        raise ValueError(f"illegal blessing selection: {blessing_id}")
                    level = next(
                        (item for item in definition["levels"] if item["level"] == level_number),
                        None,
                    )
                    if level is None:
                        raise ValueError(f"unknown blessing level: {blessing_id}[{level_number}]")
                    seen.add(blessing_id)
                    spent += int(level["point_cost"])
                    normalized_selected.append({"blessing_id": blessing_id, "level": level_number})
                if spent > point_limit:
                    raise ValueError(f"{initiative} blessing loadout exceeds its point limit")
                normalized[initiative] = {
                    "point_limit": point_limit,
                    "selected": normalized_selected,
                }
            normalized_sides.append(normalized)
        return {
            "season_label": value["season_label"].strip(),
            "weekly_attempts": weekly_attempts,
            "refill_limit": refill_limit,
            "starting_rating": starting_rating,
            "undeployable_grid_count": undeployable_count,
            "death_time_all_turn": death_turn,
            "banned_costume_ids": list(dict.fromkeys(banned_costumes)),
            "banned_blessing_ids": list(dict.fromkeys(banned_blessings)),
            "side_blessings": normalized_sides,
        }

    def _build_equipment(self, request: dict[str, Any], character_id: str) -> dict[str, Any]:
        value = request.get("equipment", {})
        if not isinstance(value, dict):
            raise ValueError("equipment must be an object keyed by equipment slot")
        unknown_slots = set(value) - set(EQUIPMENT_SLOTS)
        if unknown_slots:
            raise ValueError(f"unknown equipment slot: {sorted(unknown_slots)[0]}")
        result: dict[str, Any] = {}
        for slot, loadout in value.items():
            if loadout is None:
                continue
            if not isinstance(loadout, dict):
                raise ValueError(f"{slot} equipment loadout must be an object")
            equipment_id = str(loadout.get("equipment_id", ""))
            definition = self.equipment.get(equipment_id)
            if definition is None:
                raise ValueError(f"unknown supported equipment: {equipment_id}")
            if definition["slot"] != slot:
                raise ValueError(f"equipment {equipment_id} does not belong in {slot}")
            exclusive = definition["kind"] == "EXCLUSIVE"
            if exclusive and definition["owner_character_id"] != character_id:
                raise ValueError(
                    f"exclusive equipment {equipment_id} belongs to "
                    f"{definition['owner_character_id']}, not {character_id}"
                )
            score = _strict_int(loadout.get("refinement_score"), "refinement_score")
            if not 18 <= score <= 24:
                raise ValueError("refinement_score must be between 18 and 24")
            if str(score) not in definition["modifiers_by_refinement_score"]:
                raise ValueError(f"equipment {equipment_id} has no score {score} data")
            substats = loadout.get("substats")
            if not isinstance(substats, list) or len(substats) != 3:
                raise ValueError(f"equipment {equipment_id} must have exactly three substats")
            allowed = {entry["key"] for entry in definition["allowed_substats"]}
            if any(not isinstance(key, str) or key not in allowed for key in substats):
                raise ValueError(f"equipment {equipment_id} contains an illegal substat")
            primary_stat = loadout.get("primary_stat")
            secondary_stat = loadout.get("secondary_stat")
            if exclusive:
                primary_allowed = {option["key"] for option in definition["primary_stat_options"]}
                secondary_allowed = {
                    option["key"] for option in definition["secondary_stat_options"]
                }
                if primary_stat not in primary_allowed:
                    raise ValueError(
                        f"exclusive equipment {equipment_id} requires a legal primary_stat"
                    )
                if secondary_stat not in secondary_allowed:
                    raise ValueError(
                        f"exclusive equipment {equipment_id} requires a legal secondary_stat"
                    )
            elif primary_stat is not None or secondary_stat is not None:
                raise ValueError(f"crafted equipment {equipment_id} has fixed primary abilities")
            result[slot] = {
                "equipment_id": equipment_id,
                "refinement_score": score,
                "primary_stat": primary_stat,
                "secondary_stat": secondary_stat,
                "substats": substats,
            }
        return result

    def _build_settings(self, request: dict[str, Any]) -> dict[str, Any]:
        value = request.get("build_settings", DEFAULT_BUILD_SETTINGS)
        if not isinstance(value, dict):
            raise ValueError("build_settings must be an object")
        required = {
            "engraving_enabled",
            "awakening_enabled",
            "collection",
            "external_buffs",
            "calculator",
        }
        if set(value) != required:
            raise ValueError("build_settings must contain the complete current schema")

        collection = value["collection"]
        external = value["external_buffs"]
        calculator = value["calculator"]
        if not all(isinstance(item, dict) for item in (collection, external, calculator)):
            raise ValueError("build_settings sections must be objects")

        collection_limits = {
            "max_hp_bp": 8_000,
            "attack_bp": 8_000,
            "magic_bp": 8_000,
            "crit_rate_bp": 5_000,
        }
        if set(collection) != set(collection_limits):
            raise ValueError("collection has unknown or missing fields")
        normalized_collection: dict[str, int] = {}
        for key, maximum in collection_limits.items():
            amount = _strict_int(collection[key], f"collection.{key}")
            if not 0 <= amount <= maximum:
                raise ValueError(f"collection.{key} is outside the BD2DB range")
            normalized_collection[key] = amount

        external_keys = {
            "attack_bonus_bp",
            "crit_rate_bp",
            "crit_damage_bp",
            "property_damage_bp",
            "shield_percent_bp",
            "shield_flat",
        }
        if set(external) != external_keys:
            raise ValueError("external_buffs has unknown or missing fields")
        normalized_external = {
            key: _strict_int(external[key], f"external_buffs.{key}") for key in external_keys
        }
        if normalized_external["shield_percent_bp"] < 0 or normalized_external["shield_flat"] < 0:
            raise ValueError("external shield values cannot be negative")

        target = calculator.get("target_condition")
        filters = calculator.get("gear_filters")
        if not isinstance(target, dict) or not isinstance(filters, dict):
            raise ValueError("calculator target_condition and gear_filters must be objects")
        calculator_keys = {
            "damage_type",
            "elemental_advantage",
            "defense_type",
            "target_condition",
            "option_count",
            "gear_filters",
            "world_buff_enabled",
        }
        if set(calculator) != calculator_keys:
            raise ValueError("calculator has unknown or missing fields")
        if set(target) != {"min_hp", "min_defense_bp", "min_magic_resist_bp"}:
            raise ValueError("target_condition has unknown or missing fields")
        if set(filters) != {"exclusive", "ur4", "ur3", "monster"}:
            raise ValueError("gear_filters has unknown or missing fields")
        normalized_target = {
            key: _strict_int(target[key], f"calculator.target_condition.{key}") for key in target
        }
        if normalized_target["min_hp"] < 0:
            raise ValueError("calculator target HP cannot be negative")
        for key in ("min_defense_bp", "min_magic_resist_bp"):
            if not 0 <= normalized_target[key] <= 9_000:
                raise ValueError(f"calculator.{key} must be between 0 and 9000")
        damage_type = str(calculator["damage_type"])
        defense_type = str(calculator["defense_type"])
        if damage_type not in {"NORMAL", "FIXED", "HP_SHIELD", "HP"}:
            raise ValueError("calculator.damage_type is unsupported")
        if defense_type not in {"NONE", "DEFENSE", "MAGIC_RESIST"}:
            raise ValueError("calculator.defense_type is unsupported")
        option_count = _strict_int(calculator["option_count"], "calculator.option_count")
        if not 1 <= option_count <= 15:
            raise ValueError("calculator.option_count must be between 1 and 15")

        return {
            "engraving_enabled": _strict_bool(value["engraving_enabled"], "engraving_enabled"),
            "awakening_enabled": _strict_bool(value["awakening_enabled"], "awakening_enabled"),
            "collection": normalized_collection,
            "external_buffs": normalized_external,
            "calculator": {
                "damage_type": damage_type,
                "elemental_advantage": _strict_bool(
                    calculator["elemental_advantage"], "calculator.elemental_advantage"
                ),
                "defense_type": defense_type,
                "target_condition": normalized_target,
                "option_count": option_count,
                "gear_filters": {
                    key: _strict_bool(filters[key], f"calculator.gear_filters.{key}")
                    for key in ("exclusive", "ur4", "ur3", "monster")
                },
                "world_buff_enabled": _strict_bool(
                    calculator["world_buff_enabled"], "calculator.world_buff_enabled"
                ),
            },
        }
