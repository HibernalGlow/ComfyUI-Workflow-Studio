#!/usr/bin/env python3
"""祀 · 动作 LoRA 测评：同页 / 同 seed / 同画风，只换动作 LoRA。

用法：
    tools/run_batch.sh run_si_action_lora_ab.py --test foot
    tools/run_batch.sh run_si_action_lora_ab.py --test hair

foot = NT004 踩脚袜足交，比较 5 个镫袜/足交 LoRA + 无 LoRA 对照（native-30）
hair = NT008 发交，比较 hairop 0.8 与不挂（single-17）
"""

import argparse
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from story_config import load_story  # noqa: E402

TOML = (Path(__file__).resolve().parent.parent.parent
        / "Workflows/wild/storyboard/2607/260723/祀_夜行列车/batch.toml")

OUT_ROOT = "明日方舟终末地_祀_LoRA测评"

TURBO = ("On", "Turbo", r"anima\turbo\anima-turbo-lora-v0.2.safetensors", 0.8, 1.0)
AESTH = ("On", "Aesthetic", r"anima\beauty\anima-highres-aesthetic-boost.safetensors", 0.48, 1.0)
STYLE = ("On", "heitu", r"anima\artist\260620\huanxiang_heitu\huanxiang_heitu_anima_v1.safetensors", 0.8, 1.0)
CHAR = ("On", "Si", r"anima\chara\endfield\siAnimaTE.safetensors", 1.3, 1.0)
BASE = [TURBO, AESTH, STYLE, CHAR]

FOOT_PAGE = "NT004"
FOOT_SEED = 8261133530752617493
FOOT_TESTS = [
    ("foot_ustirrup1500", r"anima\action\footjob\ustirrup\ustirrup-step00001500.safetensors", 1.2),
    ("foot_ustirrup2000", r"anima\action\footjob\ustirrup\ustirrup-step00002000.safetensors", 0.88),
    ("foot_ustirrup2250", r"anima\action\footjob\ustirrup\ustirrup-step00002250.safetensors", 0.88),
    ("foot_stirrupjob50", r"anima\action\footjob\stirrupjob\stirrupjob-000050.safetensors", 1.1),
    ("foot_under4000", r"anima\action\footjob\under_stirrup_footjob-step00004000.safetensors", 1.0),
    ("foot_none", None, 0.0),
]

HAIR_PAGE = "NT008"
HAIR_SEED = 4196201347445860727
HAIR_TESTS = [
    ("hair_hairop08", r"anima\action\hair\hairop-000026.safetensors", 0.8),
    ("hair_none", None, 0.0),
    ("hair_straddle06", r"anima\action\hair\straddling_hairjob_irnart.safetensors", 0.6),
    ("hair_straddle08", r"anima\action\hair\straddling_hairjob_irnart.safetensors", 0.8),
]


def run_one(rtb, page, preset, seed, label, lora_path, weight):
    rtb.apply_preset(preset, quiet=True)
    rtb.SEED = seed
    rtb.SEED_FIXED = True
    rtb.SEED_MODE = "fixed"
    rtb.AUTO_ACTION_LORAS = False
    rtb.PAGE_RULES = []
    rtb.OUTPUT_SUBDIR = OUT_ROOT
    rtb.LORAS = list(BASE)
    if lora_path:
        rtb.LORAS.append(("On", label, lora_path, weight, 1.0))
    positive = rtb.parse_txt(page)
    prefix = f"{OUT_ROOT}/{label}/{page.stem}"
    print(f"\n[{label}] {page.name}  preset={preset}  seed={seed}")
    for attempt in range(1, 4):
        try:
            wf = rtb.build_workflow(positive, prefix)
            pid = rtb.queue_prompt(wf, front=False)
            imgs = rtb.wait_done(pid, timeout=rtb.WAIT_TIMEOUT)
            if imgs:
                print(f"  ✅ {imgs[0]['filename']}")
                if rtb.MAC_OUT_DIR:
                    for out in rtb.fetch_images(imgs, rtb.MAC_OUT_DIR):
                        print(f"  ⬇️ {out}")
                return True
            print(f"  ⏱ 超时（{attempt}/3）")
        except Exception as e:  # noqa: BLE001
            print(f"  ❌ {e}（{attempt}/3）")
        time.sleep(5)
    return False


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--test", choices=["foot", "hair"], required=True)
    args = p.parse_args()

    rtb, _cfg, _preset = load_story(TOML)
    all_pages = sorted(rtb.PAGES_DIR.glob(rtb.PAGE_GLOB))

    if args.test == "foot":
        page = next(x for x in all_pages if x.stem.startswith(FOOT_PAGE))
        tests, seed, preset = FOOT_TESTS, FOOT_SEED, "anima-native-30"
    else:
        page = next(x for x in all_pages if x.stem.startswith(HAIR_PAGE))
        tests, seed, preset = HAIR_TESTS, HAIR_SEED, "anima-single-17"

    ok = 0
    for label, path, weight in tests:
        ok += run_one(rtb, page, preset, seed, label, path, weight)
    print(f"\n✅ {ok}/{len(tests)}")
    return 0 if ok == len(tests) else 1


if __name__ == "__main__":
    raise SystemExit(main())
