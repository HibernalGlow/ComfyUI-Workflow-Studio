"""
竜华妃咲 (Kisaki) 批量出图 —— 配置全部来自 storyboard 目录旁的 batch.toml

用法：
    tools/run_batch.sh run_kisaki_batch.py [起始序号] [--only XM001,XM002]

需要 Python 3.11+（标准库 tomllib 解析 TOML）。
配置改在作品目录里，不再需要动代码：
    Workflows/wild/storyboard/蔚蓝档案_妃咲/batch.toml

本作关键配置（详见 batch.toml 注释与 character_map.md）：
    · 画风     = Kedama Milk `@mi1k`（anima_mi1k_v1.3-epoch16），[base] 第 3 位，权重 1.0
    · 角色 LoRA = SW 页 kisaki_(swimsuit) 1.0 ／ KP 页 kiki_swimsuit_v2 1.0
    · 采样分流  = 34 页双层（anima-two-stage-standard）／ 16 页 30 步全扩散（anima-native-30）
                  30 步那 16 页 = 10 个足交页 + 6 个足部特写页，由 page_rule 强制
"""

import sys
from pathlib import Path

# ⚠️ 作品目录名含中文，Python 源码必须声明 UTF-8（py3 默认即 UTF-8，这里显式说明用途）
TOML = Path("/Users/glow/Base/Works/ComfyUI/Workflows/wild/storyboard/"
            "蔚蓝档案_妃咲/batch.toml")

sys.path.insert(0, str(Path(__file__).resolve().parent))
from story_config import load_story          # noqa: E402

if __name__ == "__main__":
    rtb, cfg, base_preset = load_story(TOML)

    if "--preset" not in sys.argv and base_preset:
        sys.argv += ["--preset", base_preset]

    print(f"📄 作品配置：{TOML}")
    print(f"   作品：{cfg.get('story', {}).get('name')}｜页面：{rtb.PAGES_DIR}")
    print(f"   基线 LoRA {len(rtb.LORAS)} 个｜逐页规则 {len(rtb.PAGE_RULES)} 条"
          f"｜规则库：{rtb.LORA_RULES_FILE.name}")

    rtb.main()
