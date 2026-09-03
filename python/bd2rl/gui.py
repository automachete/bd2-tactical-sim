from __future__ import annotations

import argparse
import copy
import json
import os
import threading
import webbrowser
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

from . import _native
from .debug_setup import DebugSetupCatalog
from .mcts import MctsConfig, MctsPlanner, MctsResult


def _saved_setup_name(value: Any) -> str:
    if not isinstance(value, str):
        raise ValueError("saved setup name must be a string")
    name = value.strip()
    if not name or len(name) > 80:
        raise ValueError("saved setup name must contain 1 to 80 characters")
    if name in {".", ".."} or any(character in name for character in "/\\:\0"):
        raise ValueError("saved setup name contains a forbidden path character")
    if any(ord(character) < 32 for character in name):
        raise ValueError("saved setup name contains a control character")
    return name


class SavedSetupStore:
    """Durable, strict BattleSetup files shared by the GUI and training CLI."""

    def __init__(self, directory: Path) -> None:
        self.directory = directory.resolve()
        self.directory.mkdir(parents=True, exist_ok=True)

    def list(self) -> list[dict[str, str]]:
        return [
            {"name": path.stem, "scenario": path.name}
            for path in sorted(
                self.directory.glob("*.json"), key=lambda value: value.name.casefold()
            )
            if path.is_file()
        ]

    def save(self, name: Any, setup: dict[str, Any]) -> dict[str, str]:
        normalized = _saved_setup_name(name)
        destination = self._path(normalized)
        temporary = destination.with_suffix(".json.tmp")
        body = json.dumps(setup, ensure_ascii=False, indent=2) + "\n"
        temporary.write_text(body, encoding="utf-8", newline="\n")
        os.replace(temporary, destination)
        return {"name": normalized, "scenario": destination.name}

    def load(self, name: Any) -> dict[str, Any]:
        path = self._path(_saved_setup_name(name))
        if not path.is_file():
            raise ValueError(f"saved setup does not exist: {path.stem}")
        value = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(value, dict):
            raise ValueError("saved setup must be a JSON object")
        return value

    def _path(self, name: str) -> Path:
        path = (self.directory / f"{name}.json").resolve()
        if path.parent != self.directory:
            raise ValueError("saved setup path escapes its configured directory")
        return path


