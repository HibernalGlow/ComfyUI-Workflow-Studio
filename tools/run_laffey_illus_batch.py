"""
拉菲II (Laffey II) —— Illustrious 线批量出图

配置来自 storyboard 目录旁的 batch_illus.toml（与 anima 线的 batch.toml 并列、互不干扰）。

用法：
    tools/run_batch.sh run_laffey_illus_batch.py [起始序号] [--only LF008,LF021] [--tag 后缀]

需要 Python 3.11+（标准库 tomllib 解析 TOML）。
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from story_config import load_story          # noqa: E402

TOML = Path("/Users/glow/Base/Works/ComfyUI/Workflows/wild/storyboard/"
            "碧蓝航线_拉菲II/batch_illus.toml")

if __name__ == "__main__":
    rtb, cfg, base_preset = load_story(TOML)

    if "--preset" not in sys.argv and base_preset:
        sys.argv += ["--preset", base_preset]

    print(f"📄 作品配置：{TOML}")
    print(f"   作品：{cfg.get('story', {}).get('name')}｜页面：{rtb.PAGES_DIR}")
    print(f"   架构：{getattr(rtb, 'ARCH', 'anima')}｜checkpoint：{getattr(rtb, 'CKPT_NAME', '-')}")
    print(f"   基线 LoRA {len(rtb.LORAS)} 个｜逐页规则 {len(rtb.PAGE_RULES)} 条"
          f"｜自动规则：{'开' if rtb.AUTO_ACTION_LORAS else '关'}")

    rtb.main()
