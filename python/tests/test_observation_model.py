from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest
import torch
from bd2rl import _native
from bd2rl.env import MAX_TEAM_UNITS, OBSERVATION_KEYS, Bd2Env, EnvConfig
from bd2rl.model import MaskedActorCritic, evaluate_actions, greedy_actions, sample_actions

ROOT = Path(__file__).resolve().parents[2]
DATABASE = ROOT / "data/generated/bd2.sqlite"
SCENARIOS = {
    "NORMAL": ROOT / "data/scenarios/normal-demo.json",
    "MIRROR_WAR": ROOT / "data/scenarios/mirror-war-demo.json",
    "MONSTER_CHASER": ROOT / "data/scenarios/monster-chaser-current.json",
    "GOLDEN_COLOSSEUM": ROOT / "data/scenarios/golden-colosseum-reference.json",
}


def tensor_batch(observation: dict[str, np.ndarray]) -> dict[str, torch.Tensor]:
    return {key: torch.as_tensor(value[None]) for key, value in observation.items()}


@pytest.mark.parametrize("mode", list(SCENARIOS))
def test_every_content_observation_is_complete_and_model_consumable(mode: str) -> None:
    environment = Bd2Env(EnvConfig(DATABASE, SCENARIOS[mode], seed=113))
    observation, _ = environment.reset()
    assert set(observation) == set(OBSERVATION_KEYS)
    assert environment.observation_space.contains(observation)

    tensors = tensor_batch(observation)
    model = MaskedActorCritic(hidden_size=32, layers=1, heads=4)
    logits, value = model(tensors)
    assert logits.shape == (1, 11, int(_native.MAX_ACTIONS_PER_UNIT))
    assert value.shape == (1,)
    assert torch.isfinite(logits[tensors["action_mask"].bool()]).all()

    actions = greedy_actions(logits, tensors)
    _, log_probability, entropy = sample_actions(logits, tensors)
    evaluated, evaluated_entropy = evaluate_actions(logits, actions, tensors)
    assert actions.shape == (1, MAX_TEAM_UNITS)
    assert (
        log_probability.shape == entropy.shape == evaluated.shape == evaluated_entropy.shape == (1,)
    )
    environment.step(actions[0].numpy())


def test_semantic_model_receives_gradients_from_each_runtime_branch() -> None:
    model = MaskedActorCritic(hidden_size=32, layers=1, heads=4)
    loss = torch.zeros(())
    for mode in ("MONSTER_CHASER", "GOLDEN_COLOSSEUM"):
        environment = Bd2Env(EnvConfig(DATABASE, SCENARIOS[mode], seed=127))
        observation, _ = environment.reset()
        logits, value = model(tensor_batch(observation))
        loss = loss + logits[0, 0, 0] + value.sum()
    loss.backward()

    observed_encoders = (
        "unit_encoder",
        "costume_encoder",
        "effect_encoder",
        "action_encoder",
        "monster_level_encoder",
        "blessing_encoder",
        "global_encoder",
        "grid_encoder",
    )
    parameters = dict(model.named_parameters())
    for prefix in observed_encoders:
        gradients = [
            parameter.grad
            for name, parameter in parameters.items()
            if name.startswith(prefix) and parameter.grad is not None
        ]
        assert gradients, prefix
        assert any(torch.count_nonzero(gradient).item() for gradient in gradients), prefix


@pytest.mark.parametrize("mode", list(SCENARIOS))
def test_every_unmasked_action_has_complete_semantic_type_and_target_metadata(mode: str) -> None:
    observation, _ = Bd2Env(EnvConfig(DATABASE, SCENARIOS[mode], seed=129)).reset()
    for slot in range(MAX_TEAM_UNITS):
        for action in np.flatnonzero(observation["action_mask"][slot]):
            features = observation["action_features"][slot, action]
            if features[49] == 1:
                assert features[:3].sum() == 0
                continue
            assert features[:3].sum() == 1
            assert features[16:22].sum() == 1
            if features[1] == 1:
                assert features[38:46].sum() == 1


