"""
Z1 / Z3 换页复核 —— 验证 RF003 上的结论不是单页偶然

Z1 = ustirrup1500 0.8 + stirrupjob50 0.8   （主件+强化，压到 0.8）
Z3 = ustirrup2000 0.88 + stirrup3-1 0.63   （梨诺全套里天然 ≤1 的那两个）

两组都**只挂这 2 个**（不带 age_slider / footRepair），基线固定
Turbo 0.8 + Aesthetic 0.48 + healthyman 1.0 + rossi 1.0。
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

TEST_PAGES = ["RS003", "RG001", "RS049"]   # 换页：RS 阵营 / RG 体操 / RS 高叉

BASE = [
    ("On", "Turbo-v0.2",      r"anima\turbo\anima-turbo-lora-v0.2.safetensors",                 0.8,  1.0),
    ("On", "Aesthetic Boost", r"anima\beauty\anima-highres-aesthetic-boost.safetensors",        0.48, 1.0),
    ("On", "Healthyman",      r"anima\artist\260614\healthyman_v1_epoch28@hea1thy.safetensors", 1.0,  1.0),
    ("On", "Rossi v2 Anima",  r"anima\chara\endfield\rossi_v2_anima.safetensors",               1.0,  1.0),
]

Z1 = ("Z1-mainpair-only", [
    ("On", "Ustirrup 1500", r"anima\action\footjob\ustirrup\ustirrup-step00001500.safetensors", 0.8, 1.0),
    ("On", "Stirrupjob 50", r"anima\action\footjob\stirrupjob\stirrupjob-000050.safetensors",   0.8, 1.0),
])
Z3 = ("Z3-lowpair-only", [
    ("On", "Ustirrup 2000", r"anima\action\footjob\ustirrup\ustirrup-step00002000.safetensors", 0.88, 1.0),
    ("On", "Stirrup 3-1",   r"anima\stirrup3-1(preview0.2).safetensors",                        0.63, 1.0),
])


def main() -> None:
    rtb.apply_preset("anima-two-stage-standard")
    pages = {p.stem.split("—")[0]: p for p in sorted(rtb.PAGES_DIR.glob(rtb.PAGE_GLOB))}
    print(f"🧪 换页复核：{TEST_PAGES} × [Z1, Z3]，seed={rtb.SEED} 固定")
    print("=" * 64)
    for code in TEST_PAGES:
        page = pages.get(code)
        if not page:
            print(f"❌ 找不到 {code}")
            continue
        for tag, extra in (Z1, Z3):
            rtb.LORAS = BASE + extra
            rtb.QUALITY_PREFIX = ("masterpiece, best quality, aesthetic, highly detailed, "
                                  "@hea1thy, uncensored")
            print(f"\n[{code} {tag}] {len(rtb.LORAS)} 个 LoRA")
            try:
                wf = rtb.build_workflow(rtb.parse_txt(page), f"{OUT}/{page.stem}_{tag}")
                imgs = rtb.wait_done(rtb.queue_prompt(wf), timeout=300)
                print(f"      ✅ {imgs[0]['filename']}" if imgs else "      ❌ 超时/失败")
            except Exception as e:
                print(f"      ❌ 异常：{e}")
    print(f"\n输出：D:\\1Repo\\Github\\ComfyUI\\Library\\output\\{OUT}\\")


if __name__ == "__main__":
    main()
