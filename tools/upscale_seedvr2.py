"""SeedVR2 单图 2× 放大（通过 ComfyUI API 提交，结果回传 Mac）。

用法：
    python3.12 tools/upscale_seedvr2.py \
        --image /path/to/src.png --out /path/to/dst.png \
        [--resolution 2048] [--blocks 20] [--seed 42]

resolution 是放大后「短边」的像素数；1024×1536 输入 → 2048×3072。
"""

import argparse
import json
import os
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

HOST = "http://127.0.0.1:8188"


def upload(path: Path, name: str) -> str:
    r = subprocess.run(
        ["curl", "-s", "-F", f"image=@{path}", "-F", "overwrite=true",
         f"{HOST}/upload/image"],
        capture_output=True, text=True, timeout=180,
    )
    if r.returncode != 0:
        raise RuntimeError(f"upload failed: {r.stderr[:400]}")
    data = json.loads(r.stdout)
    return data["name"]


def build_prompt(image_name: str, prefix: str, resolution: int, model: str,
                 blocks: int, swap_io: bool, seed: int) -> dict:
    return {
        "1": {"class_type": "LoadImage", "inputs": {"image": image_name}},
        "2": {"class_type": "SeedVR2LoadDiTModel", "inputs": {
            "model": model,
            "device": "cuda:0",
            "blocks_to_swap": blocks,
            "swap_io_components": swap_io,
            "offload_device": "cpu",
            "cache_model": False,
            "attention_mode": "sdpa",
        }},
        "3": {"class_type": "SeedVR2LoadVAEModel", "inputs": {
            "model": "ema_vae_fp16.safetensors",
            "device": "cuda:0",
            "encode_tiled": True,
            "encode_tile_size": 1024,
            "encode_tile_overlap": 128,
            "decode_tiled": True,
            "decode_tile_size": 1024,
            "decode_tile_overlap": 128,
            "offload_device": "cpu",
            "cache_model": False,
        }},
        "4": {"class_type": "SeedVR2VideoUpscaler", "inputs": {
            "image": ["1", 0],
            "dit": ["2", 0],
            "vae": ["3", 0],
            "seed": seed,
            "resolution": resolution,
            "max_resolution": 0,
            "batch_size": 1,
            "uniform_batch_size": False,
            "color_correction": "lab",
            "temporal_overlap": 0,
            "input_noise_scale": 0.0,
            "latent_noise_scale": 0.0,
            "offload_device": "cpu",
            "enable_debug": False,
        }},
        "5": {"class_type": "SaveImage", "inputs": {"images": ["4", 0], "filename_prefix": prefix}},
    }


def submit(prompt: dict) -> str:
    body = json.dumps({"prompt": prompt, "client_id": "seedvr2-upscaler"}).encode()
    req = urllib.request.Request(f"{HOST}/prompt", data=body,
                                 headers={"Content-Type": "application/json"})
    return json.loads(urllib.request.urlopen(req, timeout=60).read())["prompt_id"]


def wait(pid: str, timeout: int = 1800) -> dict:
    start = time.time()
    last = 0
    while time.time() - start < timeout:
        try:
            hist = json.loads(urllib.request.urlopen(f"{HOST}/history/{pid}", timeout=30).read())
        except Exception:
            hist = {}
        if pid in hist:
            entry = hist[pid]
            status = entry.get("status", {})
            if status.get("status_str") == "error":
                raise RuntimeError(f"SeedVR2 execution error: {status.get('messages')}")
            if entry.get("outputs"):
                return entry
        elapsed = int(time.time() - start)
        if elapsed - last >= 30:
            print(f"  ⏳ {elapsed}s…", flush=True)
            last = elapsed
        time.sleep(3)
    raise TimeoutError(f"SeedVR2 timeout after {timeout}s")


def download(entry: dict, out: Path) -> None:
    images = entry["outputs"]["5"]["images"]
    info = images[0]
    query = urllib.parse.urlencode({
        "filename": info["filename"],
        "subfolder": info.get("subfolder", ""),
        "type": info.get("type", "output"),
    })
    out.parent.mkdir(parents=True, exist_ok=True)
    with urllib.request.urlopen(f"{HOST}/view?{query}", timeout=300) as r, open(out, "wb") as f:
        f.write(r.read())


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--image", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--resolution", type=int, default=2048)
    ap.add_argument("--model", default="seedvr2_ema_3b_fp8_e4m3fn.safetensors")
    ap.add_argument("--blocks", type=int, default=0)
    ap.add_argument("--swap-io", action="store_true")
    ap.add_argument("--seed", type=int, default=42)
    args = ap.parse_args()

    src = Path(args.image).resolve()
    if not src.exists():
        raise SystemExit(f"not found: {src}")

    stem = src.stem.encode("ascii", "ignore").decode() or "src"
    name = f"seedvr2_{abs(hash(str(src))) % 10**8}_{stem}.png"
    print(f"⬆️  上传 {src.name} → ComfyUI input")
    uploaded = upload(src, name)

    prefix = f"seedvr2/{Path(args.out).stem}"
    prompt = build_prompt(uploaded, prefix, args.resolution, args.model,
                          args.blocks, args.swap_io, args.seed)
    print(f"🚀 提交 SeedVR2 {args.model}｜短边 {args.resolution}px｜"
          f"blocks_to_swap={args.blocks}｜swap_io={args.swap_io}")
    pid = submit(prompt)

    entry = wait(pid)
    download(entry, Path(args.out).resolve())
    print(f"✅ 完成：{args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
