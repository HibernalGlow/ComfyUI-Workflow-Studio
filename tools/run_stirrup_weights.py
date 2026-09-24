"""
镫袜权重下调扫描 —— 锁定 AB4 的名单，只压强度

AB4 名单（你选的最优组合）：base4 + ustirrup1500 + stirrupjob50 + age_slider + footRepair
参考工作流给的原始强度是 1.2 / 1.1（偏高），这里逐档下压看画风污染什么时候消失。

  W1-ref        1.2 / 1.1   age -1.35   foot 0.88   ← 等于 AB4
  W2-0.9        0.9 / 0.8   age -1.35   foot 0.88
  W3-0.7        0.7 / 0.6   age -1.35   foot 0.88
  W4-0.5        0.5 / 0.4   age -1.35   foot 0.88
  W5-0.7-age08  0.7 / 0.6   age -0.8    foot 0.60   ← 顺手把 age_slider 也退回参考值
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

TURBO = ("On", "Turbo-v0.2",      r"anima\turbo\anima-turbo-lora-v0.2.safetensors",                 0.8,  1.0)
AESTH = ("On", "Aesthetic Boost", r"anima\beauty\anima-highres-aesthetic-boost.safetensors",        0.48, 1.0)
HEAL  = ("On", "Healthyman",      r"anima\artist\260614\healthyman_v1_epoch28@hea1thy.safetensors", 1.0,  1.0)
ROSSI = ("On", "Rossi v2 Anima",  r"anima\chara\endfield\rossi_v2_anima.safetensors",               1.0,  1.0)
BASE  = [TURBO, AESTH, HEAL, ROSSI]

P_U1500 = r"anima\action\footjob\ustirrup\ustirrup-step00001500.safetensors"
P_SJ50  = r"anima\action\footjob\stirrupjob\stirrupjob-000050.safetensors"
P_AGE   = r"anima\action\age\age_slider_old-step00000300-1.5.safetensors"
P_FOOT  = r"anima\action\anima_footRepair_v2-tri-@footRepair.safetensors"


def build(u_w, s_w, age_w, foot_w):
    return BASE + [
        ("On", "Ustirrup 1500", P_U1500, u_w,    1.0),
        ("On", "Stirrupjob 50", P_SJ50,  s_w,    1.0),
        ("On", "Age Slider",    P_AGE,   age_w,  1.0),
        ("On", "Foot Repair",   P_FOOT,  foot_w, 1.0),
    ]


VARIANTS = [
    ("W1-ref",       build(1.2, 1.1, -1.35, 0.88)),
    ("W2-0.9",       build(0.9, 0.8, -1.35, 0.88)),
    ("W3-0.7",       build(0.7, 0.6, -1.35, 0.88)),
    ("W4-0.5",       build(0.5, 0.4, -1.35, 0.88)),
    ("W5-0.7-age08", build(0.7, 0.6, -0.8,  0.60)),
]


def main() -> None:
    rtb.apply_preset("anima-two-stage-standard")
    page = {p.stem.split("—")[0]: p for p in sorted(rtb.PAGES_DIR.glob(rtb.PAGE_GLOB))}[PAGE_CODE]
    print(f"🧪 {PAGE_CODE} × {len(VARIANTS)} 档权重，seed={rtb.SEED} 固定")
    print("=" * 64)
    for tag, loras in VARIANTS:
        rtb.LORAS = loras
        rtb.QUALITY_PREFIX = ("masterpiece, best quality, aesthetic, highly detailed, "
                              "@hea1thy, uncensored")
        w = {n: mw for _s, n, _p, mw, _c in loras}
        print(f"\n[{tag}] ustirrup1500={w['Ustirrup 1500']} stirrupjob50={w['Stirrupjob 50']} "
              f"age={w['Age Slider']} foot={w['Foot Repair']}")
        try:
            wf = rtb.build_workflow(rtb.parse_txt(page), f"{OUT}/{page.stem}_{tag}")
            imgs = rtb.wait_done(rtb.queue_prompt(wf), timeout=300)
            print(f"      ✅ {imgs[0]['filename']}" if imgs else "      ❌ 超时/失败")
        except Exception as e:
            print(f"      ❌ 异常：{e}")
    print(f"\n输出：D:\\1Repo\\Github\\ComfyUI\\Library\\output\\{OUT}\\")


if __name__ == "__main__":
    main()
