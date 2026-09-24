"""
Z3 + 标准 30 步 preset（不用 Turbo）—— 同页对照

Z3 名单（你选的）：
    ustirrup-step00002000.safetensors  0.88
    stirrup3-1(preview0.2).safetensors 0.63
基线：Aesthetic 0.48 + healthyman 1.0 + rossi 1.0（Turbo 保留但由 preset 自动关掉）

preset = anima-native-30 → 30步 / CFG 4.0 / er_sde / beta57 / Turbo=Off
其余（名单、权重、seed、尺寸）全部不变，只换采样。
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

TEST_PAGES = ["RF003", "RS003", "RG001", "RS049"]

BASE = [
    ("On", "Turbo-v0.2",      r"anima\turbo\anima-turbo-lora-v0.2.safetensors",                 0.8,  1.0),
    ("On", "Aesthetic Boost", r"anima\beauty\anima-highres-aesthetic-boost.safetensors",        0.48, 1.0),
    ("On", "Healthyman",      r"anima\artist\260614\healthyman_v1_epoch28@hea1thy.safetensors", 1.0,  1.0),
    ("On", "Rossi v2 Anima",  r"anima\chara\endfield\rossi_v2_anima.safetensors",               1.0,  1.0),
]
Z3 = [
    ("On", "Ustirrup 2000", r"anima\action\footjob\ustirrup\ustirrup-step00002000.safetensors", 0.88, 1.0),
    ("On", "Stirrup 3-1",   r"anima\stirrup3-1(preview0.2).safetensors",                        0.63, 1.0),
]


def main() -> None:
    rtb.apply_preset("anima-native-30")          # ← 换的就是这一行
    rtb.LORAS = BASE + Z3
    rtb.QUALITY_PREFIX = "masterpiece, best quality, aesthetic, highly detailed, @hea1thy, uncensored"

    print(f"🧪 Z3 + native-30（{rtb.STEPS}步 CFG{rtb.CFG} {rtb.SAMPLER}/{rtb.SCHEDULER} "
          f"Turbo={rtb.TURBO_ENABLED}）")
    print(f"   页面：{TEST_PAGES}   seed={rtb.SEED} 固定")
    pages = {p.stem.split("—")[0]: p for p in sorted(rtb.PAGES_DIR.glob(rtb.PAGE_GLOB))}
    print("=" * 64)
    for code in TEST_PAGES:
        page = pages.get(code)
        if not page:
            print(f"❌ 找不到 {code}")
            continue
        print(f"\n[{code}] {page.stem}")
        try:
            wf = rtb.build_workflow(rtb.parse_txt(page), f"{OUT}/{page.stem}_Z3-native30")
            imgs = rtb.wait_done(rtb.queue_prompt(wf), timeout=420)
            print(f"      ✅ {imgs[0]['filename']}" if imgs else "      ❌ 超时/失败")
        except Exception as e:
            print(f"      ❌ 异常：{e}")
    print(f"\n输出：D:\\1Repo\\Github\\ComfyUI\\Library\\output\\{OUT}\\")


if __name__ == "__main__":
    main()
