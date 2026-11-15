#!/usr/bin/env python3
"""A/B/C probe: three community "Si / 祀 (Arknights: Endfield)" LoRAs on MOSS SFT.

Fixed everything except the character LoRA file, so the only variable is the
training run itself:

  * base   : moss_image_sft_int8_convrot
  * style  : loom style v1 (no trigger word) @ LOOM_STRENGTH
  * char   : one of the three LoRAs below @ char strength
  * seed   : identical across arms
  * prompt : identical across arms

Usage:
    probe_moss_si_lora_compare.py [all|r32muon|umav1|arknights] [strength]
"""
from __future__ import annotations

import json
import sys
import time
import urllib.error
import urllib.request
import uuid

HOST = "http://127.0.0.1:8188"
UNET = "moss_image_sft_int8_convrot.safetensors"
TE = "qwen3.5_9b_w4a8_gptq.safetensors"
VAE = "flux2-vae_small.safetensors"

LOOM = r"moss\zhibuji_loom_style_moss_uma_v1.safetensors"
LOOM_STRENGTH = 0.9

# arm key -> (lora file, note)
ARMS = {
    "r32muon": (r"moss\si_mossbase_r32_muon_e20_20261027_e19.safetensors",
                "model 3027680 v1.0 / bf16 / r32 muon / e19"),
    "umav1": (r"moss\si_moss_uma_v1.safetensors",
              "model 2795280 moss / fp32 / uma v1"),
    "arknights": (r"moss\si-arknights.safetensors",
                  "model 2547832 MOSS / bf16 / v1"),
}

WIDTH = 1088
HEIGHT = 1440
SEED = 812_402
STEPS = 28
CFG = 3.3

PROMPT = (
    "祀（明日方舟）, arknights endfield si, 1girl, solo, looking at viewer, standing, "
    "full body, cowboy shot, low twintails, double bun, very long hair, pale green hair, "
    "dark green streaks, blunt bangs, green eyes, blue eyes, elf ears, black branched horns, "
    "gold geometric hairpin, golden hairband, eastern dragon tail, black detached wings, "
    "white sleeveless dress, chest keyhole cutout, detached sleeves, mismatched gloves, "
    "blue socks, thigh strap, black shoes, "
    "bright clean studio background, soft pastel backdrop, "
    "delicate crisp lineart, soft luminous shading, silky hair strands, refined fabric sheen, "
    "elegant finished illustration, safe, wholesome"
)

NEGATIVE = (
    "nsfw, nude, naked, cleavage, underwear, sexual, worst quality, low quality, blurry, "
    "sketch, rough sketch, draft, wip, messy lines, loose lines, unfinished, unpolished, "
    "flat shading, jpeg artifacts, watermark, text, signature, artist name, "
    "bad anatomy, extra limbs, extra arms, extra legs, extra fingers, six fingers, "
    "malformed hands, deformed, fused legs, child, loli"
)


def api(path: str, payload=None, timeout: int = 120):
    data = None
    headers = {}
    if payload is not None:
        data = json.dumps(payload, ensure_ascii=False).encode()
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(HOST + path, data=data, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def graph(arm: str, strength: float, seed: int = SEED):
    lora, _ = ARMS[arm]
    return {
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": UNET, "weight_dtype": "default"}},
        "2": {"class_type": "CLIPLoader", "inputs": {"clip_name": TE, "type": "moss_image"}},
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": VAE}},
        "4": {"class_type": "CLIPTextEncode", "inputs": {"text": PROMPT, "clip": ["2", 0]}},
        "5": {"class_type": "CLIPTextEncode", "inputs": {"text": NEGATIVE, "clip": ["2", 0]}},
        "6": {"class_type": "EmptyLatentImage", "inputs": {"width": WIDTH, "height": HEIGHT, "batch_size": 1}},
        "10": {"class_type": "LoraLoaderModelOnly", "inputs": {
            "model": ["1", 0], "lora_name": LOOM, "strength_model": LOOM_STRENGTH}},
        "11": {"class_type": "LoraLoaderModelOnly", "inputs": {
            "model": ["10", 0], "lora_name": lora, "strength_model": strength}},
        "7": {"class_type": "KSampler", "inputs": {
            "seed": seed, "steps": STEPS, "cfg": CFG, "sampler_name": "euler",
            "scheduler": "sgm_uniform", "denoise": 1.0,
            "model": ["11", 0], "positive": ["4", 0], "negative": ["5", 0], "latent_image": ["6", 0]}},
        "8": {"class_type": "VAEDecode", "inputs": {"samples": ["7", 0], "vae": ["3", 0]}},
        "9": {"class_type": "SaveImage", "inputs": {
            "images": ["8", 0],
            "filename_prefix": f"moss-probe/si_cmp_{arm}_s{str(strength).replace('.', '')}"}},
    }


def run(arm: str, strength: float):
    try:
        queued = api("/prompt", {"prompt": graph(arm, strength), "client_id": str(uuid.uuid4())})
    except urllib.error.HTTPError as e:
        print("HTTP", e.code, e.read().decode(errors="replace")[:4000])
        return 1
    pid = queued["prompt_id"]
    print(f"queued {pid} -> {arm} @ {strength}", flush=True)
    deadline = time.time() + 2400
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
            print("out", node, json.dumps(out, ensure_ascii=False)[:1500], flush=True)
        return 0 if status.get("status_str") == "success" else 1
    print("TIMEOUT", arm)
    return 1


def main() -> int:
    args = [a for a in sys.argv[1:] if a]
    sel = args[0] if args and args[0] != "all" else None
    strength = float(args[1]) if len(args) > 1 else 0.9
    if sel and sel not in ARMS:
        print("usage: probe_moss_si_lora_compare.py [all|%s] [strength]" % "|".join(ARMS))
        return 2
    rc = 0
    for arm in ([sel] if sel else list(ARMS)):
        rc |= run(arm, strength)
    return rc


if __name__ == "__main__":
    raise SystemExit(main())
