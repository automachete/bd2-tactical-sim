from __future__ import annotations

from pathlib import Path

import torch
from torch import Tensor, nn

from .env import (
    ACTION_FEATURES,
    BLESSING_FEATURES,
    COSTUME_FEATURES,
    EFFECT_FEATURES,
    GLOBAL_FEATURES,
    GOLDEN_FEATURES,
    GRID_FEATURES,
    MAX_GRID_SIZE,
    MAX_TEAM_UNITS,
    MONSTER_FEATURES,
    MONSTER_LEVEL_FEATURES,
    UNIT_FEATURES,
)

OBSERVATION_SCHEMA_ID = "bd2rl-observation-v4-complete-runtime"
MODEL_ARCHITECTURE_ID = "semantic-action-transformer-v3"


def _masked_mean(values: Tensor, mask: Tensor, dimension: int) -> Tensor:
    weights = mask.unsqueeze(-1).to(values.dtype)
    return (values * weights).sum(dim=dimension) / weights.sum(dim=dimension).clamp_min(1.0)


class MaskedActorCritic(nn.Module):
    """Semantic action scorer over the complete observable battle state."""

    def __init__(self, hidden_size: int = 256, layers: int = 4, heads: int = 8) -> None:
        super().__init__()
        self.unit_encoder = self._encoder(UNIT_FEATURES, hidden_size)
        self.costume_encoder = self._encoder(COSTUME_FEATURES, hidden_size)
        self.effect_encoder = self._encoder(EFFECT_FEATURES, hidden_size)
        self.action_encoder = self._encoder(ACTION_FEATURES, hidden_size)
        self.monster_level_encoder = self._encoder(MONSTER_LEVEL_FEATURES, hidden_size)
        self.blessing_encoder = self._encoder(BLESSING_FEATURES, hidden_size)
        self.global_encoder = self._encoder(
            GLOBAL_FEATURES + MONSTER_FEATURES + GOLDEN_FEATURES,
            hidden_size,
        )
        self.grid_encoder = self._encoder(
            MAX_GRID_SIZE * MAX_GRID_SIZE * GRID_FEATURES,
            hidden_size,
        )
        self.unit_fusion = nn.Sequential(
            nn.Linear(hidden_size * 2, hidden_size),
            nn.LayerNorm(hidden_size),
            nn.GELU(),
        )
        encoder_layer = nn.TransformerEncoderLayer(
            d_model=hidden_size,
            nhead=heads,
            dim_feedforward=hidden_size * 4,
            dropout=0.0,
            activation="gelu",
            batch_first=True,
            norm_first=True,
        )
        self.transformer = nn.TransformerEncoder(
            encoder_layer,
            num_layers=layers,
            enable_nested_tensor=False,
        )
        self.slot_embeddings = nn.Parameter(torch.empty(MAX_TEAM_UNITS, hidden_size))
        self.order_embeddings = nn.Parameter(torch.empty(2, MAX_TEAM_UNITS, hidden_size))
        self.context_fusion = nn.Sequential(
            nn.Linear(hidden_size * 7, hidden_size * 2),
            nn.GELU(),
            nn.Linear(hidden_size * 2, hidden_size),
        )
        self.actor = nn.Sequential(
            nn.Linear(hidden_size * 3, hidden_size),
            nn.GELU(),
            nn.Linear(hidden_size, 1),
        )
        self.critic = nn.Sequential(
            nn.Linear(hidden_size * 2, hidden_size),
            nn.GELU(),
            nn.Linear(hidden_size, 1),
        )
        nn.init.normal_(self.slot_embeddings, std=0.02)
        nn.init.normal_(self.order_embeddings, std=0.02)

    @staticmethod
    def _encoder(features: int, hidden_size: int) -> nn.Sequential:
        return nn.Sequential(
            nn.Linear(features, hidden_size),
            nn.LayerNorm(hidden_size),
            nn.GELU(),
        )

    def forward(self, observation: dict[str, Tensor]) -> tuple[Tensor, Tensor]:
        costumes = self.costume_encoder(observation["costumes"].float())
        costume_summary = _masked_mean(costumes, observation["costume_mask"].bool(), 2)
        encoded = self.unit_fusion(
            torch.cat((self.unit_encoder(observation["units"].float()), costume_summary), dim=-1)
        )
        unit_mask = observation["unit_mask"].bool()
        encoded = self.transformer(encoded, src_key_padding_mask=~unit_mask)
        unit_summary = _masked_mean(encoded, unit_mask, 1)

        effects = self.effect_encoder(observation["effects"].float())
        effect_summary = _masked_mean(effects, observation["effect_mask"].bool(), 1)
        monster_levels = self.monster_level_encoder(observation["monster_levels"].float())
        monster_summary = _masked_mean(
            monster_levels,
            observation["monster_level_mask"].bool(),
            1,
        )
        blessing_values = observation["blessings"].float().flatten(1, 2)
        blessing_mask = observation["blessing_mask"].bool().flatten(1, 2)
        blessing_summary = _masked_mean(
            self.blessing_encoder(blessing_values),
            blessing_mask,
            1,
        )
        global_summary = self.global_encoder(
            torch.cat(
                (
                    observation["global"].float(),
                    observation["monster"].float(),
                    observation["golden"].float(),
                ),
                dim=-1,
            )
        )
        grid_summary = self.grid_encoder(observation["grid"].float().flatten(1))

        padding = torch.zeros(
            (*encoded.shape[:-2], 1, encoded.shape[-1]),
            dtype=encoded.dtype,
            device=encoded.device,
        )
        addressable = torch.cat((encoded, padding), dim=1)
        team_indices = observation["team_order_indices"].long()
        team_tokens = torch.gather(
            addressable[:, None, :, :].expand(-1, 2, -1, -1),
            2,
            team_indices.unsqueeze(-1).expand(-1, -1, -1, encoded.shape[-1]),
        )
        team_tokens = team_tokens + self.order_embeddings
        order_summary = _masked_mean(
            team_tokens.flatten(1, 2),
            observation["team_order_mask"].bool().flatten(1, 2),
            1,
        )
        auxiliary = self.context_fusion(
            torch.cat(
                (
                    global_summary,
                    effect_summary,
                    monster_summary,
                    blessing_summary,
                    grid_summary,
                    order_summary,
                    unit_summary,
                ),
                dim=-1,
            )
        )

        actor_indices = observation["actor_indices"].long()
        actor_tokens = torch.gather(
            addressable,
            1,
            actor_indices.unsqueeze(-1).expand(-1, -1, encoded.shape[-1]),
        )
        actor_tokens = actor_tokens + self.slot_embeddings
        action_tokens = self.action_encoder(observation["action_features"].float())
        slot_context = auxiliary[:, None, None, :].expand(
            -1,
            MAX_TEAM_UNITS,
            action_tokens.shape[2],
            -1,
        )
        actor_context = actor_tokens[:, :, None, :].expand_as(slot_context)
        logits = self.actor(
            torch.cat((actor_context, slot_context, action_tokens), dim=-1)
        ).squeeze(-1)
        logits = logits.masked_fill(
            ~observation["action_mask"].bool(),
            torch.finfo(logits.dtype).min,
        )
        value = self.critic(torch.cat((unit_summary, auxiliary), dim=-1)).squeeze(-1)
        return logits, value


