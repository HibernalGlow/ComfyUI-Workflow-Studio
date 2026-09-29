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


def registered_images(timeout: int = 15):
    """从运行中的 ComfyUI 拿 LoadImage 可用图片名单。取不到返回 None。"""
    try:
        with urllib.request.urlopen(f"http://{COMFY_HOST}/object_info/LoadImage", timeout=timeout) as r:
            d = json.loads(r.read().decode("utf-8"), strict=False)
        return set(d["LoadImage"]["input"]["required"]["image"][0])
    except Exception as e:
        print(f"⚠️  拿不到已注册图片名单（{e}）—— 跳过参考图注册校验\n")
        return None


def main() -> int:
    argv = [a for a in sys.argv[1:]]
    quiet = "--quiet" in argv
    no_backend = "--no-backend" in argv
    warn_only = "--warn-only" in argv
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
    if rtb.ARCH == "anima-incontext":
        ref_names = ", ".join(r.get("image", "") for r in rtb.INCONTEXT.get("refs", []))
        print(f"   架构：anima-incontext ｜ 参考图：{ref_names or '无'}")
        if rtb.NL_APPEND:
            print(f"   追加自然语言 (nl_append)：已配置（{len(rtb.NL_APPEND)} 字符）")
    print("=" * 78)

    preset_use = Counter()
    lora_use = OrderedDict()          # path -> [name, mw, pages]
    page_plans = []
    leaks = []                        # 预设「沿用上一页」的页 —— 引擎状态泄漏的哨兵
    foot_warns = []                   # 踩脚页跑双彩 —— 采样告警（每项 = (code, preset, hits)）
    frame_notes = []                  # 足部取景页跑双彩 —— 只提醒（每项 = (code, preset, hits)）

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
        # ── 采样验证闸：踩脚页不该跑双彩 ──────────────────────
        foot_hits = rtb.check_foot_preset(positive, preset)
        if foot_hits:
            foot_warns.append((code, preset, foot_hits))
        elif rtb.SAMPLING_MODE == "double":
            fh = rtb.foot_frame_hits(positive)
            if fh:
                frame_notes.append((code, preset, fh))
        for _n, p, mw, _cw, _src in stack:
            e = lora_use.setdefault(p.lower(), [Path(p.replace("\\", "/")).stem, mw, []])
            e[2].append(code)

        rule_names = " + ".join(r.get("name", "?") for r in rules) or "—"
        page_plans.append((code, rule_names, preset, stack))
        if not quiet:
            print(f"\n[{i:03d}/{len(pages)}] {code}   规则：{rule_names}")
            print(f"         预设：{preset}" + ("   ⚠️ 沿用上一页" if psrc == "inherit" else ""))
            if rtb.ARCH == "anima-incontext":
                canvas = rtb.resolve_page_canvas(page.stem)
                pw = canvas.get("width") or rtb.WIDTH
                ph = canvas.get("height") or rtb.HEIGHT
                pe = canvas.get("end_percent") if canvas.get("end_percent") is not None else rtb.INCONTEXT.get("end_percent", 0.90)
                print(f"         画布：{pw}x{ph}  end_percent={pe}")
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

    # ── 采样告警：踩脚页跑双彩 ────────────────────────────────
    if foot_warns:
        print("\n" + "━" * 78)
        print(f"⛔ 采样告警：{len(foot_warns)} 个踩脚页解析到「双彩」（双层采样）预设")
        print("━" * 78)
        for code, preset, hits in foot_warns:
            shown = ", ".join(hits[:6]) + (" …" if len(hits) > 6 else "")
            print(f"   {code}  →  {preset}")
            print(f"          命中踩脚关键词：{shown}")
        print()
        print("   镫袜/踩脚 LoRA 的足心横带、足弓、脚趾结构在少步数下吃不满，")
        print("   走双层采样（双彩）必烂 —— 这类页面应改走全扩散（例 30 步）。")
        print("   修法二选一：")
        print("     ① 给页规则的 when_triggers 补词，并设 preset = \"anima-native-30\"")
        print("     ② 若确实要保留双彩，把该预设写进 [validation].foot_allow_presets")
        print("━" * 78)
    else:
        print("\n✅ 采样验证：没有踩脚页落到双彩预设。")

    # ── 软提醒：足部取景页跑双彩（只提示，不拦）────────────────
    if frame_notes:
        print(f"\nℹ️  另 {len(frame_notes)} 个足部取景页走双彩（foot focus 类词，不当门禁）：")
        for code, preset, hits in frame_notes[:10]:
            print(f"   {code}  →  {preset}   ({', '.join(hits[:3])})")
        if len(frame_notes) > 10:
            print(f"   … 共 {len(frame_notes)} 页")
        print("   若脚部结构崩坏，可考虑把这些页也改 native-30。")

    print("\nLoRA 用量（按命中页数排序）：")
    for p, (stem, mw, pgs) in sorted(lora_use.items(), key=lambda kv: -len(kv[1][2])):
        print(f"   {len(pgs):>4} 页  w={mw:<6} {stem}")

    # ── 注册校验 ───────────────────────────────────────────────
    ref_missing = []
    if rtb.ARCH == "anima-incontext":
        refs = rtb.INCONTEXT.get("refs", [])
        if len(refs) == 1:
            print("\n⚠️  [in-context 软提醒] 只有 1 张参考图（下半身/细节可能无参考来源，模型会自由发挥）")
        elif len(refs) >= 2:
            ref_imgs = [r.get("image", "") for r in refs]
            if len(set(ref_imgs)) < len(ref_imgs):
                print("\n⚠️  [in-context 软提醒] 两张参考图来自同一源图（存在复印机风险）")

        if not no_backend:
            imgs = registered_images()
            if imgs is not None:
                for r in refs:
                    im = r.get("image", "")
                    if im and im not in imgs:
                        ref_missing.append(im)

    if no_backend:
        return 0 if (warn_only or not foot_warns) else 1
    reg = registered_loras()
    if reg is None:
        return 0 if (warn_only or not foot_warns) else 1

    missing = [p for p in lora_use if p not in reg]
    print("\n" + "=" * 78)
    if missing:
        print(f"❌ {len(missing)} 条 LoRA 路径**未注册**（投递会 400）：")
        for p in missing:
            print(f"   {p}")
        print("\n   常见原因：目录写错（outfit vs clothes）、文件名拼错、文件未落盘。")
        return 1
    print(f"✅ 全部 {len(lora_use)} 条 LoRA 路径均已注册。")

    if rtb.ARCH == "anima-incontext":
        if ref_missing:
            print(f"❌ {len(ref_missing)} 张参考图未在 ComfyUI input 注册（投递会 400）：")
            for im in ref_missing:
                print(f"   {im}")
            print("\n   请将参考图放入 ComfyUI 的 input/ 目录。")
            if not warn_only:
                return 1
        else:
            refs = rtb.INCONTEXT.get("refs", [])
            if refs:
                print(f"✅ 全部 {len(refs)} 张参考图均已在 ComfyUI input 注册。")

    if foot_warns and not warn_only:
        print(f"⛔ 但有 {len(foot_warns)} 个踩脚页跑双彩（见上方采样告警）—— 退出码 1")
        print("   确需放行可加 --warn-only。")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
