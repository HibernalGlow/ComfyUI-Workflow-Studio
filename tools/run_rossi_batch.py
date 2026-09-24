"""
洛茜 (Rossi) 正式批量 —— 画师定稿：healthyman

复用 run_typhon_batch.py 的全部管线（预设装载 / 组图 / 投递 / 断点续跑 /
连续失败中止），只覆盖本作的路径与 LoRA 组合。

用法：
  python run_rossi_batch.py [起始序号] [--preset anima-native-30] [--tag 后缀]

发型：不自作改动，直接读页面原文（190 页已于 01:10-01:11 全部定稿为 low twintails）。
"""

import importlib.util
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("rtb", HERE / "run_typhon_batch.py")
rtb = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(rtb)

# ─── 覆盖为本作配置 ───────────────────────────────────────────
rtb.PAGES_DIR = Path("/Users/glow/Base/Works/ComfyUI/Workflows/wild/storyboard/明日方舟终末地_洛茜/pages")
rtb.PAGE_GLOB = "R*.txt"          # 洛茜页面：RB/RS/RY… 前缀
rtb.OUTPUT_SUBDIR = "明日方舟终末地_洛茜"

# 镫袜页专用预设：命中 stirrup 捆绑的页改用原生 30 步（无 Turbo），其余页仍走
# 命令行给的预设（turbo+双层）。名单/权重/seed/尺寸都不变，只换采样。
rtb.STIRRUP_PRESET = "anima-native-30"

# 画师定稿 = healthyman（触发词 @hea1thy，注意与文件名 healthyman 不一致）
# Turbo 放在第一位：由预设决定开关 ——
#   anima-two-stage-standard（turbo+双层）→ 自动 On
#   anima-native-30（原生30步）          → 自动 Off
rtb.QUALITY_PREFIX = (
    "masterpiece, best quality, aesthetic, highly detailed, @hea1thy, uncensored"
)
rtb.LORAS = [
    # 顺序沿用已验证管线：加速 → 品质 → 画师 → 角色
    ("On", "Turbo-v0.2",      r"anima\turbo\anima-turbo-lora-v0.2.safetensors",                            0.8,  1.0),
    ("On", "Aesthetic Boost", r"anima\beauty\anima-highres-aesthetic-boost.safetensors",                   0.48, 1.0),
    ("On", "Healthyman",      r"anima\artist\260614\healthyman_v1_epoch28@hea1thy.safetensors",            1.0,  1.0),
    ("On", "Rossi v2 Anima",  r"anima\chara\endfield\rossi_v2_anima.safetensors",                          1.0,  1.0),
]

if __name__ == "__main__":
    if "--preset" not in sys.argv:
        sys.argv += ["--preset", "anima-native-30"]
    rtb.main()
