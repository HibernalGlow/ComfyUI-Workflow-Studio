"""
祀 · ask 画风美感单张 —— 配置全部来自 storyboard 目录旁的 batch.toml

用法：
    tools/run_batch.sh run_si_ask_batch.py [起始序号] [--only AK002] [--tag _v2]
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from story_config import load_story          # noqa: E402

TOML = Path("/Users/glow/Base/Works/ComfyUI/Workflows/wild/storyboard/明日方舟终末地_祀_ask美感/batch.toml")

if __name__ == "__main__":
    rtb, cfg, base_preset = load_story(TOML)

    if "--preset" not in sys.argv and base_preset:
        sys.argv += ["--preset", base_preset]

    print(f"📄 作品配置：{TOML}")
    print(f"   作品：{cfg.get('story', {}).get('name')}｜页面：{rtb.PAGES_DIR}")
    print(f"   基线 LoRA {len(rtb.LORAS)} 个")

    rtb.main()