def _sequential_actions(
    logits: Tensor,
    observation: dict[str, Tensor],
    selected_actions: Tensor | None,
    *,
    greedy: bool = False,
) -> tuple[Tensor, Tensor, Tensor]:
    """Sample/evaluate a complete plan while reserving shared SP in order."""
    action_features = observation["action_features"].float()
    base_mask = observation["action_mask"].bool()
    # Global indexes 10 and 12 are own-SP/SP-cap and SP-cap/20. Action index 9
    # is adjusted cost/20; action index 12 marks consume-all-remaining-SP.
    remaining = observation["global"][:, 10].float() * observation["global"][:, 12].float()
    bypass = observation["global"][:, 18].bool()
    actions: list[Tensor] = []
    log_probability = torch.zeros(logits.shape[0], device=logits.device)
    entropy = torch.zeros_like(log_probability)
    for slot in range(MAX_TEAM_UNITS):
        costs = action_features[:, slot, :, 9]
        affordable = bypass[:, None] | (costs <= remaining[:, None] + 1e-6)
        mask = base_mask[:, slot] & affordable
        torch._assert(mask.any(dim=-1).all(), f"no affordable action in slot {slot}")
        masked_logits = logits[:, slot].masked_fill(~mask, torch.finfo(logits.dtype).min)
        distribution = torch.distributions.Categorical(logits=masked_logits)
        action = (
            masked_logits.argmax(dim=-1)
            if greedy
            else distribution.sample()
            if selected_actions is None
            else selected_actions[:, slot]
        )
        torch._assert(
            torch.gather(mask, 1, action[:, None]).all(),
            f"stored action violates the sequential SP mask in slot {slot}",
        )
        actions.append(action)
        log_probability = log_probability + distribution.log_prob(action)
        entropy = entropy + distribution.entropy()
        selected_cost = torch.gather(costs, 1, action[:, None]).squeeze(1)
        consume_remaining = torch.gather(
            action_features[:, slot, :, 12].bool(),
            1,
            action[:, None],
        ).squeeze(1)
        remaining = torch.where(
            bypass,
            remaining,
            torch.where(consume_remaining, torch.zeros_like(remaining), remaining - selected_cost),
        )
    return torch.stack(actions, dim=1), log_probability, entropy


def sample_actions(logits: Tensor, observation: dict[str, Tensor]) -> tuple[Tensor, Tensor, Tensor]:
    return _sequential_actions(logits, observation, None)


def greedy_actions(logits: Tensor, observation: dict[str, Tensor]) -> Tensor:
    return _sequential_actions(logits, observation, None, greedy=True)[0]


def evaluate_actions(
    logits: Tensor,
    actions: Tensor,
    observation: dict[str, Tensor],
) -> tuple[Tensor, Tensor]:
    _, log_probability, entropy = _sequential_actions(logits, observation, actions)
    return log_probability, entropy


def load_policy_checkpoint(checkpoint: Path, device: torch.device) -> MaskedActorCritic:
    payload = torch.load(checkpoint, map_location=device, weights_only=True)
    if payload.get("observation_schema") != OBSERVATION_SCHEMA_ID:
        raise ValueError(
            f"checkpoint observation schema is not {OBSERVATION_SCHEMA_ID}: {checkpoint}"
        )
    if payload.get("model_architecture") != MODEL_ARCHITECTURE_ID:
        raise ValueError(
            f"checkpoint model architecture is not {MODEL_ARCHITECTURE_ID}: {checkpoint}"
        )
    model = MaskedActorCritic().to(device)
    model.load_state_dict(payload["model"])
    model.eval()
    return model
