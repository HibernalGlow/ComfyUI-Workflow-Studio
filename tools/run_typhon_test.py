import json
import urllib.request
import urllib.parse
import time
import uuid
import sys
import os

COMFY_HOST = "127.0.0.1:8188"
CLIENT_ID = str(uuid.uuid4())

def build_workflow(unet_name, loras, positive_text, negative_text, seed=88888888, filename_prefix="typhon_test"):
    """
    Build a minimal, clean, pure Anima API workflow.
    No GlowLoader, no BatchLoadTexts, no custom variables.
    """
    prompt = {}

    # 1. OTUNetLoaderW8A8
    prompt["1"] = {
        "class_type": "OTUNetLoaderW8A8",
        "inputs": {
            "unet_name": unet_name,
            "weight_dtype": "default",
            "model_type": "anima",
            "on_the_fly_quantization": False,
            "enable_convrot": True,
            "lora_mode": "None"
        }
    }

    # 2. CLIPLoader
    prompt["2"] = {
        "class_type": "CLIPLoader",
        "inputs": {
            "clip_name": "qwen_3_06b_base.safetensors",
            "type": "stable_diffusion",
            "device": "cpu"
        }
    }

    # 3. VAELoader
    prompt["3"] = {
        "class_type": "VAELoader",
        "inputs": {
            "vae_name": "qwen_image_vae.safetensors"
        }
    }

    # 4. EmptyLatentImage
    prompt["4"] = {
        "class_type": "EmptyLatentImage",
        "inputs": {
            "width": 832,
            "height": 1216,
            "batch_size": 1
        }
    }

    # 5. Build CR LoRA Stacks (chain in groups of 3)
    # loras is a list of (name, path, model_weight, clip_weight)
    num_stacks = (len(loras) + 2) // 3
    if num_stacks == 0:
        num_stacks = 1
        loras = []

    last_stack_id = None
    for s_idx in range(num_stacks):
        stack_id = str(10 + s_idx)
        chunk = loras[s_idx * 3 : (s_idx + 1) * 3]
        inputs = {}
        if last_stack_id is not None:
            inputs["lora_stack"] = [last_stack_id, 0]
        for slot in range(1, 4):
            if slot - 1 < len(chunk):
                item = chunk[slot - 1]
                inputs[f"switch_{slot}"] = "On"
                inputs[f"lora_name_{slot}"] = item[1].replace("/", "\\")
                inputs[f"model_weight_{slot}"] = float(item[2])
                inputs[f"clip_weight_{slot}"] = float(item[3])
            else:
                inputs[f"switch_{slot}"] = "Off"
                inputs[f"lora_name_{slot}"] = "None"
                inputs[f"model_weight_{slot}"] = 1.0
                inputs[f"clip_weight_{slot}"] = 1.0

        prompt[stack_id] = {
            "class_type": "CR LoRA Stack",
            "inputs": inputs
        }
        last_stack_id = stack_id

    # 6. CR Apply LoRA Stack
    apply_lora_id = "20"
    prompt[apply_lora_id] = {
        "class_type": "CR Apply LoRA Stack",
        "inputs": {
            "model": ["1", 0],
            "clip": ["2", 0],
            "lora_stack": [last_stack_id, 0]
        }
    }

    # 7. Positive CLIPTextEncode
    prompt["30"] = {
        "class_type": "CLIPTextEncode",
        "inputs": {
            "text": positive_text,
            "clip": [apply_lora_id, 1]
        }
    }

    # 8. Negative CLIPTextEncode
    prompt["31"] = {
        "class_type": "CLIPTextEncode",
        "inputs": {
            "text": negative_text,
            "clip": [apply_lora_id, 1]
        }
    }

    # 9. FLS_SamplerV4
    prompt["40"] = {
        "class_type": "FLS_SamplerV4",
        "inputs": {
            "model": [apply_lora_id, 0],
            "positive": ["30", 0],
            "negative": ["31", 0],
            "latent_image": ["4", 0],
            "seed": seed,
            "steps": 12,
            "cfg": 1.6,
            "sampler_name": "euler_ancestral",
            "scheduler": "beta57",
            "denoise": 1.0,
            "fovea_strength": 3.0,
            "sharpness": 0.5,
            "mask_inertia": 0.85
        }
    }

    # 10. VAEDecode
    prompt["50"] = {
        "class_type": "VAEDecode",
        "inputs": {
            "samples": ["40", 0],
            "vae": ["3", 0]
        }
    }

    # 11. SaveImage
    prompt["60"] = {
        "class_type": "SaveImage",
        "inputs": {
            "images": ["50", 0],
            "filename_prefix": filename_prefix
        }
    }

    return prompt

def queue_prompt(prompt_workflow):
    data = json.dumps({"prompt": prompt_workflow, "client_id": CLIENT_ID}).encode("utf-8")
    req = urllib.request.Request(f"http://{COMFY_HOST}/prompt", data=data, headers={"Content-Type": "application/json"})
    resp = urllib.request.urlopen(req)
    res_json = json.loads(resp.read().decode("utf-8"))
    return res_json.get("prompt_id")

def wait_for_prompt(prompt_id, timeout=180):
    start = time.time()
    print(f"[*] Waiting for prompt {prompt_id} to finish...")
    last_print = 0
    while time.time() - start < timeout:
        try:
            req = urllib.request.urlopen(f"http://{COMFY_HOST}/history/{prompt_id}")
            data = json.loads(req.read().decode("utf-8"))
            if prompt_id in data:
                outputs = data[prompt_id].get("outputs", {})
                images = []
                for node_id, node_out in outputs.items():
                    if "images" in node_out:
                        images.extend(node_out["images"])
                print("[*] Execution complete!")
                return images
        except Exception as e:
            pass
        if time.time() - last_print > 3:
            print(f"    Elapsed: {int(time.time() - start)}s...")
            last_print = time.time()
        time.sleep(1)
    return []

