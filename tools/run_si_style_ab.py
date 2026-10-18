#!/usr/bin/env python3
"""祀 · 画风 A/B：kanzarin vs 幻象黑兔，各跑 0.8 / 1.0。

变量只有「画风 LoRA + 权重」：
  - 角色 LoRA 固定为 2794878（siAnimaTE，1.3）
  - 底模 / 预设 / Turbo / seed / 负面 / 页面全部锁死
  - 提示词不写鞋袜颜色（颜色交给 LoRA）

用法：
    tools/run_batch.sh run_si_style_ab.py
    tools/run_batch.sh run_si_style_ab.py --pages SC001 --styles kanzarin --weights 0.8,1.0
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

# 角色 LoRA 锁定：2794878（本地 siAnimaTE，character_map 建议 1.3）
CHAR = ("2794878_v1_te", r"anima\chara\endfield\siAnimaTE.safetensors", 1.3)

# key: (lora 路径, 触发词)
STYLES = {
    "kanzarin": (r"anima\artist\260620\kanzarin\kanzarin_v2_epoch16.safetensors", "@kanzar1n"),
    "heitu": (r"anima\artist\260620\huanxiang_heitu\huanxiang_heitu_anima_v1.safetensors", "@huanxiang heitu"),
    # 无官方触发词，靠权重本身；作者建议 1024x1536 + 二次采样
    "endfield3d": (r"anima\artist\260620\endfield_3d\zmd_style_anima.safetensors", ""),
    "neko3d": (r"anima\artist\260620\3d_candidates\neko3d_anima_v14.safetensors", "@NekoAiko3D, 3d"),
    "bunny3d": (r"anima\artist\260620\3d_candidates\bunny_3d_gamevision_anima.safetensors", ""),
}

DEFAULT_PAGES = ["SC001", "SC004"]
DEFAULT_WEIGHTS = [0.8, 1.0]


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--pages", default=",".join(DEFAULT_PAGES))
    p.add_argument("--styles", default=",".join(STYLES))
    p.add_argument("--weights", default=",".join(str(w) for w in DEFAULT_WEIGHTS))
    p.add_argument("--seed", type=int, default=88888888)
    p.add_argument("--width", type=int, default=0)
    p.add_argument("--height", type=int, default=0)
    p.add_argument("--preset", default="")
    p.add_argument("--style-tag", default="")
    p.add_argument("--out-tag", default="")
    return p.parse_args()


def main() -> int:
    args = parse_args()
    pages_want = [x.strip().upper() for x in args.pages.split(",") if x.strip()]
    styles = [x.strip() for x in args.styles.split(",") if x.strip()]
    weights = [float(x) for x in args.weights.split(",") if x.strip()]
    bad = [s for s in styles if s not in STYLES]
    if bad:
        raise SystemExit(f"未知画风：{bad}；可选：{', '.join(STYLES)}")

    rtb, _cfg, preset = load_story(TOML)
    if args.preset:
        preset = args.preset
    rtb.apply_preset(preset, quiet=True)
    if args.width:
        rtb.WIDTH = args.width
    if args.height:
        rtb.HEIGHT = args.height
    rtb.SEED = args.seed
    rtb.SEED_FIXED = False
    rtb.SEED_MODE = "hash"          # 同页同 seed，跨画风只变 LoRA
    rtb.AUTO_ACTION_LORAS = False
    rtb.PAGE_RULES = []
    rtb.PROMPT_REPLACE = []         # 页面里已经是 si \(arknights)

    turbo = next(l for l in rtb.LORAS if "turbo" in l[2].lower())
    base_prefix = rtb.QUALITY_PREFIX.replace("@kanzar1n", "").rstrip().rstrip(",")

    all_pages = sorted(rtb.PAGES_DIR.glob(rtb.PAGE_GLOB))
    pages = [p for p in all_pages
             if p.stem.split("—")[0].strip().upper() in set(pages_want)]
    found = {p.stem.split("—")[0].strip().upper() for p in pages}
    missing = set(pages_want) - found
    if missing:
        print(f"⚠️ 没匹配到页面：{', '.join(sorted(missing))}")

    out_root = "明日方舟终末地_祀_画风AB"
    rtb.OUTPUT_SUBDIR = out_root
    print(f"📄 {TOML}")
    print(f"🧪 {len(pages)} 页 × {len(styles)} 画风 × {len(weights)} 权重 "
          f"= {len(pages) * len(styles) * len(weights)} 张")
    print(f"🎭 角色 LoRA：{CHAR[0]} @ {CHAR[2]}")
    print(f"🎨 画风：{' / '.join(styles)}；权重：{weights}")
    print("=" * 70)

    ok = fail = 0
    for style in styles:
        style_path, trigger = STYLES[style]
        rtb.QUALITY_PREFIX = base_prefix + (f", {trigger}" if trigger else "") + (f", {args.style_tag}" if args.style_tag else "")
        for w in weights:
            tag = f"{style}_w{w:g}{args.out_tag}"
            rtb.LORAS = [
                turbo,
                ("On", style, style_path, w, 1.0),
                ("On", CHAR[0], CHAR[1], CHAR[2], 1.0),
            ]
            print(f"\n{'━' * 70}\n🎨 [{tag}] {style_path}  w={w:g}  clip=1.0")
            for page in pages:
                positive = rtb.parse_txt(page)
                prefix = f"{out_root}/{tag}/{page.stem}"
                print(f"  [{tag}] {page.stem}")
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
                        print(f"      ⏱ 超时（第 {attempt}/3 次）")
                    except Exception as e:  # noqa: BLE001
                        print(f"      ❌ 异常（第 {attempt}/3 次）：{e}")
                    if attempt < 3:
                        time.sleep(5)
                else:
                    fail += 1

    print(f"\n{'=' * 70}\n✅ 成功 {ok}，失败 {fail}")
    return 0 if fail == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
