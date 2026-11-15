#!/usr/bin/env python3
"""Three Si character LoRAs x two MOSS checkpoints, LOOM style fixed.

单变量打样：同一 seed / 提示词 / 采样，只切 character LoRA 与底模。
LOOM style 固定 0.6，character 固定 1.0。

用法: python3 tools/probe_si_compare.py --endpoint http://127.0.0.1:18188
"""
import argparse
import json
import os
import time
import urllib.parse
import urllib.request

BASES = {
    "base": "moss-image-base-dit-int8-convrot.safetensors",
    "sft": "moss_image_sft_int8_convrot.safetensors",
}

CHARAS = [
    ("A", "moss\\chara\\endfield\\si_mossbase_r32_muon_e20_20261027_e19.safetensors", "Si"),
    ("B", "moss\\chara\\endfield\\si_moss_uma_v1.safetensors", "祀（明日方舟）"),
    ("C", "moss\\chara\\endfield\\si-arknights.safetensors", ""),
]

LOOM = "moss\\artist\\261115\\zhibuji_loom_style_moss_uma_v1.safetensors"

TAGS = ("1girl, solo, low twintails, double bun, eastern dragon tail, black detached wings, "
        "golden hairband, white dress, detached sleeves, bead bracelet, earrings, blue socks, "
        "thigh strap, black shoes, standing, looking at viewer, cherry blossoms, full body")

NEG = ("worst quality, low quality, bad anatomy, extra limbs, extra digits, missing fingers, "
       "watermark, signature, text, jpeg artifact, overexposure")


def api(endpoint, path, payload=None, timeout=120):
    url = endpoint.rstrip("/") + path
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data,
                                 headers={"Content-Type": "application/json"} if data else {})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def graph(base, chara, trigger, seed, steps, cfg, w, h, prefix):
    pos = "best quality, highres, " + (trigger + ", " if trigger else "") + TAGS
    g = {
        "1": {"class_type": "UNETLoader",
              "inputs": {"unet_name": base, "weight_dtype": "default"}},
        "2": {"class_type": "CLIPLoader",
              "inputs": {"clip_name": "qwen3.5_9b_w4a8_gptq.safetensors", "type": "moss_image"}},
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": "flux2-vae_small.safetensors"}},
        "4": {"class_type": "CLIPTextEncode", "inputs": {"text": pos, "clip": ["2", 0]}},
        "5": {"class_type": "CLIPTextEncode", "inputs": {"text": NEG, "clip": ["2", 0]}},
        "6": {"class_type": "EmptyLatentImage",
              "inputs": {"width": w, "height": h, "batch_size": 1}},
        "10": {"class_type": "LoraLoaderModelOnly",
               "inputs": {"model": ["1", 0], "lora_name": chara, "strength_model": 1.0}},
        "11": {"class_type": "LoraLoaderModelOnly",
               "inputs": {"model": ["10", 0], "lora_name": LOOM, "strength_model": 0.6}},
        "7": {"class_type": "KSampler",
              "inputs": {"model": ["11", 0], "seed": seed, "steps": steps, "cfg": cfg,
                         "sampler_name": "euler", "scheduler": "simple",
                         "positive": ["4", 0], "negative": ["5", 0],
                         "latent_image": ["6", 0], "denoise": 1.0}},
        "8": {"class_type": "VAEDecode", "inputs": {"samples": ["7", 0], "vae": ["3", 0]}},
        "9": {"class_type": "SaveImage",
              "inputs": {"images": ["8", 0], "filename_prefix": prefix}},
    }
    return g


def run(endpoint, g, outdir, tag, timeout=900):
    pid = api(endpoint, "/prompt", {"prompt": g})["prompt_id"]
    t0 = time.time()
    while time.time() - t0 < timeout:
        h = api(endpoint, f"/history/{pid}")
        if pid in h:
            st = h[pid].get("status", {})
            if st.get("status_str") == "error":
                print(tag, "ERROR", json.dumps(st)[:400], flush=True)
                return None
            saved = []
            for node in h[pid].get("outputs", {}).values():
                for im in node.get("images", []):
                    q = urllib.parse.urlencode({"filename": im["filename"],
                                                "subfolder": im.get("subfolder", ""),
                                                "type": im.get("type", "output")})
                    raw = urllib.request.urlopen(endpoint.rstrip("/") + "/view?" + q,
                                                 timeout=120).read()
                    os.makedirs(outdir, exist_ok=True)
                    p = os.path.join(outdir, f"{tag}.png")
                    open(p, "wb").write(raw)
                    saved.append(p)
            print(f"{tag} ok {time.time()-t0:.0f}s -> {saved}", flush=True)
            return saved
        time.sleep(2)
    print(tag, "TIMEOUT", flush=True)
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--endpoint", default="http://127.0.0.1:18188")
    ap.add_argument("--out", default="/tmp/si_probe")
    ap.add_argument("--seed", type=int, default=20261115)
    ap.add_argument("--steps", type=int, default=30)
    ap.add_argument("--cfg", type=float, default=3.0)
    ap.add_argument("--size", default="1024x1024")
    ap.add_argument("--bases", default="base,sft")
    args = ap.parse_args()
    w, h = (int(x) for x in args.size.lower().split("x"))

    for bkey in args.bases.split(","):
        base = BASES[bkey.strip()]
        for tag, lora, trig in CHARAS:
            g = graph(base, lora, trig, args.seed, args.steps, args.cfg, w, h,
                      f"probe_si/{bkey}_{tag}")
            run(args.endpoint, g, args.out, f"{bkey}_{tag}")


if __name__ == "__main__":
    main()
