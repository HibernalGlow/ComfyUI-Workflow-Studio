#!/usr/bin/env python3
"""打样：真人 cosplay 风格的 Si(祀) —— MOSS-Image SFT + si-arknights LoRA。

单变量：只切角色 LoRA 强度，看"写实"与"像不像"的平衡点。
不算正式批次，属 tools/probe_* 打样。

用法: python3 tools/probe_si_cosplay.py --endpoint http://127.0.0.1:18188
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

POS = (
    "RAW photo, candid cosplay photograph at a bright anime convention hall. "
    "A young woman cosplaying Si from Arknights: Endfield stands facing the camera. "
    "She has pale mint-green hair styled in low twin tails with a double bun and a golden "
    "hairband, a small dragon-tail prop at her hip, black feathered wing props on her back, "
    "a white dress with detached sleeves, a bead bracelet, blue socks and black shoes. "
    "Full body shot from head to toe, both feet fully visible standing on the floor, "
    "85mm lens, f/2.8, shallow depth of field, real skin texture with visible pores, "
    "film grain, soft window light, natural colors, looking at viewer, faint tsundere smirk."
)
NEG = (
    "anime, illustration, 3d render, cgi, painting, cel shading, doll, plastic skin, "
    "cropped, out of frame, cut off feet, close-up, six toes, extra limbs, bad anatomy, "
    "worst quality, watermark, text, signature"
)


def api(ep, path, payload=None, timeout=120):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(ep.rstrip("/") + path, data=data,
                                 headers={"Content-Type": "application/json"} if data else {})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def graph(strength, seed, w, h, prefix):
    return {
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": UNET, "weight_dtype": "default"}},
        "2": {"class_type": "CLIPLoader", "inputs": {"clip_name": CLIP, "type": "moss_image"}},
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": VAE}},
        "4": {"class_type": "CLIPTextEncode", "inputs": {"text": POS, "clip": ["2", 0]}},
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
                print(tag, "ERROR", json.dumps(st)[:400], flush=True)
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
    ap.add_argument("--out", default="/tmp/si_cos")
    ap.add_argument("--seed", type=int, default=20261115)
    ap.add_argument("--size", default="896x1152")
    ap.add_argument("--strengths", default="1.0,0.7")
    a = ap.parse_args()
    w, h = (int(x) for x in a.size.lower().split("x"))
    for s in a.strengths.split(","):
        run(a.endpoint, graph(float(s), a.seed, w, h, f"probe_si/cos_s{s}"),
            a.out, f"cos_s{s}")


if __name__ == "__main__":
    main()
