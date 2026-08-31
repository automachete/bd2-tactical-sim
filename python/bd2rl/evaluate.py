from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
import torch

from .env import Bd2Env, EnvConfig
from .model import load_policy_checkpoint


def main() -> None:
    parser = argparse.ArgumentParser(description="Evaluate a trained BrownDust2 policy")
    parser.add_argument("--database", type=Path, required=True)
    parser.add_argument("--scenario", type=Path, required=True)
    parser.add_argument("--checkpoint", type=Path, required=True)
    parser.add_argument("--episodes", type=int, default=100)
    parser.add_argument("--seed", type=int, default=1000)
    args = parser.parse_args()
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    model = load_policy_checkpoint(args.checkpoint, device)
    env = Bd2Env(EnvConfig(args.database, args.scenario, args.seed))
    wins = 0
    rewards = []
    for episode in range(args.episodes):
        observation, _ = env.reset(seed=args.seed + episode)
        total = 0.0
        while True:
            tensors = {
                key: torch.as_tensor(value[None], device=device)
                for key, value in observation.items()
            }
            with torch.inference_mode():
                logits, _ = model(
                    tensors["units"].float(),
                    tensors["unit_mask"].bool(),
                    tensors["global"].float(),
                    tensors["action_mask"].bool(),
                    tensors["actor_indices"].long(),
                )
            action = logits.argmax(-1)[0].cpu().numpy().astype(np.int64)
            observation, reward, terminated, truncated, info = env.step(action)
            total += reward
            if terminated or truncated:
                wins += info["terminal"]["outcome"] == "WIN"
                break
        rewards.append(total)
    print(
        f"episodes={args.episodes} win_rate={wins / args.episodes:.4f} "
        f"mean_reward={np.mean(rewards):.6f} device={device}"
    )


if __name__ == "__main__":
    main()
