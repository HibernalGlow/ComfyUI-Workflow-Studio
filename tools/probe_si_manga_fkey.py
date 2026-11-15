#!/usr/bin/env python3
"""打样：祀 × 管理员 的傲娇小故事 —— 3 格漫画页，fkey 画风。

组合：Base int8（分离 q/k/v，fkey 与 Si-UMA 都全量生效）+ si_moss_uma_v1 + fkey 0.6
单变量：只跑一张，验证版面/文字/服装。

用法: python3 tools/probe_si_manga_fkey.py --endpoint http://127.0.0.1:18188
"""
import argparse
import json
import os
import time
import urllib.parse
import urllib.request

UNET = "moss-image-base-dit-int8-convrot.safetensors"
CLIP = "qwen3.5_9b_w4a8_gptq.safetensors"
VAE = "flux2-vae_small.safetensors"
CHAR = "moss\\chara\\endfield\\si_moss_uma_v1.safetensors"
FKEY = "moss\\MOSS_fkey-lora-r4-muon-step6840-comfy.safetensors"
FKEY_TOKEN = "<|artist|>fkey<|/artist|>"

NEG = (
    "worst quality, low quality, bad anatomy, extra limbs, extra fingers, six toes, "
    "watermark, signature, jpeg artifact, overexposure, blurry, text artifacts, "
    "english text, garbled letters"
)


def api(ep, path, payload=None, timeout=180):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(ep.rstrip("/") + path, data=data,
                                 headers={"Content-Type": "application/json"} if data else {})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def graph(prompt, seed, w, h, prefix, char_s=0.9, fkey_s=0.6):
    return {
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": UNET, "weight_dtype": "default"}},
        "2": {"class_type": "CLIPLoader", "inputs": {"clip_name": CLIP, "type": "moss_image"}},
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": VAE}},
        "4": {"class_type": "CLIPTextEncode", "inputs": {"text": prompt, "clip": ["2", 0]}},
        "5": {"class_type": "CLIPTextEncode", "inputs": {"text": NEG, "clip": ["2", 0]}},
        "6": {"class_type": "EmptyLatentImage", "inputs": {"width": w, "height": h, "batch_size": 1}},
        "10": {"class_type": "LoraLoaderModelOnly",
               "inputs": {"model": ["1", 0], "lora_name": CHAR, "strength_model": char_s}},
        "11": {"class_type": "LoraLoaderModelOnly",
               "inputs": {"model": ["10", 0], "lora_name": FKEY, "strength_model": fkey_s}},
        "7": {"class_type": "KSampler",
              "inputs": {"model": ["11", 0], "seed": seed, "steps": 28, "cfg": 3.3,
                         "sampler_name": "euler", "scheduler": "sgm_uniform",
                         "positive": ["4", 0], "negative": ["5", 0],
                         "latent_image": ["6", 0], "denoise": 1.0}},
        "8": {"class_type": "VAEDecode", "inputs": {"samples": ["7", 0], "vae": ["3", 0]}},
        "9": {"class_type": "SaveImage", "inputs": {"images": ["8", 0], "filename_prefix": prefix}},
    }


def run(ep, g, outdir, tag, timeout=1200):
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
                    raw = urllib.request.urlopen(ep.rstrip("/") + "/view?" + q, timeout=180).read()
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
    ap.add_argument("--out", default="/tmp/si_manga")
    ap.add_argument("--prompt-file", default="/tmp/manga_si/draft.prompt")
    ap.add_argument("--seed", type=int, default=20261115)
    ap.add_argument("--size", default="1024x1536")
    ap.add_argument("--char-strength", type=float, default=0.9)
    ap.add_argument("--fkey-strength", type=float, default=0.6)
    a = ap.parse_args()
    w, h = (int(x) for x in a.size.lower().split("x"))
    layout = json.load(open(a.prompt_file))
    if isinstance(layout, str):
        layout = json.loads(layout)
    prompt = FKEY_TOKEN + "\n" + json.dumps(layout, ensure_ascii=False)
    g = graph(prompt, a.seed, w, h, "probe_si/manga_fkey", a.char_strength, a.fkey_strength)
    run(a.endpoint, g, a.out, "manga_fkey")


if __name__ == "__main__":
    main()
