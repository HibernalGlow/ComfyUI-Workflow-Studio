#!/usr/bin/env python3
"""
祀 (Si) 角色 LoRA 横向对比 —— Studio 批量引擎驱动。

只改角色 LoRA（以及它自己的触发词），其余全部沿用 batch.toml：
同底模、同采样预设、同 Turbo/Aesthetic、同负面、同页、同 seed。

用法：
    tools/run_batch.sh run_si_models.py --pages LK010 --models 2834394
    tools/run_batch.sh run_si_models.py --pages LK010,LK030,LK039,LK048 \
        --models 2547832,2795280,2834394
    tools/run_batch.sh run_si_models.py          # 全部变体 × 默认四页
"""

import argparse
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from story_config import load_story  # noqa: E402

TOML = (Path(__file__).resolve().parent.parent.parent
        / "Workflows/wild/storyboard/2607/260723/祀_模型对比/batch.toml")

# 原皮展示机位：正面全身 / 四分之三侧身 / 背面全身 / 上半身特写 / 踩脚袜细节
DEFAULT_PAGES = ["SC001", "SC002", "SC003", "SC004", "SC005"]

# key: (输出 tag, lora 相对路径, 触发词)
VARIANTS = {
    "2547832": ("2547832_v2", r"anima\chara\endfield\si_anima_2547832_v2.safetensors", r"si \(arknights)"),
    "2795280": ("2795280_v1", r"anima\chara\endfield\si_anima_2795280_v1.safetensors", r"si \(arknights)"),
    "2794878": ("2794878_v1_te", r"anima\chara\endfield\siAnimaTE.safetensors", r"si \(arknights)"),
    "2988374": ("2988374_ingame", r"anima\chara\endfield\si_anima_2988374_ingame.safetensors", r"arknights si, si \(arknights)"),
    "3003142": ("3003142_community", r"anima\chara\endfield\si_anima_3003142_community.safetensors", "Xiaocong"),
    "2834394": ("2834394_v2", r"anima\chara\endfield\si_anima_2834394_v2.safetensors", r"si \(arknights: endfield)"),
}

# 页面里所有形态 tag 都收敛到当前变体的主触发词，避免别的角色的 tag 抢概念。
SI_TAGS = [
    r"si \(bride\) \(arknights)",
    r"si \(office lady\) \(arknights)",
    r"si \(nun\) \(arknights)",
    r"si \(qipao\) \(arknights)",
    r"si \(bunny girl\) \(arknights)",
    r"si \(bikini\) \(arknights)",
    r"si \(miko\) \(arknights)",
    r"si \(yukata\) \(arknights)",
    r"si \(maid\) \(arknights)",
    r"si \(ballet\) \(arknights)",
    r"si \(arknights)",
]


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--pages", default=",".join(DEFAULT_PAGES))
    p.add_argument("--models", default=",".join(VARIANTS))
    p.add_argument("--seed", type=int, default=88888888)
    return p.parse_args()


def main() -> int:
    args = parse_args()
    pages_want = [x.strip().upper() for x in args.pages.split(",") if x.strip()]
    models = [x.strip() for x in args.models.split(",") if x.strip()]
    bad = [m for m in models if m not in VARIANTS]
    if bad:
        raise SystemExit(f"未知模型：{bad}；可选：{', '.join(VARIANTS)}")

    rtb, cfg, base_preset = load_story(TOML)
    rtb.apply_preset(base_preset)
    rtb.SEED = args.seed
    rtb.SEED_FIXED = False
    rtb.SEED_MODE = "hash"        # 同页同 seed、不同页不同 seed（对比时只变模型）
    rtb.AUTO_ACTION_LORAS = False          # 隔离变量：不自动挂动作 LoRA
    rtb.PAGE_RULES = []

    all_pages = sorted(rtb.PAGES_DIR.glob(rtb.PAGE_GLOB))
    pages = [p for p in all_pages
             if p.stem.split("—")[0].strip().upper() in set(pages_want)]
    found = {p.stem.split("—")[0].strip().upper() for p in pages}
    missing = set(pages_want) - found
    if missing:
        print(f"⚠️ 没匹配到页面：{', '.join(sorted(missing))}")

    print(f"📄 {TOML}")
    print(f"🧪 {len(pages)} 页 × {len(models)} 模型 = {len(pages) * len(models)} 张，seed={args.seed}")
    print(f"🧱 共用基线：{' + '.join(l[1] for l in rtb.LORAS)}")
    print(f"📁 输出：{rtb.OUTPUT_SUBDIR}/<模型>/")
    print("=" * 70)

    base_loras = list(rtb.LORAS)
    ok = fail = 0
    for key in models:
        tag, path, trigger = VARIANTS[key]
        rtb.LORAS = base_loras + [("On", tag, path, 1.0, 1.0)]
        rtb.PROMPT_REPLACE = [(t, trigger) for t in SI_TAGS]
        print(f"\n{'━' * 70}\n🎭 [{tag}] {path}\n    触发词：{trigger}")
        for page in pages:
            positive = rtb.parse_txt(page)
            prefix = f"{rtb.OUTPUT_SUBDIR}/{tag}/{page.stem}"
            print(f"  [{tag}] {page.stem}")
            # 隧道是 DERP 中转，偶发掉线；单张重试 3 次，别让一次断流毁掉整批。
            for attempt in range(1, 4):
                try:
                    wf = rtb.build_workflow(positive, prefix)
                    pid = rtb.queue_prompt(wf, front=False)
                    imgs = rtb.wait_done(pid, timeout=rtb.WAIT_TIMEOUT)
                    if imgs:
                        print(f"      ✅ {imgs[0]['filename']}")
                        if rtb.MAC_OUT_DIR:
                            for out in rtb.fetch_images(imgs, rtb.MAC_OUT_DIR):
                                print(f"      ⬇️ {out}")
                        ok += 1
                        break
                    print(f"      ⏱ 超时（第 {attempt}/3 次），重试…")
                except Exception as e:  # noqa: BLE001
                    print(f"      ❌ 异常（第 {attempt}/3 次）：{e}")
                if attempt < 3:
                    time.sleep(5)
            else:
                fail += 1

    print(f"\n{'=' * 70}\n✅ 成功 {ok}，失败 {fail}")
    if ok and rtb.MAC_OUT_DIR:
        print(f"Mac：{rtb.MAC_OUT_DIR}/{rtb.OUTPUT_SUBDIR}/")
    return 0 if fail == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