if __name__ == "__main__":
    test_mode = sys.argv[1] if len(sys.argv) > 1 else "1"
    
    # Base setup
    artist_lora = ("Artist z3zz", "anima\\artist\\260613\\anima_z3zz@z3zz.safetensors", 1.0, 1.0)
    turbo_lora = ("Turbo-v0.2", "anima\\turbo\\anima-turbo-lora-v0.2.safetensors", 0.8, 1.0)
    aesthetic_lora = ("Aesthetic Boost", "anima\\beauty\\anima-highres-aesthetic-boost.safetensors", 0.48, 1.0)
    
    typhon_prompt_core = (
        "1girl, Typhon (arknights), typhon (arknights), sarkaz, demon girl, demon horns, black horns, huge horns, "
        "demon tail, black tail, very long tail, pointy ears, purple hair, long hair, very long hair, twintails, sidelocks, "
        "red eyes, symbol-shaped pupils, large breasts, cleavage, toned stomach, navel, blue jacket, cropped jacket, off shoulder, "
        "bare shoulders, short dress, white stirrup legwear, stirrup legwear, toeless legwear, white pantyhose, bare toes, bare heels, "
        "white bridal gauntlets, bridal gauntlets, white elbow gloves, elbow gloves, v-shaped fabric on back of hand, seams, arm seams, "
        "finger seams, glossy fabric, shiny, shiny gloves, sami field shelter, cabin, fireplace, snow outside window, blizzard, night"
    )
    
    negative = (
        "worst quality, low quality, bad anatomy, bad hands, missing fingers, extra digit, fewer digits, watermark, text"
    )
    
    if test_mode == "1":
        print("\n=== TEST 1: 2.9B SilverMoon (WITHOUT LoRA) ===")
        unet = "silvermoonmixAnima29B_v23_INT8.safetensors"
        loras = [turbo_lora, aesthetic_lora, artist_lora]
        pos = f"masterpiece, best quality, aesthetic, highly detailed, @z3zz\n\n{typhon_prompt_core}"
        prefix = "TEST1_29B_no_lora"
    elif test_mode == "2":
        print("\n=== TEST 2: 2.9B SilverMoon + 2.9B Typhoeus LoRA ===")
        unet = "silvermoonmixAnima29B_v23_INT8.safetensors"
        typhoeus_29b = ("Typhoeus 2.9B", "anima\\chara\\endfield\\typhoeus_anima_v2_29b.safetensors", 1.1, 1.0)
        loras = [turbo_lora, aesthetic_lora, artist_lora, typhoeus_29b]
        pos = f"masterpiece, best quality, aesthetic, highly detailed, @z3zz, typhoeusendfield\n\n{typhon_prompt_core}"
        prefix = "TEST2_29B_with_29b_lora"
    elif test_mode == "3":
        print("\n=== TEST 3: Normal v2.3 SilverMoon + Normal Typhoeus LoRA ===")
        unet = "silvermoonmixAnima_v23_INT8.safetensors"
        typhoeus_base = ("Typhoeus Base", "anima\\chara\\endfield\\typhoeus_anima_base_v2.safetensors", 1.1, 1.0)
        loras = [turbo_lora, aesthetic_lora, artist_lora, typhoeus_base]
        pos = f"masterpiece, best quality, aesthetic, highly detailed, @z3zz, typhoeusendfield\n\n{typhon_prompt_core}"
        prefix = "TEST3_base_with_base_lora"
    elif test_mode == "4":
        print("\n=== TEST 4: Normal v2.3 SilverMoon + Bubutuke Artist + Base Typhoeus LoRA ===")
        unet = "silvermoonmixAnima_v23_INT8.safetensors"
        bubutuke_lora = ("Artist Bubutuke", "anima\\artist\\260924\\style-Bubutuke-Anima-v01.safetensors", 1.0, 1.0)
        typhoeus_base = ("Typhoeus Base", "anima\\chara\\endfield\\typhoeus_anima_base_v2.safetensors", 1.1, 1.0)
        loras = [turbo_lora, aesthetic_lora, bubutuke_lora, typhoeus_base]
        pos = f"masterpiece, best quality, aesthetic, highly detailed, bubutuke, uncensored, typhoeusendfield\n\n{typhon_prompt_core}"
        prefix = "TEST4_v23_bubutuke"
    elif test_mode == "5":
        print("\n=== TEST 5: 2.9B SilverMoon + Bubutuke Artist + 2.9B Typhoeus LoRA ===")
        unet = "silvermoonmixAnima29B_v23_INT8.safetensors"
        bubutuke_lora = ("Artist Bubutuke", "anima\\artist\\260924\\style-Bubutuke-Anima-v01.safetensors", 1.0, 1.0)
        typhoeus_29b = ("Typhoeus 2.9B", "anima\\chara\\endfield\\typhoeus_anima_v2_29b.safetensors", 1.1, 1.0)
        loras = [turbo_lora, aesthetic_lora, bubutuke_lora, typhoeus_29b]
        pos = f"masterpiece, best quality, aesthetic, highly detailed, bubutuke, uncensored, typhoeusendfield\n\n{typhon_prompt_core}"
        prefix = "TEST5_29B_bubutuke"
    else:
        print("Unknown test mode")
        sys.exit(1)

    wf = build_workflow(unet, loras, pos, negative, seed=88888888, filename_prefix=prefix)
    prompt_id = queue_prompt(wf)
    print(f"[*] Queued prompt {prompt_id} for mode {test_mode}")
    imgs = wait_for_prompt(prompt_id)
    print(f"[*] Result images: {imgs}")
