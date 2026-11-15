#!/usr/bin/env python3
"""MOSS-Image 单张打样探针（AGENTS.md 允许的一次性打样例外）。

用途：验证 FFF_MOSS-Alba / MOSS-Image-Base 在 8GB 显卡上能否正常出图。
不产出正式页，结论回灌 batch.toml 或 workflow 资产。
用法：python3 tools/probe_moss.py [fff|base-int8|base-int4]
"""
import json, sys, time, urllib.request, uuid

HOST = "http://127.0.0.1:8188"
VARIANTS = {
    "fff":       ("FFF_MOSS-Alba-v1.1_int8_convrot.safetensors", "moss\\FFF_MOSS-Alba-v1.1_int8_convrot.safetensors"),
    "base-int8": ("moss-image-base-dit-int8-convrot.safetensors", "moss-image-base-dit-int8-convrot.safetensors"),
    "base-int4": ("moss-image-base-dit-int4-convrot.safetensors", "moss-image-base-dit-int4-convrot.safetensors"),
}
TE = "qwen3.5_9b_w4a8_gptq.safetensors"
VAE = "flux2-vae_small.safetensors"

def build(variant, w=1024, h=1024, steps=25):
    p = {
      "1": {"class_type": "UNETLoader", "inputs": {"unet_name": variant[1], "weight_dtype": "default"}},
      "2": {"class_type": "CLIPLoader", "inputs": {"clip_name": TE, "type": "moss_image", "device": "default"}},
      "3": {"class_type": "VAELoader", "inputs": {"vae_name": VAE}},
      "4": {"class_type": "CLIPTextEncode", "inputs": {"text": "1girl, solo, long black hair, school uniform, classroom, best quality, highres", "clip": ["2", 0]}},
      "5": {"class_type": "CLIPTextEncode", "inputs": {"text": "nsfw, worst quality, bad anatomy, watermark, jpeg artifact, blush, embarrassed, overexposure, warm lighting", "clip": ["2", 0]}},
      "6": {"class_type": "EmptyFlux2LatentImage", "inputs": {"width": w, "height": h, "batch_size": 1}},
      "15": {"class_type": "ModelSamplingSD3", "inputs": {"shift": 5, "model": ["1", 0]}},
      "16": {"class_type": "KSampler", "inputs": {"seed": 42, "steps": steps, "cfg": 3.0, "sampler_name": "euler", "scheduler": "sgm_uniform", "denoise": 1.0, "model": ["15", 0], "positive": ["4", 0], "negative": ["5", 0], "latent_image": ["6", 0]}},
      "17": {"class_type": "VAEDecode", "inputs": {"samples": ["16", 0], "vae": ["3", 0]}},
      "18": {"class_type": "SaveImage", "inputs": {"filename_prefix": "probe_moss_" + variant[0].split('.')[0], "images": ["17", 0]}},
    }
    return p

def main():
    key = sys.argv[1] if len(sys.argv) > 1 else "fff"
    var = VARIANTS[key]
    prompt = build(var)
    req = urllib.request.Request(HOST + "/prompt", data=json.dumps({"prompt": prompt, "client_id": str(uuid.uuid4())}).encode(),
                                 headers={"Content-Type": "application/json"})
    t0 = time.time()
    try:
        r = json.load(urllib.request.urlopen(req, timeout=300))
    except urllib.error.HTTPError as e:
        print("HTTP", e.code, e.read().decode()[:2000]); return 1
    pid = r["prompt_id"]
    print(f"queued prompt_id={pid} variant={key} t0={time.strftime('%H:%M:%S')}", flush=True)
    deadline = time.time() + 1800
    while time.time() < deadline:
        time.sleep(5)
        try:
            h = json.load(urllib.request.urlopen(f"{HOST}/history/{pid}", timeout=20))
        except Exception:
            continue
        if pid in h:
            st = h[pid].get("status", {})
            print(f"elapsed={time.time()-t0:.1f}s status={st.get('status_str')} completed={st.get('completed')}", flush=True)
            for m in st.get("messages", [])[-6:]:
                print("  msg", json.dumps(m)[:300], flush=True)
            for node, out in h[pid].get("outputs", {}).items():
                print("  out", node, json.dumps(out)[:300], flush=True)
            return 0
    print("TIMEOUT"); return 1

if __name__ == "__main__":
    sys.exit(main())
