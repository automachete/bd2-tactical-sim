from __future__ import annotations

import argparse
import json
import os
import random
import subprocess
import sys
import time
from dataclasses import asdict, dataclass
from pathlib import Path

import numpy as np
import torch
from torch import Tensor

from .batch_env import NativeBatchEnv
from .model import (
    MODEL_ARCHITECTURE_ID,
    OBSERVATION_SCHEMA_ID,
    MaskedActorCritic,
    evaluate_actions,
    sample_actions,
)


@dataclass
class TrainConfig:
    database: Path
    scenario: Path
    output: Path = Path("checkpoints/bd2-ppo.pt")
    seed: int = 42
    total_steps: int = 2_000_000
    num_envs: int = 64
    horizon: int = 128
    update_epochs: int = 4
    minibatch_size: int = 2048
    learning_rate: float = 3e-4
    gamma: float = 0.995
    gae_lambda: float = 0.95
    clip_epsilon: float = 0.2
    value_coef: float = 0.5
    entropy_coef: float = 0.01
    max_grad_norm: float = 1.0
    compile_model: bool = True
    compile_backend: str = "auto"
    amp: bool = True


def to_device(items: dict[str, np.ndarray], device: torch.device) -> dict[str, Tensor]:
    return {key: torch.as_tensor(value, device=device) for key, value in items.items()}


def model_forward(model: torch.nn.Module, observation: dict[str, Tensor]) -> tuple[Tensor, Tensor]:
    logits, values = model(
        observation["units"].float(),
        observation["unit_mask"].bool(),
        observation["global"].float(),
        observation["action_mask"].bool(),
        observation["actor_indices"].long(),
    )
    # CUDA Graph backends reuse their output storage on the next replay.
    # Rollouts intentionally retain every step, so materialize stable tensors.
    return logits.clone(), values.clone()