def test_sequential_policy_mask_never_reserves_more_shared_sp_than_available() -> None:
    environment = Bd2Env(EnvConfig(DATABASE, SCENARIOS["MONSTER_CHASER"], seed=131))
    observation, _ = environment.reset()
    tensors = tensor_batch(observation)
    logits = tensors["action_features"][..., 9] * 1_000.0
    actions = greedy_actions(logits, tensors)[0]

    remaining = float(observation["global"][10] * observation["global"][12])
    bypass = bool(observation["global"][18])
    for slot, action in enumerate(actions.tolist()):
        cost = float(observation["action_features"][slot, action, 9])
        assert bypass or cost <= remaining + 1e-6
        if not bypass:
            remaining = (
                0.0 if observation["action_features"][slot, action, 12] else remaining - cost
            )
    environment.step(actions.numpy())


def test_observation_changes_for_each_mutable_state_partition_but_hides_rng() -> None:
    simulator = _native.Simulator(
        str(DATABASE),
        SCENARIOS["MONSTER_CHASER"].read_text(encoding="utf-8"),
        137,
    )
    initial_state = json.loads(simulator.state_json())
    baseline = json.loads(simulator.training_frame_json("PLAYER"))

    def changed(mutator: object, expected_keys: set[str]) -> None:
        state = json.loads(json.dumps(initial_state))
        mutator(state)  # type: ignore[operator]
        simulator.restore_json(json.dumps(state))
        frame = json.loads(simulator.training_frame_json("PLAYER"))
        actual = {
            key
            for key in OBSERVATION_KEYS
            if not np.array_equal(np.asarray(frame[key]), np.asarray(baseline[key]))
        }
        assert expected_keys <= actual

    player_id = str(initial_state["teams"][0]["action_order"][0])
    costume_id = initial_state["units"][player_id]["costume_loadout"][0]["costume_id"]
    changed(lambda state: state["units"][player_id].update(hp=1), {"units"})
    changed(
        lambda state: state["units"][player_id]["cooldowns"].update({costume_id: 1}),
        {"costumes", "action_mask"},
    )
    changed(lambda state: state["teams"][0].update(sp=1), {"global", "action_mask"})
    changed(lambda state: state.update(action_sequence=99), {"global"})

    def damage_monster(state: dict[str, object]) -> None:
        progress = state["monster_chaser"]
        assert isinstance(progress, dict)
        progress["battle_hp_remaining"] -= 1
        progress["segment_hp_remaining"] -= 1
        progress["cumulative_damage"] += 1
        units = state["units"]
        assert isinstance(units, dict)
        for unit in units.values():
            if unit["side"] == "ENEMY":
                unit["hp"] -= 1

    changed(
        damage_monster,
        {"monster", "monster_levels"},
    )

    hidden = json.loads(json.dumps(initial_state))
    hidden["rng"]["draws"] += 10
    hidden["rng"]["state"] += 10
    simulator.restore_json(json.dumps(hidden))
    hidden_frame = json.loads(simulator.training_frame_json("PLAYER"))
    for key in OBSERVATION_KEYS:
        np.testing.assert_array_equal(hidden_frame[key], baseline[key])


def test_dead_order_slot_is_observable_but_omitted_from_submitted_plan() -> None:
    environment = Bd2Env(EnvConfig(DATABASE, SCENARIOS["NORMAL"], seed=139))
    environment.reset()
    state = json.loads(environment.snapshot_json())
    unit_id = state["teams"][0]["action_order"][0]
    state["units"][str(unit_id)]["alive"] = False
    state["units"][str(unit_id)]["hp"] = 0

    observation = environment.restore_json(json.dumps(state))
    assert observation["team_order_mask"][0, 0] == 1
    assert observation["action_mask"][0, 0] == 1
    assert observation["action_mask"][0, 1:].sum() == 0

    tensors = tensor_batch(observation)
    logits, _ = MaskedActorCritic(hidden_size=32, layers=1, heads=4)(tensors)
    actions = greedy_actions(logits, tensors)[0].numpy()
    environment.step(actions)
