from __future__ import annotations

import argparse
import json
import platform
import time
from pathlib import Path

import numpy as np
import torch

from . import _native
from .batch_env import NativeBatchEnv
from .model import MaskedActorCritic
from .train import model_forward, to_device


def timed(repetitions: int, operation: object) -> float:
    started = time.perf_counter()
    for _ in range(repetitions):
        operation()  # type: ignore[operator]
    return time.perf_counter() - started


def benchmark(
    database: Path,
    scenario: Path,
    batch_size: int,
    repetitions: int,
    seed: int,
) -> dict[str, object]:
    setup_json = scenario.read_text(encoding="utf-8")
    actions = np.zeros((batch_size, 11), dtype=np.int64)
    action_lists = actions.tolist()
    action_json = json.dumps(action_lists, separators=(",", ":"))

    legacy = _native.BatchSimulator(str(database), setup_json, batch_size, seed)
    for _ in range(10):
        payload = json.loads(legacy.step_json(action_json))
        NativeBatchEnv._stack([item["observation"] for item in payload])
    legacy_elapsed = timed(
        repetitions,
        lambda: NativeBatchEnv._stack(
            [item["observation"] for item in json.loads(legacy.step_json(action_json))]
        ),
    )

    direct = NativeBatchEnv(database, scenario, batch_size, seed)
    direct.reset()
    for _ in range(10):
        direct.step(actions)
    direct_elapsed = timed(repetitions, lambda: direct.step(actions))
    frames = direct.observe()
    environment_steps = batch_size * repetitions

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    model = MaskedActorCritic().to(device).eval()
    device_batch = to_device(frames, device)
    gpu_report: dict[str, object] = {
        "available": torch.cuda.is_available(),
        "device": torch.cuda.get_device_name(0) if torch.cuda.is_available() else "cpu",
        "transfer_frames_per_second": None,
        "forward_frames_per_second": None,
    }
    if device.type == "cuda":
        for _ in range(20):
            to_device(frames, device)
        torch.cuda.synchronize()
        transfer_repetitions = max(100, repetitions)
        transfer_started = time.perf_counter()
        for _ in range(transfer_repetitions):
            to_device(frames, device)
        torch.cuda.synchronize()
        transfer_elapsed = time.perf_counter() - transfer_started

        with torch.inference_mode(), torch.autocast("cuda", dtype=torch.bfloat16):
            for _ in range(20):
                model_forward(model, device_batch)
            torch.cuda.synchronize()
            forward_repetitions = max(50, repetitions // 2)
            forward_started = time.perf_counter()
            for _ in range(forward_repetitions):
                model_forward(model, device_batch)
            torch.cuda.synchronize()
            forward_elapsed = time.perf_counter() - forward_started
        gpu_report["transfer_frames_per_second"] = round(
            batch_size * transfer_repetitions / transfer_elapsed, 1
        )
        gpu_report["forward_frames_per_second"] = round(
            batch_size * forward_repetitions / forward_elapsed, 1
        )

    legacy_rate = environment_steps / legacy_elapsed
    direct_rate = environment_steps / direct_elapsed
    return {
        "schema": "bd2-performance-v1",
        "platform": platform.system(),
        "python": platform.python_version(),
        "torch": torch.__version__,
        "batch_size": batch_size,
        "measured_environment_steps": environment_steps,
        "cpu_batch": {
            "legacy_json_steps_per_second": round(legacy_rate, 1),
            "direct_numpy_steps_per_second": round(direct_rate, 1),
            "speedup": round(direct_rate / legacy_rate, 2),
        },
        "gpu_input": gpu_report,
        "status": "ok",
    }


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Benchmark the Rust batch simulator and GPU policy input path"
    )
    parser.add_argument("--database", type=Path, default=Path("data/generated/bd2.sqlite"))
    parser.add_argument("--scenario", type=Path, default=Path("data/scenarios/normal-demo.json"))
    parser.add_argument("--batch-size", type=int, default=64)
    parser.add_argument("--repetitions", type=int, default=200)
    parser.add_argument("--seed", type=int, default=123)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.batch_size <= 0 or args.repetitions <= 0:
        parser.error("batch-size and repetitions must be positive")
    report = benchmark(
        args.database,
        args.scenario,
        args.batch_size,
        args.repetitions,
        args.seed,
    )
    rendered = json.dumps(report, ensure_ascii=False, indent=2)
    print(rendered)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(f"{rendered}\n", encoding="utf-8")


if __name__ == "__main__":
    main()
