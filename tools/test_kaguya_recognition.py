import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from story_config import engine

rtb = engine()

# Setup paths and base config
rtb.MAC_OUT_DIR = Path("/Users/glow/Base/Works/ComfyUI/Outputs")
OUT_SUBDIR = "kaguya_recognition_test"
SEED = 42424242

# Base LoRAs (Turbo + Aesthetic Boost, no artist LoRA so we test pure base model knowledge)
rtb.LORAS = [
    ("On", "Turbo-v0.2", r"anima\turbo\anima-turbo-lora-v0.2.safetensors", 0.8, 1.0),
    ("On", "Aesthetic Boost", r"anima\beauty\anima-highres-aesthetic-boost.safetensors", 0.48, 1.0),
]
rtb.apply_preset("anima-two-stage-standard", quiet=False)
rtb.SEED = SEED
rtb.NEGATIVE = "worst quality, low quality, bad anatomy, bad hands, missing fingers, extra digit, fewer digits, watermark, text"
rtb.AUTO_ACTION_LORAS = False

TESTS = [
    # 1. Underscore Danbooru tag
    ("T1_underscore", 
     "masterpiece, best quality, aesthetic, highly detailed, uncensored\n\n"
     "1girl, solo, acacia_-_kaguya_(allure_of_lotus)_(snowbreak), full body, standing, looking at viewer, simple background"),
    
    # 2. Danbooru tag with escaped parens and spaces
    ("T2_escaped_spaces", 
     "masterpiece, best quality, aesthetic, highly detailed, uncensored\n\n"
     "1girl, solo, acacia - kaguya \\(allure of lotus\\) \\(snowbreak\\), full body, standing, looking at viewer, simple background"),

    # 3. Base character tag alone
    ("T3_base_character", 
     "masterpiece, best quality, aesthetic, highly detailed, uncensored\n\n"
     "1girl, solo, acacia \\(snowbreak\\), full body, standing, looking at viewer, simple background"),

    # 4. Escaped spaces + minimal appearance anchors
    ("T4_tag_with_anchors", 
     "masterpiece, best quality, aesthetic, highly detailed, uncensored\n\n"
     "1girl, solo, acacia - kaguya \\(allure of lotus\\) \\(snowbreak\\), grey hair, yellow eyes, double bun, chinese clothes, qipao, blue dress, full body, standing, looking at viewer, simple background")
]

print(f"🚀 开始测试底模角色认知：{len(TESTS)} 组")
for tag, pos in TESTS:
    prefix = f"{OUT_SUBDIR}/{tag}"
    print(f"\n▶ 正在生成 [{tag}]...")
    wf = rtb.build_workflow(pos, prefix)
    pid = rtb.queue_prompt(wf)
    print(f"  prompt_id: {pid[:8]}...")
    imgs = rtb.wait_done(pid)
    if imgs:
        print(f"  ✅ 生成成功: {imgs[0]['filename']}")
        downloaded = rtb.fetch_images(imgs, rtb.MAC_OUT_DIR)
        for p in downloaded:
            print(f"  ⬇️ 回传成功: {p}")
    else:
        print(f"  ❌ 失败/超时")

print("\n🎉 全部测试完成！")
