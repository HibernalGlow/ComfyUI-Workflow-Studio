#!/usr/bin/env python3
"""One-off Fkey/SFT clothing-edit probe for Nangong Yu and Raiden Shogun.

The only intentional edit is hosiery: preserve each character's original
stocking color, height, trim and overall style, then convert it to stirrup
stockings with the heel and toes exposed.  All other clothing is explicitly
kept unchanged.
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
LORA = r"moss\MOSS_fkey-lora-r4-muon-step6840-comfy.safetensors"
WIDTH = 1088
HEIGHT = 1440

COMMON_STYLE = (
    "Ultra-polished, high-completion commercial 2D anime illustration, character duality "
    "split-composition on a clean pastel-blue and warm cream gradient background. Crisp, "
    "refined delicate lineart, smooth seamless skin shading with luminous specular highlights, "
    "silky hair strands, intricate garment seams and restrained fabric sheen, fully finished "
    "studio masterpiece with zero rough brushstrokes and zero sketch lines. Soft bright indoor "
    "daylight, 1girl, multiple views, same character in two states, tall slender young adult "
    "woman, 7.5-head-tall proportions, safe, wholesome."
)

PROMPTS = {
    "nangong_yu": (
        "Nangong Yu from Zenless Zone Zero, nangong yu, aqua hair with black and pink-green "
        "streaks, crossed bangs, blue eyes, star-shaped pupils, glowing green halo, original "
        "black dress and black skirt, original black thigh-high stockings.\n"
        "<|left_close_up|>Occupying the left half in a large waist-up close-up: Nangong Yu "
        "looks toward the viewer with a calm, slightly enigmatic smile. Keep her aqua-black "
        "multicolored hair, crossed bangs, blue eyes, star-shaped pupils and green halo. Keep "
        "the original black shirt, black dress and black skirt exactly as designed. The only "
        "wardrobe change is her original black thigh-high stockings converted into black stirrup "
        "stockings: preserve the same matte-black color, height and trim, with a clean opening "
        "under the heel and open toes. Do not redesign any other garment.<|/left_close_up|>\n"
        "<|right_full_body|>On the right in a smaller full-body view, the exact same Nangong Yu "
        "stands on a softly lit Amphoreus stage with the green halo floating above her hair. "
        "Keep every original garment, silhouette, color and accessory unchanged: black dress, "
        "black skirt, shirt and black shoes. Show only the controlled hosiery edit: the same "
        "black thigh-high stockings now have a stirrup construction with the heel and toes "
        "exposed, while the stocking height and style remain unchanged. Keep the background "
        "airy and low-detail so the clean linework, smooth skin and fine hair highlights remain "
        "the focus.<|/right_full_body|>"
    ),
    "raiden_shogun": (
        "Raiden Shogun from Genshin Impact, raiden shogun \\(genshin impact\\), long purple "
        "hair, purple eyes, violet makeup, elegant Japanese features, original purple kimono, "
        "white wide sleeves, black bodysuit, red and purple sash, purple thigh-high stockings, "
        "tomoe crest and sword.\n"
        "<|left_close_up|>Occupying the left half in a large waist-up close-up: Raiden Shogun "
        "looks toward the viewer with a composed, regal expression. Keep her long purple hair, "
        "purple eyes, violet makeup, purple kimono, white sleeves, black bodysuit, red-purple "
        "sash and tomoe details exactly as designed. The only wardrobe change is her original "
        "purple thigh-high stockings converted into purple stirrup stockings: preserve the same "
        "purple color, height, decorative trim and silhouette, with a clean opening under the "
        "heel and open toes. Do not redesign or replace any other clothing.<|/left_close_up|>\n"
        "<|right_full_body|>On the right in a smaller full-body view, the exact same Raiden Shogun "
        "stands in a quiet Inazuma shrine garden with her sword at her side. Keep every original "
        "garment and accessory unchanged: purple kimono, white sleeves, black bodysuit, red-purple "
        "sash, hair ornament and sword. Show only the controlled hosiery edit: the same purple "
        "thigh-high stockings now use a stirrup construction with the heel and toes exposed, "
        "while the color, height and style stay unchanged. Keep the scene airy and low-detail "
        "so the polished linework, hair strands and fabric sheen remain the focus.<|/right_full_body|>"
    ),
    "phoebe": (
        "Phoebe from Wuthering Waves, phoebe \\(wuthering waves\\), very long blonde hair, "
        "sidelocks, parted bangs, purple eyes, pointed ears, white wide-brimmed sun hat, black "
        "bow, blue gem, blue sash, white frilled shirt, high-waisted white skirt, blue scarf, "
        "white thigh-high stockings and white gloves, high heels, holding a staff.\n"
        "<|left_close_up|>Occupying the left half in a large waist-up close-up: Phoebe smiles "
        "gently toward the viewer under her large white sun hat. Keep her long blonde hair, "
        "sidelocks, parted bangs, purple eyes, black bow, blue gem, blue sash, white frilled "
        "shirt and blue scarf exactly as designed. The only wardrobe change is her original "
        "white thigh-high stockings converted into white stirrup stockings: preserve the same "
        "white color, height, smooth finish and any existing trim, with a clean opening under "
        "the heel and open toes. Do not redesign any other garment.<|/left_close_up|>\n"
        "<|right_full_body|>On the right in a smaller full-body view, the exact same Phoebe stands "
        "on a bright white-stone terrace with her staff. Keep every original garment and accessory "
        "unchanged: white hat, black bow, white frilled shirt, blue scarf, blue sash, high-waisted "
        "white skirt, white gloves and high heels. Show only the controlled hosiery edit: the same "
        "white thigh-high stockings now use a stirrup construction with the heel and toes exposed, "
        "while the color, height and style stay unchanged. Keep the background airy and low-detail "
        "so the polished linework, fine hair strands and soft white fabric sheen remain the focus." 
        "<|/right_full_body|>"
    ),
    "shamare": (
        "Shamare from Arknights, shamare \\(arknights\\), very long messy pink hair, skull hair "
        "ornament, fox ears, luminous purple eyes, pale skin, large fluffy pink fox tail, original "
        "white long-sleeved shirt, purple suspender dress and glossy white pantyhose.\n"
        "<|left_close_up|>Occupying the left half in a large waist-up close-up: Shamare looks "
        "quietly toward the viewer with her skull hair ornament and fox ears clearly visible. Keep "
        "her long messy pink hair, purple eyes, pale skin, white shirt, purple suspender dress and "
        "pink fox-tail identity exactly as designed. The only wardrobe change is her original glossy "
        "white pantyhose converted into glossy white stirrup stockings: preserve the same white "
        "color, smooth sheen, height and seam style, with a clean opening under the heel and open "
        "toes. Do not redesign any other garment.<|/left_close_up|>\n"
        "<|right_full_body|>On the right in a smaller full-body view, the exact same Shamare stands "
        "in a quiet Rhodes Island garden with her fluffy pink tail curling behind her. Keep every "
        "original garment and accessory unchanged: white long-sleeved shirt, purple suspender dress, "
        "skull ornament, fox ears and pink tail. Show only the controlled hosiery edit: the same "
        "glossy white pantyhose now use a stirrup construction with the heel and toes exposed, "
        "while the color, height and style stay unchanged. Keep the scene airy and low-detail so "
        "the polished linework, soft skin rendering, hair strands and fabric sheen remain the focus."
        "<|/right_full_body|>"
    ),
}

NEGATIVE = (
    "nsfw, nude, naked, cleavage, underwear, bra, panties, sexual, unfinished, unpolished, "
    "rough brushwork, visible brushstrokes, gouache, watercolor bleed, impasto, sketch, "
    "rough sketch, draft, wip, messy lines, loose lines, uncolored patches, flat shading, "
    "blurry edges, smudged, photorealistic, real human, 3d render, cgi, photograph, monochrome, "
    "greyscale, screentones, camera flash, microscopic pores, film grain, blotchy skin, vector art, "
    "plastic skin, thick black outlines, child, loli, cosplay, wig, outfit redesign, costume change, "
    "different clothes, mismatched stocking colors, opaque full-foot stockings, closed heel socks, "
    "blurry, out of focus, lowres, ugly face, distorted face, worst quality, bad anatomy, fused bodies, "
    "fused legs, extra limbs, extra arms, extra legs, extra hands, extra fingers, six fingers, "
    "malformed hands, watermark, text, signature"
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


def graph(name: str, seed: int):
    positive = "<|artist|>fkey<|/artist|>\n<|style_and_aesthetic|>" + COMMON_STYLE + "<|/style_and_aesthetic|>\n" + PROMPTS[name]
    return {
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": UNET, "weight_dtype": "default"}},
        "2": {"class_type": "CLIPLoader", "inputs": {"clip_name": TE, "type": "moss_image"}},
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": VAE}},
        "4": {"class_type": "CLIPTextEncode", "inputs": {"text": positive, "clip": ["2", 0]}},
        "5": {"class_type": "CLIPTextEncode", "inputs": {"text": NEGATIVE, "clip": ["2", 0]}},
        "6": {"class_type": "EmptyLatentImage", "inputs": {"width": WIDTH, "height": HEIGHT, "batch_size": 1}},
        "10": {"class_type": "LoraLoaderModelOnly", "inputs": {"model": ["1", 0], "lora_name": LORA, "strength_model": 0.6}},
        "7": {"class_type": "KSampler", "inputs": {
            "seed": seed, "steps": 28, "cfg": 3.3, "sampler_name": "euler", "scheduler": "sgm_uniform",
            "denoise": 1.0, "model": ["10", 0], "positive": ["4", 0], "negative": ["5", 0], "latent_image": ["6", 0]}},
        "8": {"class_type": "VAEDecode", "inputs": {"samples": ["7", 0], "vae": ["3", 0]}},
        "9": {"class_type": "SaveImage", "inputs": {"images": ["8", 0], "filename_prefix": f"moss-probe/fkey_{name}_stirrup"}},
    }


def run(name: str, seed: int):
    try:
        queued = api("/prompt", {"prompt": graph(name, seed), "client_id": str(uuid.uuid4())})
    except urllib.error.HTTPError as e:
        print("HTTP", e.code, e.read().decode(errors="replace")[:4000])
        return 1
    pid = queued["prompt_id"]
    print(f"queued {pid} -> {name}", flush=True)
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
            print("out", node, json.dumps(out, ensure_ascii=False)[:2000], flush=True)
        return 0 if status.get("status_str") == "success" else 1
    print("TIMEOUT", name)
    return 1


def main() -> int:
    names = [sys.argv[1]] if len(sys.argv) > 1 and sys.argv[1] != "all" else list(PROMPTS)
    bad = [x for x in names if x not in PROMPTS]
    if bad:
        print("usage: probe_moss_fkey_stirrup_characters.py [all|nangong_yu|raiden_shogun]")
        return 2
    rc = 0
    for i, name in enumerate(names):
        rc |= run(name, 146362337 + i)
    return rc


if __name__ == "__main__":
    raise SystemExit(main())
