from __future__ import annotations

import copy
import json
import os
from pathlib import Path
from typing import Any

from .debug_setup import DebugSetupCatalog

PROFILE_SCHEMA_VERSION = 1


class CharacterProfileStore:
    """Strict, durable player-character progression profiles.

    Profiles are independent of formations and battle modes. The on-disk document
    always contains the complete current five-star catalog; partial and legacy
    documents are rejected instead of being guessed or migrated.
    """

    def __init__(self, path: Path | None, catalog: DebugSetupCatalog) -> None:
        self.path = path.resolve() if path is not None else None
        self.catalog = catalog
        self._defaults = {
            character_id: catalog.default_character_profile(character_id)
            for character_id in catalog.characters
        }
        self._profiles = copy.deepcopy(self._defaults)
        if self.path is not None and self.path.is_file():
            self._profiles = self._read()

    def payload(self) -> dict[str, Any]:
        return {
            "schema_version": PROFILE_SCHEMA_VERSION,
            "profiles": [
                {
                    **copy.deepcopy(self._profiles[character_id]),
                    "is_default": self._profiles[character_id] == self._defaults[character_id],
                }
                for character_id in self.catalog.characters
            ],
        }

    def get(self, character_id: str) -> dict[str, Any]:
        if character_id not in self._profiles:
            raise ValueError(f"unknown character profile: {character_id}")
        return copy.deepcopy(self._profiles[character_id])

    def save(self, value: Any) -> dict[str, Any]:
        normalized = self.catalog.normalize_character_profile(value)
        profiles = copy.deepcopy(self._profiles)
        profiles[normalized["character_id"]] = normalized
        self._write(profiles)
        self._profiles = profiles
        return self._public_profile(normalized["character_id"])

    def reset(self, character_id: Any) -> dict[str, Any]:
        if not isinstance(character_id, str) or character_id not in self._defaults:
            raise ValueError(f"unknown character profile: {character_id}")
        profiles = copy.deepcopy(self._profiles)
        profiles[character_id] = copy.deepcopy(self._defaults[character_id])
        self._write(profiles)
        self._profiles = profiles
        return self._public_profile(character_id)

    def apply_to_request(self, request: dict[str, Any]) -> dict[str, Any]:
        """Materialize current profiles onto PLAYER units only.

        Costume inclusion and costume-link selection remain formation choices.
        Enemy definitions remain scenario-owned so an opponent can use a build
        different from the player's character collection.
        """

        result = copy.deepcopy(request)
        units = result.get("player_units")
        if not isinstance(units, list):
            raise ValueError("player_units must be a list")
        for index, unit in enumerate(units):
            if not isinstance(unit, dict):
                raise ValueError(f"player_units[{index}] must be an object")
            character_id = unit.get("character_id")
            if not isinstance(character_id, str) or character_id not in self._profiles:
                raise ValueError(f"unknown player character profile: {character_id}")
            profile = self._profiles[character_id]
            configured = {costume["costume_id"]: costume for costume in profile["costumes"]}
            costumes = unit.get("costumes")
            if not isinstance(costumes, list):
                raise ValueError(f"player_units[{index}].costumes must be a list")
            for costume_index, costume in enumerate(costumes):
                if not isinstance(costume, dict):
                    raise ValueError(
                        f"player_units[{index}].costumes[{costume_index}] must be an object"
                    )
                costume_id = costume.get("costume_id")
                fixed = configured.get(costume_id)
                if fixed is None:
                    raise ValueError(
                        f"profile {character_id} does not contain costume {costume_id}"
                    )
                costume.update(
                    enhancement=fixed["enhancement"],
                    burst_level=fixed["burst_level"],
                    potential_mask=fixed["potential_mask"],
                    permanent_potential_enabled=True,
                )
            unit["equipment"] = copy.deepcopy(profile["equipment"])
            settings = unit.get("build_settings")
            if not isinstance(settings, dict):
                raise ValueError(f"player_units[{index}].build_settings must be an object")
            settings["awakening_enabled"] = profile["awakening_enabled"]
        return result

    def _public_profile(self, character_id: str) -> dict[str, Any]:
        return {
            **copy.deepcopy(self._profiles[character_id]),
            "is_default": self._profiles[character_id] == self._defaults[character_id],
        }

    def _read(self) -> dict[str, dict[str, Any]]:
        if self.path is None:
            raise RuntimeError("in-memory character profile store cannot be read from disk")
        document = json.loads(self.path.read_text(encoding="utf-8"))
        if not isinstance(document, dict) or set(document) != {"schema_version", "profiles"}:
            raise ValueError(
                "character profile document must contain only schema_version and profiles"
            )
        if document["schema_version"] != PROFILE_SCHEMA_VERSION:
            raise ValueError(f"unsupported character profile schema: {document['schema_version']}")
        raw_profiles = document["profiles"]
        if not isinstance(raw_profiles, list):
            raise ValueError("character profile document profiles must be an array")
        normalized: dict[str, dict[str, Any]] = {}
        for raw_profile in raw_profiles:
            profile = self.catalog.normalize_character_profile(raw_profile)
            character_id = profile["character_id"]
            if character_id in normalized:
                raise ValueError(f"duplicate character profile: {character_id}")
            normalized[character_id] = profile
        expected = set(self.catalog.characters)
        actual = set(normalized)
        if actual != expected:
            missing = sorted(expected - actual)
            unknown = sorted(actual - expected)
            raise ValueError(
                f"character profile document must exactly match the current catalog; "
                f"missing={missing}, unknown={unknown}"
            )
        return {character_id: normalized[character_id] for character_id in self.catalog.characters}

    def _write(self, profiles: dict[str, dict[str, Any]]) -> None:
        if self.path is None:
            return
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_suffix(self.path.suffix + ".tmp")
        document = {
            "schema_version": PROFILE_SCHEMA_VERSION,
            "profiles": [
                copy.deepcopy(profiles[character_id]) for character_id in self.catalog.characters
            ],
        }
        body = json.dumps(document, ensure_ascii=False, indent=2) + "\n"
        temporary.write_text(body, encoding="utf-8", newline="\n")
        os.replace(temporary, self.path)
