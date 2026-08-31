from __future__ import annotations

from pathlib import Path

import torch
from torch import Tensor, nn

from .env import (
    GLOBAL_FEATURES,
    MAX_ACTIONS_PER_UNIT,
    MAX_TEAM_UNITS,
    UNIT_FEATURES,
)

OBSERVATION_SCHEMA_ID = "bd2rl-observation-v2"
MODEL_ARCHITECTURE_ID = "masked-transformer-actor-critic-v2"


class MaskedActorCritic(nn.Module):
    """Board-token transformer with masked per-unit categorical heads."""

    def __init__(self, hidden_size: int = 256, layers: int = 4, heads: int = 8) -> None:
        super().__init__()
        self.unit_encoder = nn.Sequential(
            nn.Linear(UNIT_FEATURES, hidden_size),
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
        self.global_encoder = nn.Sequential(
            nn.Linear(GLOBAL_FEATURES, hidden_size),
            nn.GELU(),
            nn.Linear(hidden_size, hidden_size),
        )
        self.slot_embeddings = nn.Parameter(torch.empty(MAX_TEAM_UNITS, hidden_size))
        self.actor = nn.Sequential(
            nn.Linear(hidden_size * 3, hidden_size),
            nn.GELU(),
            nn.Linear(hidden_size, MAX_ACTIONS_PER_UNIT),
        )
        self.critic = nn.Sequential(
            nn.Linear(hidden_size * 2, hidden_size),
            nn.GELU(),
            nn.Linear(hidden_size, 1),
        )
        nn.init.normal_(self.slot_embeddings, std=0.02)

    def forward(
        self,
        units: Tensor,
        unit_mask: Tensor,
        global_features: Tensor,
        action_mask: Tensor,
        actor_indices: Tensor,
    ) -> tuple[Tensor, Tensor]:
        encoded = self.unit_encoder(units)
        encoded = self.transformer(encoded, src_key_padding_mask=~unit_mask.bool())
        weights = unit_mask.unsqueeze(-1).to(encoded.dtype)
        pooled = (encoded * weights).sum(dim=1) / weights.sum(dim=1).clamp_min(1.0)
        global_encoded = self.global_encoder(global_features)
        context = torch.cat((pooled, global_encoded), dim=-1)
        padding = torch.zeros(
            (*encoded.shape[:-2], 1, encoded.shape[-1]),
            dtype=encoded.dtype,
            device=encoded.device,
        )
        addressable = torch.cat((encoded, padding), dim=1)
        actor_tokens = torch.gather(
            addressable,
            1,
            actor_indices.long().unsqueeze(-1).expand(-1, -1, encoded.shape[-1]),
        )
        actor_tokens = actor_tokens + self.slot_embeddings
        slot_context = context[:, None, :].expand(-1, MAX_TEAM_UNITS, -1)
        logits = self.actor(torch.cat((actor_tokens, slot_context), dim=-1))
        logits = logits.masked_fill(~action_mask.bool(), torch.finfo(logits.dtype).min)
        value = self.critic(context).squeeze(-1)
        return logits, value


def sample_actions(logits: Tensor) -> tuple[Tensor, Tensor, Tensor]:
    distribution = torch.distributions.Categorical(logits=logits)
    actions = distribution.sample()
    return actions, distribution.log_prob(actions).sum(-1), distribution.entropy().sum(-1)


def evaluate_actions(logits: Tensor, actions: Tensor) -> tuple[Tensor, Tensor]:
    distribution = torch.distributions.Categorical(logits=logits)
    return distribution.log_prob(actions).sum(-1), distribution.entropy().sum(-1)


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
