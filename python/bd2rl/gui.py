from __future__ import annotations

import argparse
import json
import threading
import webbrowser
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import numpy as np
import torch

from .env import Bd2Env, EnvConfig
from .model import MaskedActorCritic, load_policy_checkpoint


class GuiSession:
    def __init__(
        self,
        database: Path,
        scenario: Path,
        checkpoint: Path | None,
        seed: int,
        policy_side: str | None,
    ) -> None:
        self.lock = threading.RLock()
        self.seed = seed
        self.environment = Bd2Env(EnvConfig(database, scenario, seed, auto_opponent=False))
        self.observation, self.info = self.environment.reset(seed=seed)
        self.device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        self.model: MaskedActorCritic | None = None
        self.policy_side = policy_side.upper() if policy_side else None
        if checkpoint is not None:
            self.model = load_policy_checkpoint(checkpoint, self.device)
        if self.policy_side is not None and self.model is None:
            raise ValueError("--policy-side requires --checkpoint")

    def reset(self, seed: int | None = None) -> dict[str, Any]:
        with self.lock:
            self.seed = self.seed + 1 if seed is None else seed
            self.observation, self.info = self.environment.reset(seed=self.seed)
            self._advance_policy_side()
            self._refresh_view()
            return self.payload()

    def step(self, actions: list[int]) -> dict[str, Any]:
        with self.lock:
            state = json.loads(self.environment.snapshot_json())
            active_side = state["active_side"]
            if self.policy_side == active_side:
                raise RuntimeError(f"{active_side} is controlled by the loaded policy")
            self.environment.submit_turn(np.asarray(actions, dtype=np.int64), active_side)
            self._advance_policy_side()
            self._refresh_view()
            terminated = self.info["terminal"] is not None
            truncated = False
            result = self.payload()
            result["terminated"] = terminated
            result["truncated"] = truncated
            return result

    def ai_step(self) -> dict[str, Any]:
        with self.lock:
            state = json.loads(self.environment.snapshot_json())
            if state["terminal"] is not None:
                return self.payload()
            side = state["active_side"]
            actions = self._policy_actions(side)
            self.environment.submit_turn(actions, side)
            self._refresh_view()
            return self.payload()

    def _policy_actions(self, side: str) -> np.ndarray:
        if self.model is None:
            return np.zeros(5, dtype=np.int64)
        observation = self.environment.observation_for(side)
        tensors = {
            key: torch.as_tensor(value[None], device=self.device)
            for key, value in observation.items()
        }
        with torch.inference_mode():
            logits, _ = self.model(
                tensors["units"].float(),
                tensors["unit_mask"].bool(),
                tensors["global"].float(),
                tensors["action_mask"].bool(),
                tensors["actor_indices"].long(),
            )
        return logits.argmax(-1)[0].cpu().numpy().astype(np.int64)

    def _advance_policy_side(self) -> None:
        for _ in range(128):
            state = json.loads(self.environment.snapshot_json())
            if state["terminal"] is not None or state["active_side"] != self.policy_side:
                return
            self.environment.submit_turn(self._policy_actions(self.policy_side), self.policy_side)
        raise RuntimeError("policy auto-play exceeded safety limit")

    def _refresh_view(self) -> None:
        state = json.loads(self.environment.snapshot_json())
        self.observation = self.environment.observation_for(state["active_side"])
        self.info = self.environment.info()

    def payload(self) -> dict[str, Any]:
        state = json.loads(self.environment.snapshot_json())
        legal = json.loads(self.environment.simulator.legal_actions_json(state["active_side"]))
        return {
            "state": state,
            "legal": legal,
            "seed": self.seed,
            "policy_loaded": self.model is not None,
            "policy_side": self.policy_side,
            "device": str(self.device),
        }


def handler_factory(session: GuiSession, ui_root: Path) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        server_version = "BD2SimulatorGUI/0.1"

        def do_GET(self) -> None:
            if self.path == "/api/state":
                self._json(session.payload())
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
            }.get(path.suffix, "application/octet-stream")
            body = path.read_bytes()
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self) -> None:
            try:
                body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
                payload = json.loads(body or b"{}")
                if self.path == "/api/reset":
                    self._json(session.reset(payload.get("seed")))
                elif self.path == "/api/step":
                    self._json(session.step(payload["actions"]))
                elif self.path == "/api/ai-step":
                    self._json(session.ai_step())
                else:
                    self.send_error(HTTPStatus.NOT_FOUND)
            except (KeyError, TypeError, ValueError, RuntimeError) as error:
                self._json({"error": str(error)}, HTTPStatus.BAD_REQUEST)

        def log_message(self, format: str, *args: object) -> None:
            return

        def _json(self, payload: dict[str, Any], status: HTTPStatus = HTTPStatus.OK) -> None:
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    return Handler


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the optional BrownDust2 simulator GUI")
    parser.add_argument("--database", type=Path, required=True)
    parser.add_argument("--scenario", type=Path, required=True)
    parser.add_argument("--checkpoint", type=Path)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--policy-side", choices=("PLAYER", "ENEMY"))
    parser.add_argument("--no-open", action="store_true")
    args = parser.parse_args()
    repository_root = Path(__file__).resolve().parents[2]
    session = GuiSession(args.database, args.scenario, args.checkpoint, args.seed, args.policy_side)
    server = ThreadingHTTPServer(
        (args.host, args.port), handler_factory(session, repository_root / "ui")
    )
    url = f"http://{args.host}:{args.port}/"
    print(f"BrownDust2 simulator GUI: {url}")
    if not args.no_open:
        threading.Timer(0.3, lambda: webbrowser.open(url)).start()
    server.serve_forever()


if __name__ == "__main__":
    main()
