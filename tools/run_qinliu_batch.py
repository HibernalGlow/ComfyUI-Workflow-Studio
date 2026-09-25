"""
琴柳 (Saileach) 批量出图 —— 配置全部来自 storyboard 目录旁的 batch.toml

用法：
    tools/run_batch.sh run_qinliu_batch.py [起始序号] [--only SL003,SL041] [--tag 后缀]

需要 Python 3.11+（标准库 tomllib 解析 TOML）。
3.9 / 3.10 上可先 `python3 -m pip install --user tomli` 再运行。

配置改在作品目录里，不再需要动代码：
    Workflows/wild/storyboard/明日方舟_琴柳/batch.toml
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from story_config import load_story          # noqa: E402

TOML = Path("/Users/glow/Base/Works/ComfyUI/Workflows/wild/storyboard/"
            "明日方舟_琴柳/batch.toml")

if __name__ == "__main__":
    rtb, cfg, base_preset = load_story(TOML)

    # 没显式给 --preset 就用 TOML 里的默认预设
    if "--preset" not in sys.argv and base_preset:
        sys.argv += ["--preset", base_preset]

    print(f"📄 作品配置：{TOML}")
    print(f"   作品：{cfg.get('story', {}).get('name')}｜页面：{rtb.PAGES_DIR}")
    print(f"   基线 LoRA {len(rtb.LORAS)} 个｜逐页规则 {len(rtb.PAGE_RULES)} 条"
          f"｜规则库：{rtb.LORA_RULES_FILE.name}")

    rtb.main()
