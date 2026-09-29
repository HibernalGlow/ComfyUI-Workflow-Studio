"""
飞鸟马时 (Toki) 中秋故事板批量出图 —— 配置全部来自 storyboard 目录旁的 batch.toml

用法：
    tools/run_batch.sh run_toki_batch.py [起始序号] [--only 飞鸟马时-010-中秋-高衩骑月]

需要 Python 3.11+（标准库 tomllib 解析 TOML）。
配置文件：
    Workflows/wild/storyboard/2609/260927/蔚蓝档案/第1批_2025年9月前/飞鸟马时/batch.toml
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from story_config import load_story          # noqa: E402

TOML = Path("/Users/glow/Base/Works/ComfyUI/Workflows/wild/storyboard/2609/260927/蔚蓝档案/第1批_2025年9月前/飞鸟马时/batch.toml")

if __name__ == "__main__":
    rtb, cfg, base_preset = load_story(TOML)

    if "--preset" not in sys.argv and base_preset:
        sys.argv += ["--preset", base_preset]

    print(f"📄 作品配置：{TOML}")
    print(f"   作品：{cfg.get('story', {}).get('name')}｜页面：{rtb.PAGES_DIR}")
    print(f"   基线 LoRA {len(rtb.LORAS)} 个｜逐页规则 {len(rtb.PAGE_RULES)} 条"
          f"｜规则库：{rtb.LORA_RULES_FILE.name}")

    rtb.main()
