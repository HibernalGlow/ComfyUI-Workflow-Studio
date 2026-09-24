"""
镫袜足交 LoRA 污染排查 —— 单页阶梯对照

同一页、同一 seed、同一预设（turbo+双层），只增删动作 LoRA，
逐级隔离到底是哪一层把 healthyman 画风带偏了。

  AB1-base4        仅基线4个（无任何动作 LoRA）= 画风基准
  AB2-stirrup2     + ustirrup1500 1.2 + stirrupjob50 1.1
  AB3-s2-age135    + age_slider -1.35
  AB4-s2-age-foot  + footRepair 0.88
  AB5-current11    + ustirrup2000/stirrup3-1/throughfoot（= 当前 11 个的配方）

自动补挂被显式关掉，确保每组挂的就是清单里那些。
"""

import importlib.util
from pathlib import Path

HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("rtb", HERE / "run_typhon_batch.py")
rtb = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(rtb)

rtb.PAGES_DIR = Path("/Users/glow/Base/Works/ComfyUI/Workflows/wild/storyboard/明日方舟终末地_洛茜/pages")
rtb.PAGE_GLOB = "R*.txt"
rtb.AUTO_ACTION_LORAS = False          # 关键：不让自动补挂掺进来
rtb.SEED = 88888888
OUT = "明日方舟终末地_洛茜_调参"

PAGE_CODE = "RF003"

TURBO = ("On", "Turbo-v0.2",      r"anima\turbo\anima-turbo-lora-v0.2.safetensors",              0.8,  1.0)
AESTH = ("On", "Aesthetic Boost", r"anima\beauty\anima-highres-aesthetic-boost.safetensors",     0.48, 1.0)
HEAL  = ("On", "Healthyman",      r"anima\artist\260614\healthyman_v1_epoch28@hea1thy.safetensors", 1.0, 1.0)
ROSSI = ("On", "Rossi v2 Anima",  r"anima\chara\endfield\rossi_v2_anima.safetensors",            1.0,  1.0)

U1500 = ("On", "Ustirrup 1500", r"anima\action\footjob\ustirrup\ustirrup-step00001500.safetensors", 1.2,  1.0)
SJ50  = ("On", "Stirrupjob 50", r"anima\action\footjob\stirrupjob\stirrupjob-000050.safetensors",   1.1,  1.0)
U2000 = ("On", "Ustirrup 2000", r"anima\action\footjob\ustirrup\ustirrup-step00002000.safetensors", 0.88, 1.0)
S31   = ("On", "Stirrup 3-1",   r"anima\stirrup3-1(preview0.2).safetensors",                        0.63, 1.0)
TF    = ("On", "Through Foot",  r"anima\action\footjob\through\throughfoot-000052.safetensors",     1.0,  1.0)
AGE   = ("On", "Age Slider",    r"anima\action\age\age_slider_old-step00000300-1.5.safetensors",  -1.35, 1.0)
FOOT  = ("On", "Foot Repair",   r"anima\action\anima_footRepair_v2-tri-@footRepair.safetensors",    0.88, 1.0)

BASE = [TURBO, AESTH, HEAL, ROSSI]

VARIANTS = [
    ("AB1-base4",        []),
    ("AB2-stirrup2",     [U1500, SJ50]),
    ("AB3-s2-age135",    [U1500, SJ50, AGE]),
    ("AB4-s2-age-foot",  [U1500, SJ50, AGE, FOOT]),
    ("AB5-current11",    [U1500, SJ50, U2000, S31, TF, AGE, FOOT]),
]


def main() -> None:
    rtb.apply_preset("anima-two-stage-standard")
    pages = {p.stem.split("—")[0]: p for p in sorted(rtb.PAGES_DIR.glob(rtb.PAGE_GLOB))}
    page = pages[PAGE_CODE]
    print(f"🎨 基准画师 = healthyman 触发词 @hea1thy")
    print(f"🧪 页面 {PAGE_CODE}（{page.stem}）× {len(VARIANTS)} 组，seed={rtb.SEED} 固定")
    print("=" * 64)

    for tag, extra in VARIANTS:
        rtb.LORAS = BASE + extra
        rtb.QUALITY_PREFIX = ("masterpiece, best quality, aesthetic, highly detailed, "
                              "@hea1thy, uncensored")
        prefix = f"{OUT}/{page.stem}_{tag}"
        print(f"\n[{tag}] 共 {len(rtb.LORAS)} 个 LoRA")
        try:
            wf = rtb.build_workflow(rtb.parse_txt(page), prefix)
            pid = rtb.queue_prompt(wf)
            imgs = rtb.wait_done(pid, timeout=300)
            print(f"      ✅ {imgs[0]['filename']}" if imgs else "      ❌ 超时/失败")
        except Exception as e:
            print(f"      ❌ 异常：{e}")

    print(f"\n输出：D:\\1Repo\\Github\\ComfyUI\\Library\\output\\{OUT}\\")


if __name__ == "__main__":
    main()