def train(config: TrainConfig) -> None:
    random.seed(config.seed)
    np.random.seed(config.seed)
    torch.manual_seed(config.seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(config.seed)
        torch.backends.cuda.matmul.allow_tf32 = True
        torch.set_float32_matmul_precision("high")
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    amp_enabled = config.amp and device.type == "cuda"
    amp_dtype = torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float16

    environments = NativeBatchEnv(config.database, config.scenario, config.num_envs, config.seed)
    observations = environments.reset()

    eager_model = MaskedActorCritic().to(device)
    model: torch.nn.Module = eager_model
    selected_backend = "eager"
    if config.compile_model:
        if config.compile_backend == "auto":
            from torch.utils._triton import has_triton

            selected_backend = (
                "inductor" if has_triton() else ("cudagraphs" if device.type == "cuda" else "eager")
            )
        else:
            selected_backend = config.compile_backend
        if selected_backend == "inductor":
            model = torch.compile(
                eager_model, backend="inductor", mode="max-autotune", fullgraph=True
            )
        elif selected_backend != "eager":
            model = torch.compile(eager_model, backend=selected_backend, fullgraph=True)
    optimizer = torch.optim.AdamW(eager_model.parameters(), lr=config.learning_rate, eps=1e-5)

    batch_size = config.num_envs * config.horizon
    updates = max(1, config.total_steps // batch_size)
    global_step = 0
    started = time.perf_counter()
    config.output.parent.mkdir(parents=True, exist_ok=True)

    for update in range(1, updates + 1):
        rollout: dict[str, list[Tensor]] = {
            "units": [],
            "unit_mask": [],
            "global": [],
            "action_mask": [],
            "actor_indices": [],
            "actions": [],
            "log_probs": [],
            "values": [],
            "rewards": [],
            "dones": [],
        }
        for _ in range(config.horizon):
            batch = to_device(observations, device)
            with torch.no_grad(), torch.autocast(device.type, dtype=amp_dtype, enabled=amp_enabled):
                logits, values = model_forward(model, batch)
                actions, log_probs, _ = sample_actions(logits)
            for key in ("units", "unit_mask", "global", "action_mask", "actor_indices"):
                rollout[key].append(batch[key])
            rollout["actions"].append(actions)
            rollout["log_probs"].append(log_probs)
            rollout["values"].append(values)

            observations, rewards, dones = environments.step(actions.cpu().numpy())
            rollout["rewards"].append(torch.as_tensor(rewards, device=device))
            rollout["dones"].append(torch.as_tensor(dones, device=device))
            global_step += config.num_envs

        with torch.no_grad(), torch.autocast(device.type, dtype=amp_dtype, enabled=amp_enabled):
            next_values = model_forward(model, to_device(observations, device))[1].float()
        rewards = torch.stack(rollout["rewards"])
        dones = torch.stack(rollout["dones"])
        values = torch.stack(rollout["values"]).float()
        advantages = torch.zeros_like(rewards)
        gae = torch.zeros(config.num_envs, device=device)
        for step in reversed(range(config.horizon)):
            next_value = next_values if step == config.horizon - 1 else values[step + 1]
            nonterminal = 1.0 - dones[step]
            delta = rewards[step] + config.gamma * next_value * nonterminal - values[step]
            gae = delta + config.gamma * config.gae_lambda * nonterminal * gae
            advantages[step] = gae
        returns = advantages + values

        flat = {
            key: torch.stack(value).flatten(0, 1)
            for key, value in rollout.items()
            if key not in {"rewards", "dones", "values"}
        }
        flat_values = values.flatten()
        flat_advantages = advantages.flatten()
        flat_returns = returns.flatten()
        flat_advantages = (flat_advantages - flat_advantages.mean()) / (
            flat_advantages.std(unbiased=False) + 1e-8
        )

        indices = torch.arange(batch_size, device=device)
        losses = []
        for _ in range(config.update_epochs):
            indices = indices[torch.randperm(batch_size, device=device)]
            for start in range(0, batch_size, config.minibatch_size):
                selected = indices[start : start + config.minibatch_size]
                minibatch = {
                    key: value[selected]
                    for key, value in flat.items()
                    if key in {"units", "unit_mask", "global", "action_mask", "actor_indices"}
                }
                with torch.autocast(device.type, dtype=amp_dtype, enabled=amp_enabled):
                    logits, new_values = model_forward(model, minibatch)
                    new_log_probs, entropy = evaluate_actions(logits, flat["actions"][selected])
                    ratio = (new_log_probs - flat["log_probs"][selected]).exp()
                    unclipped = ratio * flat_advantages[selected]
                    clipped = (
                        ratio.clamp(1 - config.clip_epsilon, 1 + config.clip_epsilon)
                        * flat_advantages[selected]
                    )
                    policy_loss = -torch.minimum(unclipped, clipped).mean()
                    value_prediction = new_values.float()
                    value_clipped = flat_values[selected] + (
                        value_prediction - flat_values[selected]
                    ).clamp(-config.clip_epsilon, config.clip_epsilon)
                    value_loss = (
                        0.5
                        * torch.maximum(
                            (value_prediction - flat_returns[selected]).square(),
                            (value_clipped - flat_returns[selected]).square(),
                        ).mean()
                    )
                    loss = (
                        policy_loss
                        + config.value_coef * value_loss
                        - config.entropy_coef * entropy.mean()
                    )
                optimizer.zero_grad(set_to_none=True)
                loss.backward()
                torch.nn.utils.clip_grad_norm_(eager_model.parameters(), config.max_grad_norm)
                optimizer.step()
                losses.append(float(loss.detach()))

        elapsed = time.perf_counter() - started
        steps_per_second = global_step / max(elapsed, 1e-9)
        print(
            json.dumps(
                {
                    "update": update,
                    "steps": global_step,
                    "steps_per_second": round(steps_per_second, 1),
                    "mean_reward": float(rewards.mean()),
                    "mean_loss": float(np.mean(losses)),
                    "device": str(device),
                    "compile_backend": selected_backend,
                }
            )
        )
        if update % 10 == 0 or update == updates:
            torch.save(
                {
                    "format_version": 1,
                    "observation_schema": OBSERVATION_SCHEMA_ID,
                    "model_architecture": MODEL_ARCHITECTURE_ID,
                    "model": eager_model.state_dict(),
                    "optimizer": optimizer.state_dict(),
                    "config": {
                        key: str(value) if isinstance(value, Path) else value
                        for key, value in asdict(config).items()
                    },
                    "global_step": global_step,
                },
                config.output,
            )


def main() -> None:
    if os.name == "nt" and not sys.flags.utf8_mode:
        environment = os.environ.copy()
        environment["PYTHONUTF8"] = "1"
        completed = subprocess.run(
            [sys.executable, "-m", "bd2rl.train", *sys.argv[1:]],
            env=environment,
            check=False,
        )
        raise SystemExit(completed.returncode)
    parser = argparse.ArgumentParser(description="Train a masked PPO BrownDust2 policy")
    parser.add_argument("--database", type=Path, required=True)
    parser.add_argument("--scenario", type=Path, required=True)
    parser.add_argument("--output", type=Path, default=Path("checkpoints/bd2-ppo.pt"))
    parser.add_argument("--total-steps", type=int, default=2_000_000)
    parser.add_argument("--num-envs", type=int, default=64)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--no-compile", action="store_true")
    parser.add_argument(
        "--compile-backend",
        choices=("auto", "inductor", "cudagraphs", "eager"),
        default="auto",
    )
    args = parser.parse_args()
    train(
        TrainConfig(
            database=args.database,
            scenario=args.scenario,
            output=args.output,
            total_steps=args.total_steps,
            num_envs=args.num_envs,
            seed=args.seed,
            compile_model=not args.no_compile,
            compile_backend=args.compile_backend,
        )
    )


if __name__ == "__main__":
    main()
