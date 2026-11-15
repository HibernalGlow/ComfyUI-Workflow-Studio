#!/usr/bin/env python3
"""Single-image MOSS/Fkey style probe for Civitai image 146362336.

This is an explicitly permitted one-off probe.  It keeps the reference image's
dual-view composition and polished texture, while replacing the subject with
Saileach (Arknights).  It is intentionally separate from the formal storyboard
batch runner.
"""
from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
import uuid

HOST = "http://127.0.0.1:8188"
UNET = "moss_image_sft_int8_convrot.safetensors"
TE = "qwen3.5_9b_w4a8_gptq.safetensors"
VAE = "flux2-vae_small.safetensors"
LORA = r"moss\MOSS_fkey-lora-r4-muon-step6840-comfy.safetensors"
SEED = 146362336
WIDTH = 1088
HEIGHT = 1440

POSITIVE = r'''<|artist|>fkey<|/artist|>
<|style_and_aesthetic|>Ultra-polished, high-completion commercial 2D anime illustration, character duality split-composition on a clean pastel-blue and warm cream gradient background. Crisp, refined delicate lineart, smooth seamless skin shading with luminous specular highlights, intricate fabric embroidery and silky hair strands, fully finished studio masterpiece with zero rough brushstrokes and zero sketch lines. Sophisticated warm peach skin, white, pale sky-blue and soft navy palette under soft bright indoor daylight, 1girl, multiple views, same character in two states, tall slender young adult woman, 7.5-head-tall proportions, Saileach from Arknights, safe, wholesome.<|/style_and_aesthetic|>
<|left_close_up|>Occupying the left half of the frame in a large waist-up close-up: Saileach, saileach \(arknights\), a tall slender young woman with long golden-blonde hair gathered into a loose side braid, small blue-gray dragon horns, pointed ears, clear sapphire-blue eyes with sharp jewel-like catchlights, a calm confident smile and a soft warm blush. Her white Victorian blouse, blue necktie and dark navy collar are rendered with crisp seams and subtle satin highlights; one gloved hand rests on a blue-and-gold flagpole held close to her chest. A few loose hair strands and tiny white petals catch a bright rim light against the pale blue gradient.<|/left_close_up|>
<|right_full_body|>On the right side in a smaller full-body view, the exact same Saileach stands on a sunlit stone step in a quiet Victoria flower conservatory. She has elegant 7.5-head-tall bishoujo proportions, a small head, long slender legs, long blonde side braid, blue-gray horns and luminous blue eyes. She wears her recognizable blue-and-white parade uniform with a dark skirt, white stirrup-style stockings and polished dark shoes, holding a tall blue-and-gold flag upright while the fabric moves gently in the light. Keep the background airy and low-detail so the smooth skin, fine hair strands, clean edges and soft fabric sheen remain the focus.<|/right_full_body|>
'''

NEGATIVE = (
    "nsfw, nude, naked, cleavage, underwear, bra, panties, exposed skin, sexual, "
    "unfinished, unpolished, rough brushwork, visible brushstrokes, gouache, watercolor bleed, "
    "impasto, painterly, sketch, rough sketch, draft, wip, messy lines, loose lines, "
    "uncolored patches, flat shading, blurry edges, smudged, photorealistic, real human, "
    "3d render, cgi, photograph, monochrome, greyscale, screentones, camera flash, "
    "microscopic pores, film grain, blotchy skin, vector art, plastic skin, thick black outlines, "
    "child, loli, young child, pokemon, nintendo, cosplay, wig, blurry, out of focus, lowres, "
    "ugly face, distorted face, worst quality, bad anatomy, fused bodies, fused legs, extra limbs, "
    "extra arms, extra legs, extra hands, three hands, extra fingers, mutated hands, fused fingers, "
    "six fingers, polydactyly, malformed hands, claw hand, cramped fingers, twisted wrist, "
    "broken finger joints, feet cut off, watermark, text, signature"
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


def build_prompt():
    return {
        "1": {"class_type": "UNETLoader", "inputs": {
            "unet_name": UNET, "weight_dtype": "default"}},
        "2": {"class_type": "CLIPLoader", "inputs": {
            "clip_name": TE, "type": "moss_image"}},
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": VAE}},
        "4": {"class_type": "CLIPTextEncode", "inputs": {
            "text": POSITIVE, "clip": ["2", 0]}},
        "5": {"class_type": "CLIPTextEncode", "inputs": {
            "text": NEGATIVE, "clip": ["2", 0]}},
        "6": {"class_type": "EmptyLatentImage", "inputs": {
            "width": WIDTH, "height": HEIGHT, "batch_size": 1}},
        "10": {"class_type": "LoraLoaderModelOnly", "inputs": {
            "model": ["1", 0], "lora_name": LORA, "strength_model": 0.6}},
        "7": {"class_type": "KSampler", "inputs": {
            "seed": SEED, "steps": 28, "cfg": 3.3, "sampler_name": "euler",
            "scheduler": "sgm_uniform", "denoise": 1.0,
            "model": ["10", 0], "positive": ["4", 0], "negative": ["5", 0],
            "latent_image": ["6", 0]}},
        "8": {"class_type": "VAEDecode", "inputs": {
            "samples": ["7", 0], "vae": ["3", 0]}},
        "9": {"class_type": "SaveImage", "inputs": {
            "images": ["8", 0],
            "filename_prefix": "moss-probe/fkey_qinliu_146362336"}},
    }


def main() -> int:
    try:
        queued = api("/prompt", {"prompt": build_prompt(), "client_id": str(uuid.uuid4())})
    except urllib.error.HTTPError as e:
        print("HTTP", e.code, e.read().decode(errors="replace")[:4000])
        return 1
    pid = queued["prompt_id"]
    print(f"queued {pid}", flush=True)
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
    print("TIMEOUT")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
