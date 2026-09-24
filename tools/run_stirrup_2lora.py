"""
2 个 stirrup LoRA、权重都不超过 1 —— 候选组合对照

你指出参考梨诺应该是「2 个、都不超过 1（0.8 啥的）」。梨诺全套里权重天然 ≤1 的
stirrup 系只有 ustirrup2000(0.88) 与 stirrup3-1(0.63)，另外「主件+强化」也可能
被你按 0.8 压下来。这里把两种配对都跑，并分别给「只要这 2 个」与「另加降龄/修复」
两种版本，一次看完。

  Z1-mainpair-only   ustirrup1500 0.8 + stirrupjob50 0.8
  Z2-mainpair+age    ustirrup1500 0.8 + stirrupjob50 0.8 + age -1.35 + foot 0.88
  Z3-lowpair-only    ustirrup2000 0.88 + stirrup3-1   0.63
  Z4-lowpair+age     ustirrup2000 0.88 + stirrup3-1   0.63 + age -1.35 + foot 0.88
"""

import importlib.util
from pathlib import Path

HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("rtb", HERE / "run_typhon_batch.py")
rtb = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(rtb)

rtb.PAGES_DIR = Path("/Users/glow/Base/Works/ComfyUI/Workflows/wild/storyboard/明日方舟终末地_洛茜/pages")
rtb.PAGE_GLOB = "R*.txt"
rtb.AUTO_ACTION_LORAS = False
rtb.SEED = 88888888
OUT = "明日方舟终末地_洛茜_调参"
PAGE_CODE = "RF003"

BASE = [
    ("On", "Turbo-v0.2",      r"anima\turbo\anima-turbo-lora-v0.2.safetensors",                 0.8,  1.0),
    ("On", "Aesthetic Boost", r"anima\beauty\anima-highres-aesthetic-boost.safetensors",        0.48, 1.0),
    ("On", "Healthyman",      r"anima\artist\260614\healthyman_v1_epoch28@hea1thy.safetensors", 1.0,  1.0),
    ("On", "Rossi v2 Anima",  r"anima\chara\endfield\rossi_v2_anima.safetensors",               1.0,  1.0),
]

U1500 = ("On", "Ustirrup 1500", r"anima\action\footjob\ustirrup\ustirrup-step00001500.safetensors", 0.8,  1.0)
SJ50  = ("On", "Stirrupjob 50", r"anima\action\footjob\stirrupjob\stirrupjob-000050.safetensors",   0.8,  1.0)
U2000 = ("On", "Ustirrup 2000", r"anima\action\footjob\ustirrup\ustirrup-step00002000.safetensors", 0.88, 1.0)
S31   = ("On", "Stirrup 3-1",   r"anima\stirrup3-1(preview0.2).safetensors",                        0.63, 1.0)
AGE   = ("On", "Age Slider",    r"anima\action\age\age_slider_old-step00000300-1.5.safetensors",   -1.35, 1.0)
FOOT  = ("On", "Foot Repair",   r"anima\action\anima_footRepair_v2-tri-@footRepair.safetensors",    0.88, 1.0)

VARIANTS = [
    ("Z1-mainpair-only", [U1500, SJ50]),
    ("Z2-mainpair+age",  [U1500, SJ50, AGE, FOOT]),
    ("Z3-lowpair-only",  [U2000, S31]),
    ("Z4-lowpair+age",   [U2000, S31, AGE, FOOT]),
]


def main() -> None:
    rtb.apply_preset("anima-two-stage-standard")
    page = {p.stem.split("—")[0]: p for p in sorted(rtb.PAGES_DIR.glob(rtb.PAGE_GLOB))}[PAGE_CODE]
    print(f"🧪 {PAGE_CODE} × {len(VARIANTS)} 组（全部 ≤1），seed={rtb.SEED} 固定")
    print("=" * 64)
    for tag, extra in VARIANTS:
        rtb.LORAS = BASE + extra
        rtb.QUALITY_PREFIX = ("masterpiece, best quality, aesthetic, highly detailed, "
                              "@hea1thy, uncensored")
        print(f"\n[{tag}] {len(rtb.LORAS)} 个 LoRA：" +
              "、".join(f"{n} {mw}" for _s, n, _p, mw, _c in extra))
        try:
            wf = rtb.build_workflow(rtb.parse_txt(page), f"{OUT}/{page.stem}_{tag}")
            imgs = rtb.wait_done(rtb.queue_prompt(wf), timeout=300)
            print(f"      ✅ {imgs[0]['filename']}" if imgs else "      ❌ 超时/失败")
        except Exception as e:
            print(f"      ❌ 异常：{e}")
    print(f"\n输出：D:\\1Repo\\Github\\ComfyUI\\Library\\output\\{OUT}\\")


if __name__ == "__main__":
    main()
