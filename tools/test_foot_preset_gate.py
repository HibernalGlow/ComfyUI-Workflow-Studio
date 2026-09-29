#!/usr/bin/env python3
"""
踩脚页采样闸门回归测试 —— 不需要 GPU / 不需要 ComfyUI，纯函数级验证。

守的是这一条规矩：
    把足部当主体来玩的页面（足交 / 踩踏 / 足底膜拜 / 足心搔痒 …）
    绝不允许跑「双彩」（双层采样）。镫袜类 LoRA 的足心横带、足弓、脚趾
    结构在少步数下吃不满，出来必烂。

同时守反向规矩（防狼来了）：
    · 服饰标签（stirrup legwear）不该触发告警 —— 它每页都有
    · 取景标签（foot focus）只算软提醒，不该当门禁
    · 非足部页（发交 / 开宫）不该被告警

用法：python3 tools/test_foot_preset_gate.py
退出码：0 = 全通；1 = 有用例失败。
"""

import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from story_config import engine              # noqa: E402

rtb = engine()

FAILS = []


def check(name, got, want):
    ok = got == want
    print(f"  {'✅' if ok else '❌'} {name}")
    if not ok:
        print(f"       期望 {want!r}，实际 {got!r}")
        FAILS.append(name)


def hits_with(mode, text):
    """按给定采样模式跑一遍闸门，返回命中的手法关键词。"""
    return rtb.check_foot_preset(text, "some-preset", sampling_mode=mode)


print("踩脚页采样闸门回归测试")
print("=" * 70)

# ── 1. 硬门槛：真正的足部玩法，跑双彩必须告警 ──────────────────────
print("\n[1] 足部玩法 × 双彩 → 必须告警")
for text in [
    "1girl, (under-stirrup footjob:1.3), dual footjob, motion lines",
    "stepping on another, foot on chest, foot on penis, looking down",
    "foot worship, kissing foot, licking toes",
    "(foot tickling:1.3), toe scrunch, wriggling toes, foot in hand",
    "suspension by red silk ribbons, footjob, rubbing corona with sole",
]:
    check(f"告警 {text[:46]}…", bool(hits_with("double", text)), True)

# ── 2. 同一批页面走全扩散 → 不该告警 ──────────────────────────────
print("\n[2] 足部玩法 × 全扩散 → 不告警")
for text in [
    "1girl, (under-stirrup footjob:1.3), dual footjob",
    "stepping on another, foot on chest, foot on penis",
    "foot worship, kissing foot",
]:
    check(f"放行 {text[:46]}…", hits_with("single", text), [])

# ── 3. 防狼来了：服饰 / 取景标签不该进硬门槛 ──────────────────────
print("\n[3] 服饰/取景标签不该触发硬告警")
for text in [
    "1girl, (white stirrup legwear:1.3), (stirrup legwear:1.3), bare toes, bare heels",
    "unworn geta, presenting own foot, sitting on bridge railing",
    "close-up, foot focus, sole focus, detailed foot arch, perfect toes",
]:
    check(f"不告警 {text[:46]}…", hits_with("double", text), [])

# ── 4. 非足部玩法页不该被告警 ─────────────────────────────────────
print("\n[4] 非足部页不该被告警")
for text in [
    "hairjob, twin braids, wrapping hair around penis, handjob",
    "missionary, vaginal, (cervical penetration:1.3), (stomach bulge:1.2)",
    "afterglow, resting head on male lap, cum stains, peaceful smile",
]:
    check(f"不告警 {text[:46]}…", hits_with("double", text), [])

# ── 5. foot_allow_presets 白名单能放行 ────────────────────────────
print("\n[5] foot_allow_presets 白名单生效")
saved = rtb.FOOT_ALLOW_PRESETS
try:
    rtb.FOOT_ALLOW_PRESETS = {"anima-native-30"}
    check("白名单内预设不告警",
          rtb.check_foot_preset("footjob, dual footjob", "anima-native-30",
                                sampling_mode="double"), [])
    check("白名单外预设照旧告警",
          bool(rtb.check_foot_preset("footjob, dual footjob", "other-preset",
                                     sampling_mode="double")), True)
finally:
    rtb.FOOT_ALLOW_PRESETS = saved

# ── 6. double_presets 手动点名能兜住 ─────────────────────────────
print("\n[6] double_presets 手动点名生效")
saved = rtb.DOUBLE_PRESETS
try:
    rtb.DOUBLE_PRESETS = {"weird-preset"}
    check("点名预设被告警",
          bool(rtb.check_foot_preset("footjob, dual footjob", "weird-preset",
                                     sampling_mode="single")), True)
finally:
    rtb.DOUBLE_PRESETS = saved

# ── 7. 边界感知：不该被子串误伤 ───────────────────────────────────
print("\n[7] 边界感知（不被子串误伤）")
check("barefoot 不命中 bare soles pressing",
      hits_with("double", "1girl, barefoot, standing"), [])
check("foot focus 不进硬门槛",
      hits_with("double", "1girl, foot focus, close-up"), [])

print("\n" + "=" * 70)
if FAILS:
    print(f"❌ {len(FAILS)} 个用例失败：")
    for f in FAILS:
        print(f"   · {f}")
    sys.exit(1)
print("✅ 全部用例通过 —— 踩脚页采样闸门工作正常。")
sys.exit(0)
