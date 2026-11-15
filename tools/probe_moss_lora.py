#!/usr/bin/env python3
"""MOSS-Image LoRA 单变量打样探针（非正式批次，仅用于验收 LoRA 是否生效）。

用法:
    python3 tools/probe_moss_lora.py --endpoint http://127.0.0.1:18188 \
        --out /tmp/moss_probe [--seed 12345] [--lora "moss\\Munji_MOSSV1.safetensors:@muji_style"] ...

对同一 seed/尺寸/采样，跑 baseline(无 LoRA) 与每个 LoRA 各一张，便于 A/B 对照。
MOSS 推荐参数: euler + simple, 30 steps, CFG 3, 约 1M 像素 (896x1152)。
"""
import argparse
import json
import os
import sys
import time
import urllib.parse
import urllib.request

DEFAULT_UNET = "moss-image-base-dit-int8-convrot.safetensors"
DEFAULT_CLIP = "qwen3.5_9b_w4a8_gptq.safetensors"
DEFAULT_VAE = "flux2-vae_small.safetensors"
CLIP_TYPE = "moss_image"

NEG = ("nsfw, worst quality, bad anatomy, watermark, jpeg artifact, "
       "blush, embarrassed, overexposure, warm lighting")
# 中性主体：让风格差异而不是构图差异主导观感
SUBJECT = ("1girl, solo, long black hair, white shirt, standing in a sunlit classroom, "
           "window, wooden desks, looking at viewer")


def api(endpoint, path, payload=None, timeout=120):
    url = endpoint.rstrip("/") + path
    data = None
    headers = {}
    if payload is not None:
        data = json.dumps(payload).encode()
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def build(prompt, negative, lora, seed, steps, cfg, width, height, prefix):
    g = {
        "1": {"class_type": "UNETLoader",
              "inputs": {"unet_name": DEFAULT_UNET, "weight_dtype": "default"}},
        "2": {"class_type": "CLIPLoader",
              "inputs": {"clip_name": DEFAULT_CLIP, "type": CLIP_TYPE}},
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": DEFAULT_VAE}},
        "4": {"class_type": "CLIPTextEncode",
              "inputs": {"text": prompt, "clip": ["2", 0]}},
        "5": {"class_type": "CLIPTextEncode",
              "inputs": {"text": negative, "clip": ["2", 0]}},
        "6": {"class_type": "EmptyLatentImage",
              "inputs": {"width": width, "height": height, "batch_size": 1}},
        "7": {"class_type": "KSampler",
              "inputs": {"model": ["1", 0], "seed": seed, "steps": steps,
                         "cfg": cfg, "sampler_name": "euler", "scheduler": "simple",
                         "positive": ["4", 0], "negative": ["5", 0],
                         "latent_image": ["6", 0], "denoise": 1.0}},
        "8": {"class_type": "VAEDecode",
              "inputs": {"samples": ["7", 0], "vae": ["3", 0]}},
        "9": {"class_type": "SaveImage",
              "inputs": {"images": ["8", 0], "filename_prefix": prefix}},
    }
    if lora:
        g["10"] = {"class_type": "LoraLoader",
                   "inputs": {"model": ["1", 0], "clip": ["2", 0],
                              "lora_name": lora, "strength_model": 1.0,
                              "strength_clip": 1.0}}
        g["7"]["inputs"]["model"] = ["10", 0]
        g["4"]["inputs"]["clip"] = ["10", 1]
        g["5"]["inputs"]["clip"] = ["10", 1]
    return g


def run(endpoint, graph, outdir, tag, timeout=900):
    pid = api(endpoint, "/prompt", {"prompt": graph})["prompt_id"]
    print(f"[{tag}] queued {pid}", flush=True)
    t0 = time.time()
    while time.time() - t0 < timeout:
        h = api(endpoint, f"/history/{pid}")
        if pid in h:
            entry = h[pid]
            status = entry.get("status", {})
            if status.get("status_str") == "error":
                print(json.dumps(status, ensure_ascii=False)[:1500])
                return []
            saved = []
            for node in entry.get("outputs", {}).values():
                for im in node.get("images", []):
                    q = urllib.parse.urlencode({"filename": im["filename"],
                                                "subfolder": im.get("subfolder", ""),
                                                "type": im.get("type", "output")})
                    raw = urllib.request.urlopen(
                        endpoint.rstrip("/") + "/view?" + q, timeout=120).read()
                    os.makedirs(outdir, exist_ok=True)
                    path = os.path.join(outdir, f"{tag}.png")
                    with open(path, "wb") as f:
                        f.write(raw)
                    saved.append(path)
            print(f"[{tag}] done in {time.time()-t0:.0f}s -> {saved}", flush=True)
            return saved
        time.sleep(2)
    print(f"[{tag}] TIMEOUT", flush=True)
    return []


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--endpoint", default="http://127.0.0.1:18188")
    ap.add_argument("--out", default="/tmp/moss_probe")
    ap.add_argument("--seed", type=int, default=20261115)
    ap.add_argument("--steps", type=int, default=30)
    ap.add_argument("--cfg", type=float, default=3.0)
    ap.add_argument("--width", type=int, default=896)
    ap.add_argument("--height", type=int, default=1152)
    ap.add_argument("--lora", action="append", default=[],
                    help="lora_name:trigger, 可多次给出; 不给则只跑 baseline")
    args = ap.parse_args()

    jobs = [("baseline", None, SUBJECT)]
    for spec in args.lora:
        name, _, trig = spec.partition(":")
        jobs.append((os.path.splitext(os.path.basename(name))[0].replace("\\", "_"),
                     name, f"best quality, highres, {trig}, {SUBJECT}" if trig
                     else f"best quality, highres, {SUBJECT}"))

    ok = []
    for tag, lora, pos in jobs:
        g = build(pos, NEG, lora, args.seed, args.steps, args.cfg,
                  args.width, args.height, f"probe_moss/{tag}")
        ok += run(args.endpoint, g, args.out, tag)
    print("saved:", ok)
    return 0 if len(ok) == len(jobs) else 1


if __name__ == "__main__":
    sys.exit(main())
