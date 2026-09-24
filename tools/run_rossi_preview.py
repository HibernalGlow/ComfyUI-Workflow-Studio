"""
快速预览：指定画师 × 指定 Studio 预设 × 前 N 页，输出到独立对比目录。

用法示例：
  python run_rossi_preview.py --artist metatarou --preset anima-two-stage-standard \
      --start 1 --count 3 --out 明日方舟终末地_洛茜_metatarou对比

固定搭配：Turbo(由预设开关) + Aesthetic Boost 0.48 + 指定画师 1.0 + rossi_v2_anima 1.0
页面直接用原文（发型已于 01:10-01:11 全部定稿为 low twintails）。
"""

import argparse
import importlib.util
from pathlib import Path

HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("rtb", HERE / "run_typhon_batch.py")
rtb = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(rtb)

rtb.PAGES_DIR = Path("/Users/glow/Base/Works/ComfyUI/Workflows/wild/storyboard/明日方舟终末地_洛茜/pages")
rtb.PAGE_GLOB = "R*.txt"

TURBO = ("On", "Turbo-v0.2",      r"anima\turbo\anima-turbo-lora-v0.2.safetensors",                     0.8,  1.0)
AESTH = ("On", "Aesthetic Boost", r"anima\beauty\anima-highres-aesthetic-boost.safetensors",            0.48, 1.0)
ROSSI = ("On", "Rossi v2 Anima",  r"anima\chara\endfield\rossi_v2_anima.safetensors",                   1.0,  1.0)

ARTISTS = {
    "metatarou":   (("On", "Metatarou",   r"anima\artist\260924\anima_metatarou.safetensors",                    1.0, 1.0), "@metatar0u"),
    "healthyman":  (("On", "Healthyman",  r"anima\artist\260614\healthyman_v1_epoch28@hea1thy.safetensors",      1.0, 1.0), "@hea1thy"),
    "villainchin": (("On", "Villainchin", r"anima\artist\260924\@style_villainchin-v2.0-000012.safetensors",     1.0, 1.0), "@style_villainchin"),
}

PRESET_TAG = {
    "anima-single-turbo":      "turbo12",
    "anima-two-stage-standard": "turboDouble",
    "anima-native-30":          "native30",
}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--artist", required=True, choices=sorted(ARTISTS))
    ap.add_argument("--preset", required=True)
    ap.add_argument("--start", type=int, default=1, help="起始页序号（1 基）")
    ap.add_argument("--count", type=int, default=3)
    ap.add_argument("--out", required=True, help="输出子目录名（ComfyUI output 下）")
    a = ap.parse_args()

    preset = rtb.apply_preset(a.preset)
    artist_lora, trigger = ARTISTS[a.artist]
    rtb.LORAS = [TURBO, AESTH, artist_lora, ROSSI]
    rtb.QUALITY_PREFIX = f"masterpiece, best quality, aesthetic, highly detailed, {trigger}, uncensored"
    rtb.SEED = 88888888

    tag = PRESET_TAG.get(a.preset, a.preset.replace("anima-", ""))
    pages = sorted(rtb.PAGES_DIR.glob(rtb.PAGE_GLOB))[a.start - 1: a.start - 1 + a.count]

    print(f"🎨 画师={a.artist} 触发词={trigger} | 预设={a.preset} ({tag})")
    print(f"🧪 页面 {a.start}..{a.start + len(pages) - 1} 共 {len(pages)} 张 → {a.out}/")
    print("=" * 60)

    results = []
    for idx, page in enumerate(pages, 1):
        prefix = f"{a.out}/{page.stem}_{a.artist}-{tag}"
        print(f"\n[{idx}/{len(pages)}] {page.stem}")
        try:
            wf = rtb.build_workflow(rtb.parse_txt(page), prefix)
            pid = rtb.queue_prompt(wf)
            imgs = rtb.wait_done(pid, timeout=300)
            if imgs:
                print(f"      ✅ {imgs[0]['filename']}")
                results.append((page.stem, True))
            else:
                print("      ❌ 超时/失败")
                results.append((page.stem, False))
        except Exception as e:
            print(f"      ❌ 异常：{e}")
            results.append((page.stem, False))

    ok = sum(1 for _, o in results if o)
    print(f"\n{'='*60}\n✅ 成功 {ok} / {len(results)}")
    print(f"输出：D:\\1Repo\\Github\\ComfyUI\\Library\\output\\{a.out}\\")


if __name__ == "__main__":
    main()
