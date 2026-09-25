"""
安卡希雅 (Ankasha) 角色 LoRA × 7 形态 对比测试

目的：ankasha_v1_anima 训练时用了 7 套皮肤，作者给了 7 个形态 token，
      逐个跑一遍看还原度。画师固定用 atdan_anima_v1.0_dim64@atdan。

事实来源（读 safetensors 元数据，非猜测）：
  ss_tag_frequency = {
    "ankasha": 28, "silver hair": 28, "golden eyes": 28,
    "yellow hair ornament": 28, "standing": 28, "simple background": 28,
    "gun": 20, "knife": 8, "front view": 7, "back view": 7,
    "left profile": 7, "right profile": 7,
    # 以下 7 个形态 token 各 4 张（7×4 = 28 = 全部训练图）
    "buyuxianshi": 4, "bumiebangshou": 4, "yeyinxianqu": 4, "huiye": 4,
    "dongliuyinhe": 4, "shizhichongzou": 4, "yuanyinhuixiang": 4 }
  ss_dataset_dirs: 28 张图 × 12 repeats = 336，resolution [768,768] bucket
  ss_sd_model_name: anima-base-v1.0.safetensors

用法：
    tools/run_batch.sh run_ankasha_forms.py            # 全部形态
    tools/run_batch.sh run_ankasha_forms.py F4-huiye   # 只跑指定形态
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from story_config import engine          # noqa: E402

rtb = engine()

# ─── 配置 ─────────────────────────────────────────────────────
PRESET_ID  = "anima-two-stage-standard"          # 与琴柳正式跑批同一预设
OUT_SUBDIR = "安卡希雅_形态测试"
SEED       = 88888888

MAC_OUT = Path("/Users/glow/Base/Works/ComfyUI/Outputs")

# 角色 LoRA：触发词原文 "Ankasha, silver hair, golden eyes,"
# yellow hair ornament 也出现在全部 28 张 caption 里 → 属于角色本体特征，一并带上
CHAR_LORA = ("On", "Ankasha v1", r"anima\chara\snowbreak\ankasha_v1_anima.safetensors", 1.0, 1.0)

# 画师 LoRA：dim64 / alpha64，52 张图硬刷 50 epoch → 风格重
# 作者没给权重建议；dim64 高秩按经验从 0.7 起步（1.0 以上易糊、锁构图）
ARTIST_LORA = ("On", "Atdan dim64",
               r"anima\artist\260924\atdan_anima_v1.0_dim64@atdan.safetensors", 0.7, 1.0)

# 7 个形态 token 全部来自 LoRA 训练元数据 ss_tag_frequency，未做任何猜测
FORMS = [
    ("F0-noform",      None),                 # 对照：不写形态 token，看 LoRA 默认形态
    ("F1-buyuxianshi",      "buyuxianshi"),
    ("F2-bumiebangshou",    "bumiebangshou"),
    ("F3-yeyinxianqu",      "yeyinxianqu"),
    ("F4-huiye",            "huiye"),
    ("F5-dongliuyinhe",     "dongliuyinhe"),
    ("F6-shizhichongzou",   "shizhichongzou"),
    ("F7-yuanyinhuixiang",  "yuanyinhuixiang"),
]

_want = [a for a in sys.argv[1:] if a.startswith("F")]
if _want:
    FORMS = [f for f in FORMS if f[0] in _want]


def build_prompt(form_token: str) -> str:
    body = "1girl, solo, ankasha, silver hair, golden eyes, yellow hair ornament"
    if form_token:
        body += f", {form_token}"
    body += ", full body, standing, looking at viewer, simple background"
    return f"{rtb.QUALITY_PREFIX}\n\n{body}"


def main() -> None:
    rtb.apply_preset(PRESET_ID)
    rtb.SEED = SEED
    rtb.MAC_OUT_DIR = MAC_OUT
    rtb.QUALITY_PREFIX = "masterpiece, best quality, aesthetic, highly detailed, @atdan, uncensored"
    rtb.NEGATIVE = ("worst quality, low quality, bad anatomy, bad hands, missing fingers, "
                    "extra digit, fewer digits, watermark, text")
    rtb.LORAS = [
        ("On", "Turbo-v0.2",      r"anima\turbo\anima-turbo-lora-v0.2.safetensors",              0.8,  1.0),
        ("On", "Aesthetic Boost", r"anima\beauty\anima-highres-aesthetic-boost.safetensors",     0.48, 1.0),
        ARTIST_LORA,
        CHAR_LORA,
    ]
    rtb.PAGE_RULES = []          # 本测试不需要逐页规则
    rtb.AUTO_ACTION_LORAS = False

    print(f"🧱 LoRA 栈：{' → '.join(l[1] for l in rtb.LORAS)}")
    print(f"🎨 画师触发词：@atdan（权重 {ARTIST_LORA[3]}）")
    print(f"🧪 {len(FORMS)} 个变体，seed={SEED} 固定｜输出 {OUT_SUBDIR}/")
    print("=" * 66)

    results = []
    for tag, form in FORMS:
        pos = build_prompt(form)
        print(f"\n[{tag}] 形态 token：{form or '(无，对照)'}")
        print(f"      正向：{pos.splitlines()[-1]}")
        try:
            wf  = rtb.build_workflow(pos, f"{OUT_SUBDIR}/{tag}")
            pid = rtb.queue_prompt(wf)
            print(f"      → prompt_id={pid[:8]}…")
            imgs = rtb.wait_done(pid)
            if imgs:
                print(f"      ✅ {imgs[0]['filename']}")
                got = rtb.fetch_images(imgs, rtb.MAC_OUT_DIR)
                for p in got:
                    print(f"      ⬇️  {p}")
                results.append({"v": tag, "ok": True, "file": imgs[0]["filename"]})
            else:
                print("      ❌ 超时/失败")
                results.append({"v": tag, "ok": False, "file": None})
        except Exception as e:
            print(f"      ❌ 异常：{e}")
            results.append({"v": tag, "ok": False, "file": str(e)})

    ok = sum(1 for r in results if r["ok"])
    print(f"\n{'=' * 66}\n✅ 成功 {ok} / {len(results)}")
    for r in results:
        if not r["ok"]:
            print(f"   FAIL {r['v']} → {r['file']}")
    if ok:
        print(f"\n输出：{MAC_OUT}/{OUT_SUBDIR}/")


if __name__ == "__main__":
    main()
