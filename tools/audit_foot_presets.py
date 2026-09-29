#!/usr/bin/env python3
"""
踩脚页采样审计 —— 扫所有作品的 batch.toml，找出「踩脚页跑了双彩」的坑。

为什么需要它：
    镫袜 / 踩脚类 LoRA 的足心横带、足弓、脚趾结构在双层采样（双彩，例 5+12 步）
    下根本吃不满，出来必烂。这类页面必须走全扩散（例 anima-native-30：30 步 /
    CFG4.0 / er_sde / 无 Turbo）。

    单靠人眼盯 batch.toml 是盯不住的 —— 谁忘了给某个踩踏关键词加触发词，
    谁就会被静默地送回双彩。这个脚本把这件事变成一次可复跑的审计。

用法：
    python3 tools/audit_foot_presets.py                 # 扫整个 storyboard 目录
    python3 tools/audit_foot_presets.py <作品目录>       # 只扫一个作品
    python3 tools/audit_foot_presets.py <作品目录> -v    # 逐页打印

退出码：0 = 没有踩脚页落双彩；1 = 有（CI / 跑批前门禁可用）。
"""

import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from story_config import load_story          # noqa: E402

STORYBOARD = Path("/Users/glow/Base/Works/ComfyUI/Workflows/wild/storyboard")


def audit_one(toml: Path, verbose: bool = False):
    """审计单个作品，返回 (踩脚页总数, [(code, preset, hits), ...])。"""
    try:
        rtb, cfg, base_preset = load_story(toml)
    except SystemExit as e:
        return 0, [], [f"配置读取失败：{e}"]
    except Exception as e:
        return 0, [], [f"配置异常：{type(e).__name__}: {e}"]

    if not rtb.PAGES_DIR.is_dir():
        return 0, [], [f"pages 目录不存在：{rtb.PAGES_DIR}"]

    pages = sorted(rtb.PAGES_DIR.glob(rtb.PAGE_GLOB))
    if not pages:
        return 0, [], [f"没有页面匹配 {rtb.PAGE_GLOB}"]

    foot_total = 0
    warns = []
    for page in pages:
        code = page.stem.split("—")[0]
        positive = rtb.parse_txt(page)
        preset, _psrc, _rules = rtb.resolve_preset(positive, base_preset, None)
        if preset:
            rtb.apply_preset(preset, quiet=True)
        hits = rtb.foot_play_hits(positive)
        if not hits:
            fh = rtb.foot_frame_hits(positive)
            if fh and verbose:
                print(f"      ℹ️  {code}  {preset}  mode={rtb.SAMPLING_MODE}  "
                      f"取景：{', '.join(fh[:3])}")
            continue
        foot_total += 1
        bad = rtb.check_foot_preset(positive, preset)
        mode = rtb.SAMPLING_MODE
        if verbose:
            mark = "⛔" if bad else "✅"
            print(f"      {mark} {code}  {preset}  mode={mode}  {', '.join(hits[:4])}")
        if bad:
            warns.append((code, preset, hits))
    return foot_total, warns, []


def main() -> int:
    argv = [a for a in sys.argv[1:] if not a.startswith("-")]
    verbose = "-v" in sys.argv or "--verbose" in sys.argv
    root = Path(argv[0]).expanduser().resolve() if argv else STORYBOARD

    if (root / "batch.toml").is_file():
        tomls = [root / "batch.toml"]
    else:
        tomls = sorted(root.glob("*/batch.toml"))

    if not tomls:
        print(f"❌ 没找到任何 batch.toml（扫的是 {root}）")
        return 1

    print(f"🔍 踩脚页采样审计｜扫 {len(tomls)} 个作品｜根目录 {root}")
    print("=" * 78)

    total_foot = 0
    total_warn = 0
    bad_projects = []
    skipped = []

    for toml in tomls:
        name = toml.parent.name
        foot_total, warns, errs = audit_one(toml, verbose)
        if errs:
            skipped.append((name, errs[0]))
            continue
        total_foot += foot_total
        if warns:
            total_warn += len(warns)
            bad_projects.append((name, warns))
            print(f"\n⛔ {name}")
            for code, preset, hits in warns:
                shown = ", ".join(hits[:5]) + (" …" if len(hits) > 5 else "")
                print(f"     {code}  →  {preset}")
                print(f"            命中踩脚关键词：{shown}")
        elif verbose:
            print(f"\n✅ {name}（踩脚页 {foot_total} 个，全部合规）")

    print("\n" + "=" * 78)
    print(f"踩脚页总数：{total_foot}｜不合规：{total_warn}")
    if skipped:
        print(f"\n⚠️  跳过 {len(skipped)} 个作品（读不了 / 没页面）：")
        for name, why in skipped[:12]:
            print(f"   {name}：{why}")

    if bad_projects:
        print("\n⛔ 以下作品的踩脚页在跑「双彩」（镫袜 LoRA 吃不满，必烂）：")
        for name, warns in bad_projects:
            codes = ", ".join(c for c, _p, _h in warns[:8])
            print(f"   {name}：{codes}")
        print("\n   修法：给该页的 [[page_rule]] 补 preset = \"anima-native-30\"，")
        print("   并把漏掉的踩踏/足部关键词补进 when_triggers。")
        return 1

    print("\n✅ 所有踩脚页均未落到双彩预设。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
