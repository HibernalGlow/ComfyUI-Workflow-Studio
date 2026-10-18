"""
祀 · 雪线长夜（60 页）—— 批量出图，配置全部来自作品目录 batch.toml

用法：
    tools/run_batch.sh run_si_snowline_batch.py 1
    tools/run_batch.sh run_si_snowline_batch.py 1 --only SL017,SL028
    tools/run_batch.sh run_si_snowline_batch.py 1 --tag _v2
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from story_config import load_story          # noqa: E402

TOML = Path("/Users/glow/Base/Works/ComfyUI/Workflows/wild/storyboard/"
            "2607/260723/祀_雪线长夜/batch.toml")

if __name__ == "__main__":
    rtb, cfg, base_preset = load_story(TOML)

    if "--preset" not in sys.argv and base_preset:
        sys.argv += ["--preset", base_preset]

    print(f"📄 作品配置：{TOML}")
    print(f"   作品：{cfg.get('story', {}).get('name')}｜页面：{rtb.PAGES_DIR}")
    print(f"   基线 LoRA {len(rtb.LORAS)} 个｜逐页规则 {len(rtb.PAGE_RULES)} 条"
          f"｜规则库：{rtb.LORA_RULES_FILE.name}")

    rtb.main()