def _strict_int(value: Any, name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError(f"{name} must be an integer")
    return value


def _unit_id_key(value: Any, name: str) -> int:
    if isinstance(value, bool):
        raise ValueError(f"{name} must be an integer unit id")
    if isinstance(value, int):
        result = value
    elif isinstance(value, str) and value.isascii() and value.isdecimal():
        result = int(value)
    else:
        raise ValueError(f"{name} must be an integer unit id")
    if result < 0:
        raise ValueError(f"{name} must be a non-negative unit id")
    return result


def _strict_int_list(value: Any, name: str) -> list[int]:
    if not isinstance(value, list):
        raise ValueError(f"{name} must be an array of integers")
    return [_strict_int(item, f"{name}[{index}]") for index, item in enumerate(value)]


def _normalize_formation(value: Any) -> dict[str, dict[str, int]]:
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise ValueError("formation must be an object keyed by unit id")
    normalized: dict[str, dict[str, int]] = {}
    for raw_id, raw_cell in value.items():
        unit_id = _unit_id_key(raw_id, "formation unit id")
        key = str(unit_id)
        if key in normalized:
            raise ValueError("formation contains the same unit id more than once")
        if not isinstance(raw_cell, dict):
            raise ValueError("formation cell must be an object")
        if "row" not in raw_cell or "depth" not in raw_cell:
            raise ValueError("formation cell must contain row and depth")
        normalized[key] = {
            "row": _strict_int(raw_cell["row"], "formation row"),
            "depth": _strict_int(raw_cell["depth"], "formation depth"),
        }
    return normalized


def _preview_footprint(
    state: dict[str, Any],
    actor_id: int,
    command: dict[str, Any],
    target_side: str | None,
    anchor: dict[str, int] | None,
    positions: dict[int, dict[str, int]],
) -> tuple[list[dict[str, int]], list[int]]:
    """Project the exact resolved command footprint onto the current mode grid."""
    if anchor is None or target_side is None:
        return [], []

    grid = state["rules"]["grid"]
    rows = int(grid["rows"])
    depths = int(grid["depths"])
    command_type = command["type"]
    if command_type not in {"NORMAL_ATTACK", "KNOCKBACK", "USE_COSTUME"}:
        raise ValueError(f"unsupported preview command: {command_type}")
    metadata = command.get("ui")
    if command_type == "USE_COSTUME" and not isinstance(metadata, dict):
        raise ValueError("costume preview is missing authoritative UI metadata")
    target_all = bool(metadata["target_all"]) if metadata is not None else False
    if target_all:
        cells = [{"row": row, "depth": depth} for row in range(rows) for depth in range(depths)]
    else:
        offsets = metadata["range"] if command_type == "USE_COSTUME" else None
        if offsets is None or offsets == []:
            offsets = [{"row": 0, "depth": 0}]
        coordinates = {
            (
                int(anchor["row"]) + int(offset["row"]),
                int(anchor["depth"]) + int(offset["depth"]),
            )
            for offset in offsets
        }
        cells = [
            {"row": row, "depth": depth}
            for row, depth in sorted(coordinates)
            if 0 <= row < rows and 0 <= depth < depths
        ]

    occupied = {(cell["row"], cell["depth"]) for cell in cells}
    affected = sorted(
        int(raw_id)
        for raw_id, unit in state["units"].items()
        if unit["alive"]
        and unit["side"] == target_side
        and (
            int(positions[int(raw_id)]["row"]),
            int(positions[int(raw_id)]["depth"]),
        )
        in occupied
    )
    return cells, affected


class GuiSession:
    """Simulator-only debug session. No policy checkpoint or training runtime is loaded."""

    def __init__(
        self,
        database: Path,
        scenario_directory: Path,
        seed: int,
        mcts_config: MctsConfig | None = None,
        saved_setup_directory: Path | None = None,
    ) -> None:
        self.lock = threading.RLock()
        self.database = database.resolve()
        self.catalog = DebugSetupCatalog(self.database, scenario_directory)
        self.saved_setups = SavedSetupStore(saved_setup_directory or scenario_directory / "saved")
        self.seed = seed
        self.mcts_config = mcts_config or MctsConfig()
        self.setup: dict[str, Any] = {}
        self.setup_draft: dict[str, Any] = {}
        self.setup_json = ""
        self.simulator: _native.Simulator
        self.preview_simulator: _native.Simulator
        self.planner: MctsPlanner | None = None
        self.last_ai: dict[str, Any] | None = None
        self.history: list[str] = []
        self.start(self.catalog.public_payload()["presets"]["NORMAL"])

    def save_setup(self, name: Any, request: dict[str, Any]) -> dict[str, Any]:
        """Validate and save a canonical scenario consumable by bd2-train."""
        with self.lock:
            setup = self.catalog.build_setup(request)
            saved = self.saved_setups.save(name, setup)
            return {"saved": saved, "saved_setups": self.saved_setups.list()}

    def load_setup(self, name: Any) -> dict[str, Any]:
        """Load a canonical saved scenario back into the editor and simulator."""
        with self.lock:
            setup = self.saved_setups.load(name)
            # Rebuilding through the editor schema validates every character,
            # costume, build, equipment, mode and content-specific rule again.
            request = self.catalog.editor_payload_from_setup(setup)
            request.update(
                seed=self.seed,
                mcts_simulations=self.mcts_config.simulations,
                mcts_rollout_depth=self.mcts_config.rollout_depth,
                mcts_max_branching=self.mcts_config.max_branching,
            )
            result = self.start(request)
            result["loaded_setup"] = _saved_setup_name(name)
            return result

    def start(self, request: dict[str, Any]) -> dict[str, Any]:
        with self.lock:
            setup = self.catalog.build_setup(request)
            seed = _strict_int(request.get("seed", self.seed), "seed")
            simulations = _strict_int(
                request.get("mcts_simulations", self.mcts_config.simulations),
                "mcts_simulations",
            )
            rollout_depth = _strict_int(
                request.get("mcts_rollout_depth", self.mcts_config.rollout_depth),
                "mcts_rollout_depth",
            )
            max_branching = _strict_int(
                request.get("mcts_max_branching", self.mcts_config.max_branching),
                "mcts_max_branching",
            )
            config = MctsConfig(
                simulations=simulations,
                rollout_depth=rollout_depth,
                max_branching=max_branching,
                exploration=self.mcts_config.exploration,
            )
            config.validate()
            setup_json = json.dumps(setup, ensure_ascii=False, separators=(",", ":"))
            template = getattr(self, "simulator", None)
            simulator = (
                _native.Simulator(str(self.database), setup_json, seed)
                if template is None
                else template.new_battle(setup_json, seed)
            )
            preview_simulator = simulator.new_battle(setup_json, seed)
            planner = (
                None
                if setup["rules"]["mode"] == "GOLDEN_COLOSSEUM"
                else MctsPlanner(
                    self.database,
                    setup_json,
                    seed,
                    config,
                    template=simulator,
                )
            )
            self.seed = seed
            self.mcts_config = config
            self.setup = setup
            self.setup_json = setup_json
            self.setup_draft = self.catalog.editor_payload_from_setup(setup)
            self.simulator = simulator
            self.preview_simulator = preview_simulator
            self.planner = planner
            self.last_ai = None
            self.history = []
            self._advance_enemy()
            return self.payload()

    def reset(self, seed: int | None = None) -> dict[str, Any]:
        with self.lock:
            next_seed = self.seed + 1 if seed is None else _strict_int(seed, "seed")
            simulator = self.simulator.new_battle(self.setup_json, next_seed)
            preview_simulator = simulator.new_battle(self.setup_json, next_seed)
            planner = (
                None
                if self.setup["rules"]["mode"] == "GOLDEN_COLOSSEUM"
                else MctsPlanner(
                    self.database,
                    self.setup_json,
                    next_seed,
                    self.mcts_config,
                    template=simulator,
                )
            )
            self.seed = next_seed
            self.simulator = simulator
            self.preview_simulator = preview_simulator
            self.planner = planner
            self.last_ai = None
            self.history = []
            self._advance_enemy()
            return self.payload()

    def step(
        self,
        actions: list[int],
        order: list[int] | None = None,
        formation: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        with self.lock:
            state = self._state()
            if state["terminal"] is not None:
                raise RuntimeError("the battle has already ended")
            if state["rules"]["mode"] == "GOLDEN_COLOSSEUM":
                raise RuntimeError("Golden Colosseum actions are resolved automatically")
            if state["active_side"] != "PLAYER":
                raise RuntimeError("wait for the AI-controlled enemy turn to finish")
            before = self.simulator.state_json()
            previous_ai = copy.deepcopy(self.last_ai)
            try:
                self._submit_indices(actions, "PLAYER", order, formation)
                self._advance_enemy()
            except Exception:
                self.simulator.restore_json(before)
                self.last_ai = previous_ai
                raise
            self.history.append(before)
            return self.payload()

    def ai_step(self) -> dict[str, Any]:
        with self.lock:
            state = self._state()
            if state["terminal"] is not None:
                return self.payload()
            side = state["active_side"]
            before = self.simulator.state_json()
            previous_ai = copy.deepcopy(self.last_ai)
            try:
                if state["rules"]["mode"] in {"MONSTER_CHASER", "GOLDEN_COLOSSEUM"}:
                    self.simulator.step_auto_json()
                    controller = (
                        "COLOSSEUM_AUTO"
                        if state["rules"]["mode"] == "GOLDEN_COLOSSEUM"
                        else "RULE_BASED"
                    )
                    self.last_ai = {"controller": controller, "side": side}
                else:
                    self._step_mcts(side)
                requested_ai = copy.deepcopy(self.last_ai)
                self._advance_enemy()
                if side == "PLAYER":
                    self.last_ai = requested_ai
            except Exception:
                self.simulator.restore_json(before)
                self.last_ai = previous_ai
                raise
            if side == "PLAYER" or state["rules"]["mode"] == "GOLDEN_COLOSSEUM":
                self.history.append(before)
            return self.payload()

    def rollback(self) -> dict[str, Any]:
        with self.lock:
            if not self.history:
                raise RuntimeError("there is no previous player turn to restore")
            self.simulator.restore_json(self.history.pop())
            self.last_ai = None
            return self.payload()

    def preview(
        self,
        unit_id: int,
        action_index: int,
        order: list[int] | None = None,
        formation: dict[str, Any] | None = None,
        actions: list[int] | None = None,
    ) -> dict[str, Any]:
        """Resolve a command's anchor with the authoritative Rust targeting rules.

        The preview runs on a restored throw-away simulator.  It therefore observes
        focus, taunt, skip, ally/self targeting and the requested formation without
        consuming RNG or mutating the live battle.
        """
        with self.lock:
            live_json = self.simulator.state_json()
            state = json.loads(live_json)
            if state["terminal"] is not None:
                raise RuntimeError("target preview is unavailable after battle completion")
            golden = state["rules"]["mode"] == "GOLDEN_COLOSSEUM"
            active_side = state["active_side"]
            if not golden and active_side != "PLAYER":
                raise RuntimeError("target preview is only available during player preparation")

            side_index = 0 if active_side == "PLAYER" else 1
            current_order = [int(value) for value in state["teams"][side_index]["action_order"]]
            actor_id = _strict_int(unit_id, "preview unit_id")
            if actor_id not in current_order:
                raise ValueError("preview actor is not in the active action order")
            if golden:
                requested_order = [actor_id]
            else:
                requested_order = (
                    current_order if order is None else _strict_int_list(order, "preview order")
                )
                if len(requested_order) != len(current_order) or set(requested_order) != set(
                    current_order
                ):
                    raise ValueError("turn order must contain every active unit exactly once")

            temporary = self.preview_simulator
            temporary.restore_json(live_json)
            legal = json.loads(temporary.legal_actions_json(active_side))
            legal_by_id = {int(entry["unit_id"]): entry["commands"] for entry in legal}
            choices = legal_by_id.get(actor_id)
            if not choices:
                raise ValueError("preview actor has no legal command")
            selected = _strict_int(action_index, "preview action_index")
            if selected < 0 or selected >= len(choices):
                raise ValueError("masked action selected for target preview")
            command = dict(choices[selected])
            metadata = self.catalog.command_metadata(state["units"][str(actor_id)], command)
            if metadata is not None:
                command["ui"] = metadata

            normalized_formation = {} if golden else _normalize_formation(formation)
            positions = {
                int(raw_id): {
                    "row": int(unit["position"]["row"]),
                    "depth": int(unit["position"]["depth"]),
                }
                for raw_id, unit in state["units"].items()
            }
            for raw_id, cell in normalized_formation.items():
                if int(raw_id) in positions:
                    positions[int(raw_id)] = dict(cell)

            planned_indices = (
                _strict_int_list(actions, "preview actions") if actions is not None else None
            )
            if golden:
                planned_indices = None
            if planned_indices is not None and len(planned_indices) != len(requested_order):
                raise ValueError("preview actions must match the requested action order")
            commands: dict[str, dict[str, Any]] = {}
            for slot, current_id in enumerate(requested_order):
                current_choices = legal_by_id.get(current_id) or []
                if not current_choices:
                    continue
                current_index = (
                    selected
                    if current_id == actor_id
                    else planned_indices[slot]
                    if planned_indices is not None
                    else 0
                )
                if current_index < 0 or current_index >= len(current_choices):
                    raise ValueError("masked action selected in preview plan")
                commands[str(current_id)] = current_choices[current_index]
            before_count = len(state["event_log"])
            temporary.step_json(
                json.dumps(
                    {
                        "side": active_side,
                        "order": requested_order,
                        "commands": commands,
                        "formation": normalized_formation,
                    },
                    separators=(",", ":"),
                )
            )
            preview_state = json.loads(temporary.state_json())
            events = preview_state["event_log"][before_count:]
            target_id: int | None = None
            anchor: dict[str, int] | None = None
            actor_action_active = False
            actor_action_finished = False
            damage_by_target: dict[int, dict[str, int]] = {}
            alive_at_actor = {
                int(raw_id) for raw_id, unit in state["units"].items() if unit["alive"]
            }
            units_at_actor = copy.deepcopy(state["units"])
            positions_at_lock: dict[int, dict[str, int]] | None = None
            alive_at_lock: set[int] | None = None
            units_at_lock: dict[str, Any] | None = None
            for event in events:
                kind = event["kind"]
                if kind["type"] == "ACTION_STARTED":
                    event_actor = int(kind["actor_id"])
                    if actor_action_active and event_actor != actor_id:
                        actor_action_active = False
                        actor_action_finished = True
                    elif event_actor == actor_id and not actor_action_finished:
                        actor_action_active = True
                if kind["type"] in {"FORMATION_CHANGED", "UNIT_MOVED"}:
                    positions[int(kind["unit_id"])] = {
                        "row": int(kind["to"]["row"]),
                        "depth": int(kind["to"]["depth"]),
                    }
                elif kind["type"] == "UNIT_DIED":
                    alive_at_actor.discard(int(kind["unit_id"]))
                elif kind["type"] == "UNIT_REVIVED":
                    alive_at_actor.add(int(kind["unit_id"]))
                elif kind["type"] == "UNIT_SUMMONED":
                    summoned_id = int(kind["unit_id"])
                    summoned = preview_state["units"].get(str(summoned_id))
                    if summoned is not None:
                        units_at_actor[str(summoned_id)] = copy.deepcopy(summoned)
                        positions[summoned_id] = {
                            "row": int(kind["position"]["row"]),
                            "depth": int(kind["position"]["depth"]),
                        }
                        alive_at_actor.add(summoned_id)
                if (
                    anchor is None
                    and kind.get("actor_id") == actor_id
                    and kind["type"] == "TARGET_CELL_LOCKED"
                ):
                    anchor = {
                        "row": int(kind["cell"]["row"]),
                        "depth": int(kind["cell"]["depth"]),
                    }
                    positions_at_lock = copy.deepcopy(positions)
                    alive_at_lock = set(alive_at_actor)
                    units_at_lock = copy.deepcopy(units_at_actor)
                elif (
                    anchor is None
                    and kind.get("actor_id") == actor_id
                    and kind["type"] == "TARGET_LOCKED"
                ):
                    target_id = int(kind["target_id"])
                    anchor = copy.deepcopy(positions.get(target_id))
                    positions_at_lock = copy.deepcopy(positions)
                    alive_at_lock = set(alive_at_actor)
                    units_at_lock = copy.deepcopy(units_at_actor)

                if not actor_action_active:
                    continue
                damage_target: int | None = None
                damage = 0
                absorbed = 0
                critical = False
                evaded = False
                collision = 0
                if kind["type"] == "DAMAGE_APPLIED" and int(kind["actor_id"]) == actor_id:
                    damage_target = int(kind["target_id"])
                    damage = int(kind["amount"])
                    critical = bool(kind["critical"])
                elif kind["type"] == "DAMAGE_EVADED" and int(kind["actor_id"]) == actor_id:
                    damage_target = int(kind["target_id"])
                    evaded = True
                elif kind["type"] == "BARRIER_ABSORBED":
                    damage_target = int(kind["target_id"])
                    absorbed = int(kind["amount"])
                elif kind["type"] == "COLLISION_DAMAGE":
                    damage_target = int(kind["occupant_id"])
                    collision = int(kind["amount"])
                if damage_target is None:
                    continue
                forecast = damage_by_target.setdefault(
                    damage_target,
                    {
                        "target_id": damage_target,
                        "amount": 0,
                        "hits": 0,
                        "critical_hits": 0,
                        "evaded_hits": 0,
                        "absorbed": 0,
                        "collision_damage": 0,
                    },
                )
                forecast["amount"] += damage
                forecast["absorbed"] += absorbed
                forecast["collision_damage"] += collision
                if damage or kind["type"] == "DAMAGE_APPLIED":
                    forecast["hits"] += 1
                if critical:
                    forecast["critical_hits"] += 1
                if evaded:
                    forecast["evaded_hits"] += 1

            footprint_positions = positions_at_lock or positions
            footprint_alive = alive_at_lock or alive_at_actor
            footprint_units = units_at_lock or units_at_actor
            target_side = None
            if target_id is not None:
                target_side = footprint_units[str(target_id)]["side"]
            elif anchor is not None:
                actor_side = state["units"][str(actor_id)]["side"]
                target_side = "ENEMY" if actor_side == "PLAYER" else "PLAYER"
            footprint_state = {
                **state,
                "units": {
                    raw_id: {**unit, "alive": int(raw_id) in footprint_alive}
                    for raw_id, unit in footprint_units.items()
                },
            }
            affected_cells, affected_unit_ids = _preview_footprint(
                footprint_state,
                actor_id,
                command,
                target_side,
                anchor,
                footprint_positions,
            )
            damage_forecast = [damage_by_target[unit_id] for unit_id in sorted(damage_by_target)]
            return {
                "actor_id": actor_id,
                "action_index": selected,
                "command": command,
                "target_id": target_id,
                "target_side": target_side,
                "anchor": anchor,
                "affected_cells": affected_cells,
                "affected_unit_ids": affected_unit_ids,
                "damage_by_target": damage_forecast,
                "total_damage": sum(item["amount"] for item in damage_forecast),
            }

    def _submit_indices(
        self,
        actions: list[int],
        side: str,
        requested_order: list[int] | None = None,
        requested_formation: dict[str, Any] | None = None,
    ) -> None:
        legal = json.loads(self.simulator.legal_actions_json(side))
        state = self._state()
        side_index = 0 if side == "PLAYER" else 1
        current_order = state["teams"][side_index]["action_order"]
        order = (
            current_order
            if requested_order is None
            else _strict_int_list(requested_order, "turn order")
        )
        if len(order) != len(current_order) or set(order) != set(current_order):
            raise ValueError("turn order must contain every active unit exactly once")
        legal_by_id = {entry["unit_id"]: entry["commands"] for entry in legal}
        action_indices = _strict_int_list(actions, "actions")
        if len(action_indices) != len(order):
            raise ValueError("actions must contain one selection for every active unit")
        commands: dict[str, dict[str, Any]] = {}
        for slot, unit_id in enumerate(order):
            choices = legal_by_id.get(unit_id) or []
            if not choices:
                continue
            selected = action_indices[slot]
            if selected < 0 or selected >= len(choices):
                raise ValueError(f"masked action selected: slot={slot}, action={selected}")
            commands[str(unit_id)] = choices[selected]
        formation = _normalize_formation(requested_formation)
        plan = {"side": side, "order": order, "commands": commands, "formation": formation}
        self.simulator.step_json(json.dumps(plan, separators=(",", ":")))

    def _advance_enemy(self) -> None:
        for _ in range(16):
            state = self._state()
            if state["rules"]["mode"] == "GOLDEN_COLOSSEUM":
                return
            if state["terminal"] is not None or state["active_side"] != "ENEMY":
                return
            if state["rules"]["mode"] == "MONSTER_CHASER":
                self.simulator.step_auto_json()
                self.last_ai = {"controller": "RULE_BASED", "side": "ENEMY"}
            else:
                self._step_mcts("ENEMY")
        raise RuntimeError("AI auto-play exceeded the safety limit")

    def _step_mcts(self, side: str) -> None:
        if self.planner is None:
            raise RuntimeError("MCTS planner has not been initialized")
        result: MctsResult = self.planner.choose(self.simulator, side)
        self.simulator.step_json(json.dumps(result.plan, separators=(",", ":")))
        self.last_ai = {
            "controller": "MCTS",
            "side": side,
            "simulations": result.simulations,
            "root_value": result.root_value,
            "candidates": result.candidates,
        }

    def _state(self) -> dict[str, Any]:
        return json.loads(self.simulator.state_json())

    def payload(self) -> dict[str, Any]:
        state = self._state()
        legal = (
            json.loads(self.simulator.legal_actions_json(state["active_side"]))
            if state["terminal"] is None
            else []
        )
        for entry in legal:
            unit = state["units"].get(str(entry["unit_id"]))
            if unit is None:
                raise RuntimeError(f"legal actions reference missing unit {entry['unit_id']}")
            for command in entry["commands"]:
                metadata = self.catalog.command_metadata(unit, command)
                if metadata is not None:
                    command["ui"] = metadata
            legal_variants = {
                (str(command["costume_id"]), int(command["burst_level"]))
                for command in entry["commands"]
                if command["type"] == "USE_COSTUME"
            }
            side_index = 0 if unit["side"] == "PLAYER" else 1
            current_sp = int(state["teams"][side_index]["sp"])
            unavailable: list[dict[str, Any]] = []
            for loadout in unit["costume_loadout"]:
                costume_id = str(loadout["costume_id"])
                for burst_level in range(int(loadout["burst_level"]) + 1):
                    if (costume_id, burst_level) in legal_variants:
                        continue
                    command = {
                        "type": "USE_COSTUME",
                        "costume_id": costume_id,
                        "burst_level": burst_level,
                        "explicit_target": None,
                    }
                    metadata = self.catalog.command_metadata(unit, command)
                    if metadata is None:
                        continue
                    if costume_id not in unit["cooldowns"]:
                        raise RuntimeError(
                            f"unit {unit['id']} has no cooldown state for {costume_id}"
                        )
                    cooldown = int(unit["cooldowns"][costume_id])
                    reason = (
                        "COOLDOWN"
                        if cooldown > 0
                        else "INSUFFICIENT_SP"
                        if current_sp < int(metadata["sp_cost"])
                        else "MASKED"
                    )
                    command.update(
                        ui=metadata,
                        unavailable_reason=reason,
                        cooldown_remaining=cooldown,
                    )
                    unavailable.append(command)
            entry["unavailable_commands"] = unavailable
        controller = {
            "MONSTER_CHASER": "RULE_BASED",
            "GOLDEN_COLOSSEUM": "COLOSSEUM_AUTO",
        }.get(state["rules"]["mode"], "MCTS")
        auto_plan = (
            json.loads(self.simulator.auto_plan_json(state["active_side"]))
            if state["terminal"] is None and state["rules"]["mode"] == "GOLDEN_COLOSSEUM"
            else None
        )
        return {
            "state": state,
            "legal": legal,
            "seed": self.seed,
            "ruleset_id": self.catalog.ruleset_id,
            "enemy_controller": controller,
            "mcts": {
                "simulations": self.mcts_config.simulations,
                "rollout_depth": self.mcts_config.rollout_depth,
                "max_branching": self.mcts_config.max_branching,
            },
            "last_ai": self.last_ai,
            "auto_plan": auto_plan,
            "setup": copy.deepcopy(self.setup_draft),
            "saved_setups": self.saved_setups.list(),
            "can_rollback": bool(self.history),
        }


def handler_factory(session: GuiSession, ui_root: Path) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        server_version = "BD2SimulatorGUI/0.2"

        def do_GET(self) -> None:
            if self.path == "/api/state":
                with session.lock:
                    self._json(session.payload())
                return
            if self.path == "/api/catalog":
                self._json(session.catalog.public_payload())
                return
            relative = "index.html" if self.path in {"/", ""} else self.path.lstrip("/")
            path = (ui_root / relative).resolve()
            if ui_root.resolve() not in path.parents and path != ui_root.resolve():
                self.send_error(HTTPStatus.FORBIDDEN)
                return
            if not path.is_file():
                self.send_error(HTTPStatus.NOT_FOUND)
                return
            content_type = {
                ".html": "text/html; charset=utf-8",
                ".css": "text/css; charset=utf-8",
                ".js": "text/javascript; charset=utf-8",
                ".mjs": "text/javascript; charset=utf-8",
                ".png": "image/png",
            }.get(path.suffix, "application/octet-stream")
            body = path.read_bytes()
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self._write_body(body)

        def do_POST(self) -> None:
            try:
                body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
                payload = json.loads(body or b"{}")
                if not isinstance(payload, dict):
                    raise ValueError("request body must be a JSON object")
                if self.path == "/api/start":
                    self._json(session.start(payload))
                elif self.path == "/api/reset":
                    self._json(session.reset(payload.get("seed")))
                elif self.path == "/api/step":
                    self._json(
                        session.step(
                            payload["actions"], payload.get("order"), payload.get("formation")
                        )
                    )
                elif self.path == "/api/ai-step":
                    self._json(session.ai_step())
                elif self.path == "/api/rollback":
                    self._json(session.rollback())
                elif self.path == "/api/preview":
                    self._json(
                        session.preview(
                            payload["unit_id"],
                            payload["action_index"],
                            payload.get("order"),
                            payload.get("formation"),
                            payload.get("actions"),
                        )
                    )
                elif self.path == "/api/save-setup":
                    self._json(session.save_setup(payload["name"], payload["setup"]))
                elif self.path == "/api/load-setup":
                    self._json(session.load_setup(payload["name"]))
                else:
                    self.send_error(HTTPStatus.NOT_FOUND)
            except (KeyError, TypeError, ValueError, RuntimeError) as error:
                self._json({"error": str(error)}, HTTPStatus.BAD_REQUEST)

        def log_message(self, format: str, *args: object) -> None:
            return

        def _json(self, payload: dict[str, Any], status: HTTPStatus = HTTPStatus.OK) -> None:
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            try:
                self.send_response(status)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self._write_body(body)
            except (BrokenPipeError, ConnectionAbortedError, ConnectionResetError):
                # The peer can disconnect while response headers are being sent.
                return

        def _write_body(self, body: bytes) -> None:
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionAbortedError, ConnectionResetError):
                # Navigation and rapid selection changes legitimately supersede
                # in-flight static assets and target previews.
                return

    return Handler


def main() -> None:
    repository_root = Path(__file__).resolve().parents[2]
    parser = argparse.ArgumentParser(description="Run the BrownDust2 simulator debug player")
    parser.add_argument(
        "--database", type=Path, default=repository_root / "data/generated/bd2.sqlite"
    )
    parser.add_argument(
        "--scenario-directory", type=Path, default=repository_root / "data/scenarios"
    )
    parser.add_argument(
        "--saved-setup-directory",
        type=Path,
        default=repository_root / "data/scenarios/saved",
        help="directory for GUI-authored canonical BattleSetup JSON files",
    )
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--mcts-simulations", type=int, default=48)
    parser.add_argument("--mcts-rollout-depth", type=int, default=8)
    parser.add_argument("--mcts-max-branching", type=int, default=24)
    parser.add_argument("--no-open", action="store_true")
    args = parser.parse_args()
    config = MctsConfig(
        simulations=args.mcts_simulations,
        rollout_depth=args.mcts_rollout_depth,
        max_branching=args.mcts_max_branching,
    )
    session = GuiSession(
        args.database,
        args.scenario_directory,
        args.seed,
        config,
        args.saved_setup_directory,
    )
    server = ThreadingHTTPServer(
        (args.host, args.port), handler_factory(session, repository_root / "ui")
    )
    url = f"http://{args.host}:{args.port}/"
    print(f"BrownDust2 simulator debug player: {url}")
    if not args.no_open:
        threading.Timer(0.3, lambda: webbrowser.open(url)).start()
    server.serve_forever()


if __name__ == "__main__":
    main()
