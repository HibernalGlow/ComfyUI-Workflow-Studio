"""
批量出图 dry-run —— **不投递、不出图**，只把每页会挂什么算给你看。

用法：
    tools/dryrun_batch.py <作品 batch.toml 路径> [--quiet] [--no-backend]

做三件事：
  1. 逐页打印命中的页规则、最终预设、LoRA 栈（基线 + 逐页规则 + 规则库补挂）
  2. 汇总打印预设用量、每条 LoRA 的命中页数与权重
  3. 若后端可达，逐一核对 LoRA 路径是否**已注册**（能查出行尾拼错 / 目录写错，
     例如 character_map 把 anima\\outfit 写成 anima\\clothes）

退出码：0 = 全部 LoRA 路径已注册（或后端不可达且未强制检查）；1 = 有路径未注册。
"""

import json
import sys
import urllib.request
from collections import Counter, OrderedDict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from story_config import load_story          # noqa: E402

COMFY_HOST = "127.0.0.1:8188"
REGISTERED_API = f"http://{COMFY_HOST}/object_info/CR%20LoRA%20Stack"


def registered_loras(timeout: int = 15):
    """从运行中的 ComfyUI 拿已注册 LoRA 名单（小写、反斜杠归一）。取不到返回 None。"""
    try:
        with urllib.request.urlopen(REGISTERED_API, timeout=timeout) as r:
            d = json.loads(r.read().decode("utf-8"), strict=False)
        names = d["CR LoRA Stack"]["input"]["required"]["lora_name_1"][0]
        return {n.replace("/", "\\").lower() for n in names}
    except Exception as e:
        print(f"⚠️  拿不到已注册 LoRA 名单（{e}）—— 跳过注册校验\n")
        return None


def main() -> int:
    argv = [a for a in sys.argv[1:]]
    quiet = "--quiet" in argv
    no_backend = "--no-backend" in argv
    argv = [a for a in argv if not a.startswith("--")]
    if not argv:
        print(__doc__)
        return 2
    toml = Path(argv[0])

    rtb, cfg, base_preset = load_story(toml)
    pages = sorted(rtb.PAGES_DIR.glob(rtb.PAGE_GLOB))

    print(f"📄 {toml}")
    print(f"   作品：{cfg.get('story', {}).get('name')}｜页面：{rtb.PAGES_DIR}")
    print(f"   匹配 {rtb.PAGE_GLOB}：{len(pages)} 页")
    print(f"   底模：{rtb.UNET_NAME}")
    print(f"   基线预设：{base_preset}｜基线 LoRA：{' / '.join(l[1] for l in rtb.LORAS)}")
    print(f"   正向前缀：{rtb.QUALITY_PREFIX}")
    print("=" * 78)

    preset_use = Counter()
    lora_use = OrderedDict()          # path -> [name, mw, pages]
    page_plans = []
    leaks = []                        # 预设「沿用上一页」的页 —— 引擎状态泄漏的哨兵

    # 引擎是**有状态**的，且预设决策只在 resolve_preset() 里定义 —— 干跑直接调它，
    # 不自己再写一遍分支（历史上两边各写一遍，结果干跑报 92/8、实际跑成 12/88）。
    current_preset = None
    for i, page in enumerate(pages, 1):
        code = page.stem.split("—")[0]
        positive = rtb.parse_txt(page)
        preset, psrc, rules = rtb.resolve_preset(positive, base_preset, current_preset)
        current_preset = preset
        if psrc == "inherit":
            leaks.append(code)
        if preset:                                 # inherit 时 preset 为 None，不调 apply_preset
            rtb.apply_preset(preset, quiet=True)

        base_paths = {l[2].lower() for l in rtb.LORAS}
        extra = rtb.auto_action_loras(positive, set(base_paths))
        stack = [(l[1], l[2], l[3], l[4], "base") for l in rtb.LORAS]
        stack += [(n, p, mw, cw, "rule") for _s, n, p, mw, cw in extra]

        preset_use[preset or "(沿用上一页)"] += 1
        for _n, p, mw, _cw, _src in stack:
            e = lora_use.setdefault(p.lower(), [Path(p.replace("\\", "/")).stem, mw, []])
            e[2].append(code)

        rule_names = " + ".join(r.get("name", "?") for r in rules) or "—"
        page_plans.append((code, rule_names, preset, stack))
        if not quiet:
            print(f"\n[{i:03d}/{len(pages)}] {code}   规则：{rule_names}")
            print(f"         预设：{preset}" + ("   ⚠️ 沿用上一页" if psrc == "inherit" else ""))
            for n, p, mw, cw, src in stack:
                print(f"           · {n:<18} w={mw:<6} {p}")
            if rtb.TURBO_ENABLED is False:
                print("           (Turbo=Off)")

    # ── 汇总 ───────────────────────────────────────────────────
    print("\n" + "=" * 78)
    print("预设用量：")
    for k, v in preset_use.most_common():
        print(f"   {v:>4} 页  {k}")
    if leaks:
        print(f"\n⚠️  {len(leaks)} 页的预设是**沿用上一页**的（既没命中规则、也没回基线）：")
        print(f"    {', '.join(leaks[:24])}{' …' if len(leaks) > 24 else ''}")
        print("    这通常意味着引擎里的预设回退分支又被写坏了。")

    print("\nLoRA 用量（按命中页数排序）：")
    for p, (stem, mw, pgs) in sorted(lora_use.items(), key=lambda kv: -len(kv[1][2])):
        print(f"   {len(pgs):>4} 页  w={mw:<6} {stem}")

    # ── 注册校验 ───────────────────────────────────────────────
    if no_backend:
        return 0
    reg = registered_loras()
    if reg is None:
        return 0

    missing = [p for p in lora_use if p not in reg]
    print("\n" + "=" * 78)
    if missing:
        print(f"❌ {len(missing)} 条 LoRA 路径**未注册**（投递会 400）：")
        for p in missing:
            print(f"   {p}")
        print("\n   常见原因：目录写错（outfit vs clothes）、文件名拼错、文件未落盘。")
        return 1
    print(f"✅ 全部 {len(lora_use)} 条 LoRA 路径均已注册。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
