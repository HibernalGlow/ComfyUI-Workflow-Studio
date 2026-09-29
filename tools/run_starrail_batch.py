"""
《崩坏：星穹铁道》：流萤 · 流萤“春日来信” · 风堇 · 遐蝶 批量出图
配置来自 storyboard 目录旁的 batch.toml (SR*.txt，共40页)

底模：Silvermoon Base INT8 (silvermoonmixAnima_v23_INT8.safetensors)
画风：shufflesongdatiankongstyle_animaBasev1 (@shufflesongdatiankongstyle)

用法：
    tools/run_batch.sh run_starrail_batch.py [起始序号] [--tag 后缀]
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from story_config import load_story          # noqa: E402

TOML = Path("/Users/glow/Base/Works/ComfyUI/Workflows/wild/storyboard/"
            "星穹铁道_流萤_风堇_遐蝶/batch.toml")

if __name__ == "__main__":
    rtb, cfg, base_preset = load_story(TOML)

    # 没显式给 --preset 就用 TOML 里的默认预设
    if "--preset" not in sys.argv and base_preset:
        sys.argv += ["--preset", base_preset]

    print(f"📄 作品配置：{TOML}")
    print(f"   作品：{cfg.get('story', {}).get('name')}｜页面：{rtb.PAGES_DIR}")
    print(f"   页面匹配规则：{rtb.PAGE_GLOB}")
    print(f"   基线 LoRA {len(rtb.LORAS)} 个｜逐页规则 {len(rtb.PAGE_RULES)} 条")

    rtb.main()
