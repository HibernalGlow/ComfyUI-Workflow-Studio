"""
学园偶像大师 批量出图 —— 配置全部来自 storyboard 目录旁的 batch.toml
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from story_config import load_story          # noqa: E402

TOML = Path("/Users/glow/Base/Works/ComfyUI/Workflows/wild/storyboard/"
            "学园偶像大师_篠泽广_十王星南_秦谷美铃/batch.toml")

if __name__ == "__main__":
    rtb, cfg, base_preset = load_story(TOML)

    if "--preset" not in sys.argv and base_preset:
        sys.argv += ["--preset", base_preset]

    print(f"📄 作品配置：{TOML}")
    print(f"   作品：{cfg.get('story', {}).get('name')}｜页面：{rtb.PAGES_DIR}")
    print(f"   基线 LoRA {len(rtb.LORAS)} 个｜逐页规则 {len(rtb.PAGE_RULES)} 条")

    rtb.main()
