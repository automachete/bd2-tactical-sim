from __future__ import annotations

import json

import torch


def main() -> None:
    cuda = torch.cuda.is_available()
    result = {
        "torch": torch.__version__,
        "cuda_available": cuda,
        "cuda_runtime": torch.version.cuda,
        "device": torch.cuda.get_device_name(0) if cuda else "cpu",
        "bf16": torch.cuda.is_bf16_supported() if cuda else False,
        "compile_available": hasattr(torch, "compile"),
    }
    if cuda:
        left = torch.randn((2048, 2048), device="cuda")
        right = torch.randn((2048, 2048), device="cuda")
        result["smoke_checksum"] = float((left @ right).mean())
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
