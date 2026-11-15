#!/usr/bin/env python3
"""打样 v2：把 Si 的 cosplay 从"漫展随手拍"拉到"顶级 coser 商业棚拍"。

单变量：同一 seed / 同一角色 LoRA 强度，只换摄影美术方向（棚拍 / 黄金时刻 / 展台闪光）。
用法: python3 tools/probe_si_cosplay2.py --endpoint http://127.0.0.1:18188
"""
import argparse
import json
import os
import time
import urllib.parse
import urllib.request

UNET = "moss_image_sft_int8_convrot.safetensors"
CLIP = "qwen3.5_9b_w4a8_gptq.safetensors"
VAE = "flux2-vae_small.safetensors"
LORA = "moss\\chara\\endfield\\si-arknights.safetensors"

SUBJECT = (
    "a stunning professional cosplayer portraying Si from Arknights: Endfield. "
    "Delicate symmetric features, flawless porcelain skin with visible pores, subtle eyeliner "
    "and soft lip tint, long eyelashes, elegant neck. Pale mint-green wig in low twin tails "
    "with a double bun and a golden hairband, pointed prosthetic elf ears, small branched horns, "
    "black feathered wing props, white dress with detached sleeves, bead bracelet, blue socks, "
    "black platform boots, a sculpted dragon-tail prop. Full body, head to toe, both feet fully "
    "visible on the ground, confident tsundere expression looking at the camera."
)

NEG = (
    "anime, illustration, 2d, 3d render, cgi, painting, cel shading, doll, plastic skin, "
    "wax figure, mannequin, plain face, ugly face, asymmetric face, harsh shadows, flat lighting, "
    "cluttered background, crowd, snapshot, phone photo, cropped, out of frame, cut off feet, "
    "six toes, extra limbs, bad anatomy, worst quality, watermark, text, signature"
)

LOOKS = {
    "studio": (
        "Editorial cosplay photoshoot in a photo studio, seamless dark charcoal backdrop, "
        "large softbox key light from the left, subtle rim light separating her from the "
        "background, 85mm f/1.4, creamy bokeh, ultra sharp focus on the eyes, "
        "high-end retouching, magazine cover quality, RAW photo."
    ),
    "goldenhour": (
        "Golden hour outdoor portrait on a quiet rooftop, warm backlight rimming her hair, "
        "creamy sun flare, shallow depth of field with a blurred city skyline far behind, "
        "85mm f/1.8, natural skin glow, cinematic color grading, RAW photo."
    ),
    "stage": (
        "Professional convention stage photo, strong diffused flash with a soft grid, "
        "background intentionally blurred into colorful bokeh, crisp costume detail, "
        "50mm f/1.4, clean composition, magazine-quality event coverage, RAW photo."
    ),
}


def api(ep, path, payload=None, timeout=120):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(ep.rstrip("/") + path, data=data,
                                 headers={"Content-Type": "application/json"} if data else {})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def graph(prefix, text, strength, seed, w, h):
    return {
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": UNET, "weight_dtype": "default"}},
        "2": {"class_type": "CLIPLoader", "inputs": {"clip_name": CLIP, "type": "moss_image"}},
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": VAE}},
        "4": {"class_type": "CLIPTextEncode", "inputs": {"text": text, "clip": ["2", 0]}},
        "5": {"class_type": "CLIPTextEncode", "inputs": {"text": NEG, "clip": ["2", 0]}},
        "6": {"class_type": "EmptyLatentImage", "inputs": {"width": w, "height": h, "batch_size": 1}},
        "10": {"class_type": "LoraLoaderModelOnly",
               "inputs": {"model": ["1", 0], "lora_name": LORA, "strength_model": strength}},
        "7": {"class_type": "KSampler",
              "inputs": {"model": ["10", 0], "seed": seed, "steps": 30, "cfg": 3.0,
                         "sampler_name": "euler", "scheduler": "simple",
                         "positive": ["4", 0], "negative": ["5", 0],
                         "latent_image": ["6", 0], "denoise": 1.0}},
        "8": {"class_type": "VAEDecode", "inputs": {"samples": ["7", 0], "vae": ["3", 0]}},
        "9": {"class_type": "SaveImage", "inputs": {"images": ["8", 0], "filename_prefix": prefix}},
    }


def run(ep, g, outdir, tag, timeout=900):
    pid = api(ep, "/prompt", {"prompt": g})["prompt_id"]
    t0 = time.time()
    while time.time() - t0 < timeout:
        h = api(ep, f"/history/{pid}")
        if pid in h:
            st = h[pid].get("status", {})
            if st.get("status_str") == "error":
                print(tag, "ERROR", json.dumps(st)[:300], flush=True)
                return
            for node in h[pid].get("outputs", {}).values():
                for im in node.get("images", []):
                    q = urllib.parse.urlencode({"filename": im["filename"],
                                                "subfolder": im.get("subfolder", ""),
                                                "type": im.get("type", "output")})
                    raw = urllib.request.urlopen(ep.rstrip("/") + "/view?" + q, timeout=120).read()
                    os.makedirs(outdir, exist_ok=True)
                    p = os.path.join(outdir, tag + ".png")
                    open(p, "wb").write(raw)
                    print(f"{tag} ok {time.time()-t0:.0f}s -> {p}", flush=True)
            return
        time.sleep(2)
    print(tag, "TIMEOUT", flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--endpoint", default="http://127.0.0.1:18188")
    ap.add_argument("--out", default="/tmp/si_cos2")
    ap.add_argument("--seed", type=int, default=20261115)
    ap.add_argument("--size", default="896x1152")
    ap.add_argument("--strength", type=float, default=0.85)
    ap.add_argument("--looks", default="studio,goldenhour,stage")
    a = ap.parse_args()
    w, h = (int(x) for x in a.size.lower().split("x"))
    for name in a.looks.split(","):
        text = LOOKS[name.strip()] + " " + SUBJECT
        run(a.endpoint, graph(f"probe_si/cos2_{name}", text, a.strength, a.seed, w, h),
            a.out, f"cos2_{name}")


if __name__ == "__main__":
    main()
