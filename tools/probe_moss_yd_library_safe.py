#!/usr/bin/env python3
"""One-off SFW YD-style MOSS-Image multi-panel probe.

Permitted single-image test only: new scene/layout, SFT fused-QKV checkpoint,
YD trigger, no ModelSamplingSD3 node.
"""
from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

HOST = "http://127.0.0.1:8188"
ROOT = Path("/Users/glow/Base/Works/ComfyUI")
PROMPT_FILE = ROOT / "Workflows/wild/storyboard/原神_纳西妲_大慈树王/yd_library_rain_sfw.prompt"
UNET = "moss_image_sft_int8_convrot.safetensors"
TE = "qwen3.5_9b_w4a8_gptq.safetensors"
VAE = "flux2-vae_small.safetensors"
YD = r"moss\run-comfy.safetensors"
NEGATIVE = (
    "photorealistic, real human, 3d render, cgi, photograph, monochrome, greyscale, "
    "black and white, screentones, rough sketch, messy construction lines, lineart only, "
    "uncolored patches, plastic skin, oversaturated neon colors, harsh outlines, blurry, "
    "out of focus, lowres, ugly face, distorted face, bad anatomy, extra limbs, extra arms, "
    "extra hands, extra fingers, missing fingers, watermark, signature, logo"
)


def api(path: str, payload=None, timeout=120):
    data = None
    headers = {}
    if payload is not None:
        data = json.dumps(payload, ensure_ascii=False).encode()
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(HOST + path, data=data, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def build():
    prompt = "yd_style\n" + PROMPT_FILE.read_text(encoding="utf-8").strip()
    return {
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": UNET, "weight_dtype": "default"}},
        "2": {"class_type": "CLIPLoader", "inputs": {"clip_name": TE, "type": "moss_image"}},
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": VAE}},
        "4": {"class_type": "CLIPTextEncode", "inputs": {"text": prompt, "clip": ["2", 0]}},
        "5": {"class_type": "CLIPTextEncode", "inputs": {"text": NEGATIVE, "clip": ["2", 0]}},
        "6": {"class_type": "EmptyLatentImage", "inputs": {"width": 1024, "height": 1536, "batch_size": 1}},
        "10": {"class_type": "LoraLoaderModelOnly", "inputs": {
            "model": ["1", 0], "lora_name": YD, "strength_model": 0.7}},
        "7": {"class_type": "KSampler", "inputs": {
            "seed": 424244, "steps": 30, "cfg": 3.2, "sampler_name": "euler",
            "scheduler": "sgm_uniform", "denoise": 1.0, "model": ["10", 0],
            "positive": ["4", 0], "negative": ["5", 0], "latent_image": ["6", 0]}},
        "8": {"class_type": "VAEDecode", "inputs": {"samples": ["7", 0], "vae": ["3", 0]}},
        "9": {"class_type": "SaveImage", "inputs": {
            "images": ["8", 0], "filename_prefix": "probe_moss/yd_nahida_library_rain_sfw"}},
    }


def main():
    try:
        queued = api("/prompt", {"prompt": build(), "client_id": str(uuid.uuid4())})
    except urllib.error.HTTPError as e:
        print("HTTP", e.code, e.read().decode(errors="replace")[:3000])
        return 1
    pid = queued["prompt_id"]
    print(f"queued {pid} -> yd", flush=True)
    deadline = time.time() + 1800
    while time.time() < deadline:
        time.sleep(5)
        try:
            hist = api(f"/history/{pid}", timeout=30)
        except Exception:
            continue
        if pid not in hist:
            continue
        status = hist[pid].get("status", {})
        print("status", status.get("status_str"), "completed", status.get("completed"), flush=True)
        for node, out in hist[pid].get("outputs", {}).items():
            print("out", node, json.dumps(out, ensure_ascii=False)[:1000], flush=True)
        return 0 if status.get("status_str") == "success" else 1
    print("TIMEOUT")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
