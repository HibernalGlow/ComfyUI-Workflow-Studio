#!/usr/bin/env python3
"""One-off SFW MOSS-Image style-transfer probe (Fkey or FRENG).

This is a permitted single-image probe, not a formal storyboard batch. It uses
the same SFT checkpoint, structured JSON layout, canvas, seed, and sampler for
both styles; only the LoRA and its required trigger handling change.
"""
from __future__ import annotations

import json
import time
import sys
import urllib.error
import urllib.request
import uuid
from pathlib import Path

HOST = "http://127.0.0.1:8188"
UNET = "moss_image_sft_int8_convrot.safetensors"
HEAL_UNET = r"moss\moss_image_heal_int8_convrot.safetensors"
TE = "qwen3.5_9b_w4a8_gptq.safetensors"
VAE = "flux2-vae_small.safetensors"
FKEY = r"moss\MOSS_fkey-lora-r4-muon-step6840-comfy.safetensors"
FRENG = r"moss\_!NEEDS_SFT_CKPT\freng_moss_style_heal_lora_rd64_15MP-step_00005100.safetensors"
SEED = 424243

POSITIVE = r'''<|artist|>fkey<|/artist|>
{"summary":{"meta":["comic","multi_panel","digital_painting"],"canvas":"multi_panel","caption":"A fully colored four-panel vertical 2D digital painting comic with selective focus: finely rendered, luminous facial features, glistening highlights and delicate hair strands contrasted against expressive, breathable painterly gouache brushwork on clothing, leaves and the Sumeru greenhouse architecture. Muted warm peach skin, white, sage green and soft gold palette, gentle bright daylight after rain, smooth creamy skin tones, crisp Chinese dialogue in clean speech bubbles, zero rough sketch lines, wholesome fantasy slice-of-life, 1girl, nahida (genshin impact), Sumeru greenhouse, botanical library, reading, watering plants."},"items":[{"label":"character","caption":"Top panel, wide view: Nahida sits on a low wooden bench inside a glass Sumeru greenhouse, reading an open book beside a rain-streaked window. Her short white hair fades to pale green at the ends, a green leaf hair ornament rests above her bangs, and her white dress with green and gold leaf motifs catches soft daylight. Lush potted plants and hanging vines recede behind her in loose gouache brushwork.","bbox":[-740,-480,740,120]},{"label":"text","caption":"A clean rounded speech bubble with dark green vertical Chinese lettering near the upper right.","text":"今天也要好好读书哦","bbox":[300,-430,700,-160]},{"label":"object","caption":"Lower-left panel, close-up: Nahida's small hand turns a page beside a fresh glowing green leaf and scattered raindrops on the wooden table. Fine highlights on the fingers and leaf veins contrast against soft painterly wood grain.","bbox":[-740,20,-40,470]},{"label":"object","caption":"Lower-right panel, medium view: Nahida gently waters a flowering sprout in a ceramic pot, the small stream catching warm light while hanging vines and glass roof panes dissolve into breathable gouache strokes.","bbox":[20,20,740,470]},{"label":"character","caption":"Bottom panel, portrait focus: Nahida looks up from the book with a calm, curious smile, luminous green eyes with star-shaped highlights, wispy white-and-green hair framing her face, tiny pointed ears visible, soft blush and delicate skin rendering against a loosely painted botanical background.","bbox":[-740,500,740,920]},{"label":"text","caption":"A small clean speech bubble with dark green Chinese lettering beside the portrait.","text":"森林会记住每一个故事","bbox":[320,550,700,770]}],"bbox_coord_space":"abs_centralized","bbox_format":"yxyx"}'''

NEGATIVE = (
    "photorealistic, real human, 3d render, cgi, photograph, monochrome, greyscale, "
    "black and white, screentones, draft, messy lines, manga draft, lineart only, sketch, "
    "rough sketch, messy construction lines, uncolored patches, unpolished, camera flash, "
    "microscopic pores, film grain, green skin, zombie skin, blotchy skin patches, "
    "harsh unblended skin blocks, over-sharpened hard edges, vector art, plastic skin, "
    "oversaturated neon colors, thick black outlines, blurry, out of focus, lowres, "
    "ugly face, distorted face, bad anatomy, fused bodies, extra limbs, extra arms, "
    "extra legs, extra hands, extra fingers, missing fingers, watermark, signature, logo"
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


def build(style="fkey", base="sft"):
    unet = UNET if base == "sft" else HEAL_UNET
    if style == "fkey":
        lora = FKEY
        strength = 0.6
        prefix = f"probe_moss/fkey_nahida_greenhouse_{base}_sfw"
        positive = POSITIVE
    elif style == "freng":
        # Civitai states the MOSS-heal variant has no trigger word. Remove the
        # Fkey structural token so the comparison isolates the style adapter.
        lora = FRENG
        strength = 0.7
        prefix = f"probe_moss/freng_nahida_greenhouse_{base}_sfw"
        positive = POSITIVE.removeprefix("<|artist|>fkey<|/artist|>\n")
    else:
        raise ValueError("style must be fkey or freng")
    return {
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": unet, "weight_dtype": "default"}},
        "2": {"class_type": "CLIPLoader", "inputs": {"clip_name": TE, "type": "moss_image"}},
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": VAE}},
        "4": {"class_type": "CLIPTextEncode", "inputs": {"text": positive, "clip": ["2", 0]}},
        "5": {"class_type": "CLIPTextEncode", "inputs": {"text": NEGATIVE, "clip": ["2", 0]}},
        "6": {"class_type": "EmptyLatentImage", "inputs": {"width": 1024, "height": 1536, "batch_size": 1}},
        # Fkey is a diffusion-model LoRA; this is the proven MOSS path used by
        # the existing MOSS style probes. FRENG is also model-only and has no
        # trigger; both stay on the same SFT checkpoint for a controlled test.
        "10": {"class_type": "LoraLoaderModelOnly", "inputs": {
            "model": ["1", 0], "lora_name": lora, "strength_model": strength}},
        "7": {"class_type": "KSampler", "inputs": {
            "seed": SEED, "steps": 25, "cfg": 3.3, "sampler_name": "euler",
            # The installed SFT int8 convrot workflow already carries the
            # matching flow treatment. Adding ModelSamplingSD3 here doubles it
            # and produces noise (verified by the first probe).
            "scheduler": "sgm_uniform", "denoise": 1.0, "model": ["10", 0],
            "positive": ["4", 0], "negative": ["5", 0], "latent_image": ["6", 0]}},
        "8": {"class_type": "VAEDecode", "inputs": {"samples": ["7", 0], "vae": ["3", 0]}},
        "9": {"class_type": "SaveImage", "inputs": {"images": ["8", 0], "filename_prefix": prefix}},
    }


def main():
    style = sys.argv[1].lower() if len(sys.argv) > 1 else "fkey"
    base = sys.argv[2].lower() if len(sys.argv) > 2 else "sft"
    if style not in {"fkey", "freng"} or base not in {"sft", "heal"}:
        print("usage: probe_moss_style_nahida_safe.py [fkey|freng] [sft|heal]")
        return 2
    try:
        queued = api("/prompt", {"prompt": build(style, base), "client_id": str(uuid.uuid4())})
    except urllib.error.HTTPError as e:
        print("HTTP", e.code, e.read().decode(errors="replace")[:3000])
        return 1
    pid = queued["prompt_id"]
    print(f"queued {pid} -> {style}/{base}", flush=True)
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
