#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""in-context 参考图 A/B：参考图分辨率 + end_percent 对速度的影响。

守的是这个观察：incontext 节点把参考图 latent **拼在 T 轴上** 做自注意力，
而参考图一旦生效，每一步都是 5.2 倍价（实测 6.5 vs 1.25 s/it）。
所以变量只有两个能用（不换注意力内核的前提下）：
    参考图分辨率  → 总 token 数（注意力 ∝ n²）
    end_percent   → 参考图生效的步数占比

三次跑，同一 seed、同一页、同一 LoRA，只改参考图尺寸与 end_percent：
    A  832x1216  end 0.85   ← 改前
    B  512x768   end 0.85   ← 只降分辨率（隔离变量）
    C  512x768   end 0.70   ← 再压低参考生效步数

用的图：拉菲II LF042 的真实配方（kirazuri v4 + anima-incontext LoRA + atdan 0.8）。
"""
import json, os, statistics, sys, time, urllib.request, urllib.parse
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import vram

HOST = "127.0.0.1:8188"
OUT = "/tmp/luoqian/incontext_ab"
os.makedirs(OUT, exist_ok=True)

REF_DIR = Path("/Users/glow/Base/Works/ComfyUI/Workflows/wild/storyboard/碧蓝航线_拉菲II/incontext")
REF1 = "laffey_ref_official_body.png"
REF2 = "laffey_ref_face.png"

UNET = "kirazuriAnima_v40\\anima-kirazuri-v4-int8-convrot.safetensors"
LORA = "anima\\anima-incontext-character.safetensors"
LORA2 = "anima\\artist\\260924\\atdan_anima_v1.0_dim64@atdan.safetensors"
CLIP = "qwen_3_06b_base.safetensors"
VAE = "qwen_image_vae.safetensors"
W, H = 832, 1216
SEED = 424284          # 与 their seed_base 424242 + 42 一致

POS = ("@atdan (masterpiece:1.2), (best quality:1.2), aesthetic, highly detailed, safe\n\n"
       "1girl, solo, laffey ii (azur lane), azur lane, black kimono, obi, sash, wide sleeves, "
       "pelvic curtain, thigh strap, tassel, mask on head, rabbit hair ornament, pom pom (clothes), "
       "clog sandals, black hairband, choker, stirrup legwear, white stirrup leggings, "
       "white pantyhose, white bridal gauntlets, white elbow gloves, seams, shiny, "
       "sitting, from front, looking at viewer\n\n"
       "She sits relaxed on a tatami mat, wearing a black kimono with a pale tan lining and wide "
       "sleeves; the obi is a dark patterned sash with a small rabbit charm. White stirrup legwear "
       "with fluffy leg rings covers both legs, her toes bare in clog sandals. A round white rabbit "
       "mask with dot eyes rests tilted on top of her head beside a small gold bow.")
NEG = ("worst quality, low quality, bad anatomy, bad hands, missing fingers, extra digit, fewer digits, "
       "watermark, text, frame, dutch angle, logo, signature, artist name, jpeg artifacts, censored, "
       "bad feet, distorted face, blurry face, extra limbs, disconnected limbs, chibi, duplicate, "
       "multiple girls, stuffed animal, plushie, rabbit plush, toy, grey background, white background, "
       "simple background, fox mask, kitsune mask")

RUNS = [
    ("A_832x1216_end0.85", 832, 1216, 0.85),
    ("B_512x768_end0.85", 512, 768, 0.85),
    ("C_512x768_end0.70", 512, 768, 0.70),
]


def graph(rw, rh, endp, seed, prefix):
    g = {
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": UNET, "weight_dtype": "default"}},
        "2": {"class_type": "LoraLoaderModelOnly", "inputs": {
            "model": ["1", 0], "lora_name": LORA, "strength_model": 1.0}},
        "3": {"class_type": "LoraLoaderModelOnly", "inputs": {
            "model": ["2", 0], "lora_name": LORA2, "strength_model": 0.8}},
        "10": {"class_type": "LoadImage", "inputs": {"image": REF1}},
        "11": {"class_type": "LoadImage", "inputs": {"image": REF2}},
        "12": {"class_type": "VAELoader", "inputs": {"vae_name": VAE}},
        "13": {"class_type": "AnimaRefEncode", "inputs": {
            "vae": ["12", 0], "image": ["10", 0], "target_width": rw, "target_height": rh}},
        "14": {"class_type": "AnimaRefEncode", "inputs": {
            "vae": ["12", 0], "image": ["11", 0], "target_width": rw, "target_height": rh}},
        "15": {"class_type": "AnimaRefLatentBatch", "inputs": {
            "ref_latent_1": ["13", 0], "ref_latent_2": ["14", 0], "fit_mode": "pad"}},
        "20": {"class_type": "AnimaInContextApply", "inputs": {
            "model": ["3", 0], "ref_latent": ["15", 0],
            "strength": 1.0, "start_percent": 0.0, "end_percent": endp,
            "cond_only": True, "fit_mode": "pad", "ref_timestep": 0.0}},
        "4": {"class_type": "CLIPLoader", "inputs": {
            "clip_name": CLIP, "type": "stable_diffusion", "device": "cpu"}},
        "30": {"class_type": "CLIPTextEncode", "inputs": {"text": POS, "clip": ["4", 0]}},
        "31": {"class_type": "CLIPTextEncode", "inputs": {"text": NEG, "clip": ["4", 0]}},
        "40": {"class_type": "EmptyLatentImage", "inputs": {"width": W, "height": H, "batch_size": 1}},
        "41": {"class_type": "KSampler", "inputs": {
            "model": ["20", 0], "positive": ["30", 0], "negative": ["31", 0],
            "latent_image": ["40", 0], "seed": seed, "steps": 17, "cfg": 1.6,
            "sampler_name": "dpmpp_2m_sde_gpu", "scheduler": "beta57", "denoise": 1.0}},
        "50": {"class_type": "VAEDecode", "inputs": {"samples": ["41", 0], "vae": ["12", 0]}},
        "60": {
            "class_type": "LayerUtility: SaveImagePlus",
            "inputs": {
                "images": ["50", 0],
                "custom_path": "",
                "filename_prefix": prefix,
                "timestamp": "None",
                "format": "png",
                "quality": 100,
                "meta_data": True,
                "blind_watermark": "",
                "save_workflow_as_json": True,
                "preview": True
            }
        },
    }
    return g


def post(p, d):
    r = urllib.request.Request(f"http://{HOST}{p}", data=json.dumps(d).encode(),
                               headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(r, timeout=120) as resp:
        return json.loads(resp.read().decode())


def run(label, rw, rh, endp, seed):
    prefix = f"ICAB/{label}"
    g = graph(rw, rh, endp, seed, prefix)
    payload = {
        "prompt": g,
        "client_id": "icab",
        "extra_data": {
            "extra_pnginfo": {
                "workflow": g
            }
        }
    }
    pid = post("/prompt", payload)["prompt_id"]
    lo, t0 = None, time.time()
    while True:
        time.sleep(1.0)
        v = vram.vram_free_mib(HOST, timeout=10)
        if v is not None:
            lo = v if lo is None else min(lo, v)
        try:
            d = json.loads(urllib.request.urlopen(f"http://{HOST}/history/{pid}", timeout=60).read().decode()).get(pid)
        except Exception:
            d = None
        if d and d.get("status", {}).get("completed"):
            m = d["status"].get("messages", [])
            a = next((x[1]["timestamp"] for x in m if x[0] == "execution_start"), None)
            b = next((x[1]["timestamp"] for x in m if x[0] == "execution_success"), None)
            imgs = [i for vv in d.get("outputs", {}).values() for i in vv.get("images", [])]
            sec = (b - a) / 1000.0 if (a and b) else (time.time() - t0)
            for im in imgs:
                q = urllib.parse.urlencode({"filename": im["filename"],
                                            "subfolder": im.get("subfolder", ""), "type": "output"})
                with urllib.request.urlopen(f"http://{HOST}/view?{q}", timeout=180) as r, \
                        open(f"{OUT}/{label}.png", "wb") as f:
                    f.write(r.read())
            return sec, lo
        if time.time() - t0 > 1200:
            raise TimeoutError(label)


def main():
    print(f"起始空闲显存 {vram.vram_free_mib(HOST)} MiB\n")
    rows = []
    for label, rw, rh, endp in RUNS:
        try:
            sec, lo = run(label, rw, rh, endp, SEED)
            rows.append((label, sec, lo, rw, rh, endp))
            ref_tok = (rw // 8) * (rh // 8) * 2
            gen_tok = (W // 8) * (H // 8)
            print(f"  {label:<22} {sec:6.1f}s   最低空闲 {lo} MiB   "
                  f"token {gen_tok}+{ref_tok}={gen_tok + ref_tok}   end={endp}", flush=True)
        except Exception as e:
            print(f"  {label}: ❌ {type(e).__name__} {e}", flush=True)

    print()
    if len(rows) >= 2:
        base = rows[0]
        print("  对比基准 A（832x1216 / end 0.85）：")
        for label, sec, lo, rw, rh, endp in rows[1:]:
            print(f"    {label:<22} {sec:6.1f}s   {(sec/base[1]-1)*100:+.0f}%  （省 {base[1]-sec:.1f}s）")
    print(f"\n图在 {OUT}/")


if __name__ == "__main__":
    main()
