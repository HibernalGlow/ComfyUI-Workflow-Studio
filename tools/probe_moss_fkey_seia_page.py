#!/usr/bin/env python3
"""Single-page MOSS/Fkey probe: Seia in original outfit + swimsuit.

This is a permitted single-image probe, not a formal storyboard batch. It keeps
the validated Fkey/SFT stack and the two-panel layout JSON in the work folder,
then mirrors the finished PNG back to Outputs/moss-probe/.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

HOST = "http://127.0.0.1:8188"
UNET = "moss_image_sft_int8_convrot.safetensors"
TE = "qwen3.5_9b_w4a8_gptq.safetensors"
VAE = "flux2-vae_small.safetensors"
LORA = r"moss\MOSS_fkey-lora-r4-muon-step6840-comfy.safetensors"
TRIGGER = "<|artist|>fkey<|/artist|>"

ROOT = Path(__file__).resolve().parents[2]
WORK = ROOT / "Workflows/wild/storyboard/蔚蓝档案_圣娅_原皮泳装"
LAYOUT = WORK / "seia_two_outfits.json"
PROMPT = WORK / "seia_two_outfits.prompt"
LOCAL_OUT = ROOT / "Outputs/moss-probe"

NEGATIVE = (
    "nsfw, nude, naked, topless, underwear, bra, panties, sexual, suggestive, "
    "spread legs, child, loli, photorealistic, real human, 3d render, cgi, "
    "photograph, monochrome, greyscale, black and white, screentones, sketch, "
    "rough sketch, draft, messy lines, lineart only, uncolored, flat shading, "
    "gouache, watercolor bleed, impasto, rough brushwork, visible brushstrokes, "
    "painterly smudge, soft focus face, closed eyes, blurry, out of focus, lowres, ugly face, distorted face, bad anatomy, "
    "fused bodies, extra limbs, extra arms, extra legs, extra hands, extra "
    "fingers, missing fingers, six fingers, malformed hands, watermark, "
    "signature, logo, text, speech bubble, lettering, border art"
)


def api(path: str, payload=None, timeout: int = 120):
    data = None
    headers = {}
    if payload is not None:
        data = json.dumps(payload, ensure_ascii=False).encode()
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(HOST + path, data=data, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as response:
        return json.loads(response.read())


def load_prompt() -> tuple[str, int, int]:
    if not PROMPT.exists():
        raise SystemExit(f"missing compiled prompt: {PROMPT}")
    layout = json.loads(LAYOUT.read_text(encoding="utf-8"))
    body = PROMPT.read_text(encoding="utf-8").strip()
    return f"{TRIGGER}\n{body}", layout["width"], layout["height"]


def build(seed: int, strength: float, tag: str):
    positive, width, height = load_prompt()
    return {
        "1": {"class_type": "UNETLoader", "inputs": {
            "unet_name": UNET, "weight_dtype": "default"}},
        "2": {"class_type": "CLIPLoader", "inputs": {
            "clip_name": TE, "type": "moss_image"}},
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": VAE}},
        "4": {"class_type": "CLIPTextEncode", "inputs": {
            "text": positive, "clip": ["2", 0]}},
        "5": {"class_type": "CLIPTextEncode", "inputs": {
            "text": NEGATIVE, "clip": ["2", 0]}},
        "6": {"class_type": "EmptyLatentImage", "inputs": {
            "width": width, "height": height, "batch_size": 1}},
        "10": {"class_type": "LoraLoaderModelOnly", "inputs": {
            "model": ["1", 0], "lora_name": LORA, "strength_model": strength}},
        "7": {"class_type": "KSampler", "inputs": {
            "seed": seed, "steps": 28, "cfg": 3.3,
            "sampler_name": "euler", "scheduler": "sgm_uniform",
            "denoise": 1.0, "model": ["10", 0], "positive": ["4", 0],
            "negative": ["5", 0], "latent_image": ["6", 0]}},
        "8": {"class_type": "VAEDecode", "inputs": {
            "samples": ["7", 0], "vae": ["3", 0]}},
        "9": {"class_type": "SaveImage", "inputs": {
            "images": ["8", 0],
            "filename_prefix": f"moss-probe/fkey_seia_two_outfits{tag}"}},
    }


def mirror(item: dict, dest: Path) -> Path:
    query = urllib.parse.urlencode({
        "filename": item["filename"],
        "subfolder": item.get("subfolder", ""),
        "type": item.get("type", "output"),
    })
    with urllib.request.urlopen(f"{HOST}/view?{query}", timeout=120) as response:
        dest.write_bytes(response.read())
    return dest


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--seed", type=int, default=20261116)
    parser.add_argument("--strength", type=float, default=0.6)
    parser.add_argument("--tag", default="")
    parser.add_argument("--timeout", type=int, default=1800)
    args = parser.parse_args()

    LOCAL_OUT.mkdir(parents=True, exist_ok=True)
    try:
        queued = api("/prompt", {
            "prompt": build(args.seed, args.strength, args.tag),
            "client_id": str(uuid.uuid4()),
        })
    except urllib.error.HTTPError as error:
        print("HTTP", error.code, error.read().decode(errors="replace")[:4000])
        return 1
    pid = queued["prompt_id"]
    print(f"queued {pid} seed={args.seed} strength={args.strength}", flush=True)

    deadline = time.time() + args.timeout
    while time.time() < deadline:
        time.sleep(4)
        try:
            history = api(f"/history/{pid}", timeout=30)
        except Exception:
            continue
        if pid not in history:
            continue
        status = history[pid].get("status", {})
        print("status", status.get("status_str"), "completed", status.get("completed"), flush=True)
        outputs = history[pid].get("outputs", {})
        saved = None
        for node in outputs.values():
            for item in node.get("images", []):
                if item.get("type") == "output":
                    saved = item
        if saved:
            dest = LOCAL_OUT / saved["filename"]
            try:
                mirror(saved, dest)
                print("saved", dest, flush=True)
            except Exception as error:
                print("mirror failed:", error, flush=True)
        return 0 if status.get("status_str") == "success" else 1
    print("TIMEOUT", flush=True)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
