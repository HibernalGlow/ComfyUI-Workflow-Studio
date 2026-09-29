"""
robo_mikan 原创角色 —— in-context 参考图正式页批量出图。
配置全部来自作品目录旁的 batch.toml（引擎本身不写死任何作品常量）。

用法：
    tools/run_batch.sh run_robo_mikan_batch.py              # 全部 6 页（正式版）
    tools/run_batch.sh run_robo_mikan_batch.py --only RM005 # 单页
    tools/run_batch.sh run_robo_mikan_batch.py 3            # 从第 3 页起
    tools/run_batch.sh run_robo_mikan_batch.py \
        --toml ../../Workflows/wild/storyboard/robo_mikan_OC/batch_silvermoon_noref.toml
                                                            # 换一份作品配置（对照实验）

需要 Python 3.11+（标准库 tomllib 解析 TOML）。
默认配置：
    Workflows/wild/storyboard/robo_mikan_OC/batch.toml
"""

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from story_config import load_story          # noqa: E402

WORK = Path("/Users/glow/Base/Works/ComfyUI/Workflows/wild/storyboard/robo_mikan_OC")


def pick_toml(argv):
    """--toml <path> 覆盖默认配置；该参数不会传给引擎（引擎会警告未知参数）。"""
    for i, a in enumerate(argv):
        if a == "--toml" and i + 1 < len(argv):
            p = Path(argv[i + 1])
            argv[:] = argv[:i] + argv[i + 2:]
            return p if p.is_absolute() else (Path.cwd() / p).resolve()
    env = os.environ.get("STORY_TOML")
    return Path(env) if env else WORK / "batch.toml"


if __name__ == "__main__":
    TOML = pick_toml(sys.argv)
    rtb, cfg, base_preset = load_story(TOML)

    if "--preset" not in sys.argv and base_preset:
        sys.argv += ["--preset", base_preset]

    print(f"📄 作品配置：{TOML}")
    print(f"   作品：{cfg.get('story', {}).get('name')}｜页面：{rtb.PAGES_DIR}")
    print(f"   基线 LoRA {len(rtb.LORAS)} 个｜逐页规则 {len(rtb.PAGE_RULES)} 条")

    rtb.main()
