"""
《崩坏：星穹铁道》（爻光、火花、花火）批量出图
配置全部来自 storyboard 目录旁的 batch.toml

底模：Silvermoon Base INT8 (silvermoonmixAnima_v23_INT8.safetensors)
画风：Freng (@freng.safetensors)

用法：
    tools/run_batch.sh run_yaoguang_batch.py [起始序号] [--only YSH001,YSH002] [--tag 后缀]
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from story_config import load_story          # noqa: E402

TOML = Path("/Users/glow/Base/Works/ComfyUI/Workflows/wild/storyboard/"
            "星穹铁道_爻光_火花_花火/batch.toml")

if __name__ == "__main__":
    rtb, cfg, base_preset = load_story(TOML)

    # 没显式给 --preset 就用 TOML 里的默认预设
    if "--preset" not in sys.argv and base_preset:
        sys.argv += ["--preset", base_preset]

    print(f"📄 作品配置：{TOML}")
    print(f"   作品：{cfg.get('story', {}).get('name')}｜页面：{rtb.PAGES_DIR}")
    print(f"   基线 LoRA {len(rtb.LORAS)} 个｜逐页规则 {len(rtb.PAGE_RULES)} 条"
          f"｜规则库：{'关闭' if not rtb.AUTO_ACTION_LORAS else rtb.LORA_RULES_FILE.name}")

    rtb.main()
