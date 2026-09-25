"""
艾尼玛 (Anima) 底模 —— 穿鞋足交对照，用来和光辉 (zukiAnimeILL) 那批比。

对照关系（**两边的「鞋交」手段不同，这是关键**）：
  光辉  : 底模 zukiAnimeILL + sandaljob_illustr，触发词 5anda1j0b（LoRA 私有词，
          不是 danbooru tag）→ 靠 LoRA 画出「凉鞋蹭」
  艾尼玛: 底模 silvermoonmixAnima_v23 + footjob through footwear-000063，
          触发词就是原生 tag `footjob through footwear` → 靠 tag + LoRA

同一场景、同一 seed，tag 轴也照抄光辉那组，方便逐张对位：
  S1 只写触发词 / S2 满触发 / S3 带 danbooru 鞋 tag / S4 shoejob /
  S5 footjob through footwear / S6 对照(不写触发词)

角色：安卡希雅「东流映荷」形态 = ankasha_v1_anima(触发词 ankasha)
      + 形态 token dongliuyinhe（都是 LoRA 训练元数据里的，非猜测）

用法：
    tools/run_batch.sh run_anima_sandaljob.py
    tools/run_batch.sh run_anima_sandaljob.py A2 A5
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from story_config import engine          # noqa: E402

rtb = engine()

PRESET_ID  = "anima-two-stage-standard"      # 与琴柳正式跑批同一预设
OUT_SUBDIR = "艾尼玛_沙足测试"
SEED       = 88888888
MAC_OUT    = Path("/Users/glow/Base/Works/ComfyUI/Outputs")

# 角色 LoRA：安卡希雅（Anima 版，触发词 ankasha）；形态 token dongliuyinhe
ANKASHA = ("On", "Ankasha v1", r"anima\chara\snowbreak\ankasha_v1_anima.safetensors", 1.0, 1.0)
# 鞋交 LoRA：触发词 = 原生 tag `footjob through footwear`
THROUGH = ("On", "Footjob through footwear",
           r"anima\action\footjob through footwear-000063.safetensors", 1.0, 1.0)
# 同族姊妹件：触发词 `through`（throughfoot-000052）
SIBLING = ("On", "Throughfoot 52",
           r"anima\action\footjob\through\throughfoot-000052.safetensors", 0.8, 1.0)
SIB88   = ("On", "Throughfoot 88",
           r"anima\action\footjob\through\throughfoot-000088.safetensors", 0.5, 1.0)

# throughfoot 的训练集是大杂烩（34 图），污染源可枚举 —— 直接列进负面
# （取自它的 ss_tag_frequency：这些 tag 与「东流映荷露天足交」无关）
DEPOLLUTE = ("2boys, multiple boys, four boys, gangbang, gangbang sex, dark skin, "
             "large breasts, pool, poolside, beach, seaside, parasol, flip flops, "
             "hoodie, black hoodie, nude, anal, purple bodysuit, mask, glasses, "
             "braid, ponytail, my hero academia, mass effect")

# 两个 LoRA 训练词汇的并集
FOOT_FULL = ("footjob through footwear, footjob with sandals, sandals, shoe soles, "
             "feet, toes, soles, high heel sandals")
FOOT_BASE = "footjob through footwear, footjob with sandals, sandals, feet, toes, soles"

QUALITY = "masterpiece, best quality, aesthetic, highly detailed, uncensored"

# 与光辉侧 SUBJECT 对位（Anima 侧角色靠 LoRA + 形态 token）
SUBJECT = ("1girl, solo, ankasha, dongliuyinhe, silver hair, long hair, golden eyes, "
           "high heel sandals, 1boy, faceless male, penis, hetero")

NEGATIVE = ("worst quality, low quality, bad anatomy, bad hands, missing fingers, "
            "extra digit, fewer digits, watermark, text, extra feet, fused feet, "
            "extra toes, deformed toes, foot merged with another foot, 3d, render, cgi")

STACK = [("On", "Turbo-v0.2", r"anima\turbo\anima-turbo-lora-v0.2.safetensors", 0.8, 1.0),
         ("On", "Aesthetic Boost", r"anima\beauty\anima-highres-aesthetic-boost.safetensors", 0.48, 1.0),
         ANKASHA, THROUGH]

VARIANTS = [
    # ── A 组：tag 轴（已跑，留档）────────────────────────────
    ("A1-trigger-only",   "footjob through footwear",                                   "sitting, foot focus, close-up", STACK, ""),
    ("A2-full-trigger",   "footjob through footwear, footjob, sandals",                 "sitting, foot focus, close-up", STACK, ""),
    ("A3-with-sandals",   "footjob through footwear, footjob with sandals",             "sitting, foot focus, close-up", STACK, ""),
    ("A4-shoejob",        "footjob through footwear, shoejob",                          "sitting, foot focus, close-up", STACK, ""),
    ("A5-native-tag",     "footjob through footwear, footjob with footwear, sandals, high heel sandals", "sitting, foot focus, close-up", STACK, ""),
    ("A6-control-notrig", "footjob with sandals",                                      "sitting, foot focus, close-up", STACK, ""),

    # ── B 组：修正 tag 漏洞（已跑）────────────────────────────
    ("B1-traincore",    FOOT_BASE,  "sitting, foot focus", STACK, ""),
    ("B2-fullbody",     FOOT_BASE,  "sitting, full body, foot focus", STACK, ""),
    ("B3-shoesoles",    FOOT_FULL,  "sitting, foot focus", STACK, ""),
    ("B4-heels",        "footjob through footwear, footjob with sandals, high heel sandals, strappy heels, feet, toes, soles", "sitting, foot focus", STACK, ""),
    ("B5-w115",         FOOT_BASE,  "sitting, foot focus",
                        [STACK[0], STACK[1], ANKASHA, (THROUGH[0], THROUGH[1], THROUGH[2], 1.15, 1.0)], ""),
    ("B6-plus-sibling", FOOT_BASE,  "sitting, foot focus", STACK + [SIBLING], ""),

    # ── C 组：保插头 + 去污染 ────────────────────────────────
    # 依据：throughfoot 的鞋部词汇最全（toes 25 / soles 15 / shoe soles 12），
    # 插进去靠的就是它；污染源也全在它的 tag 表里，所以降权重 + 列负面。
    ("C1-sib88-w035",  FOOT_FULL, "sitting, foot focus", STACK + [SIB88], ""),
    ("C2-sib88-w050",  FOOT_FULL, "sitting, foot focus", STACK + [SIB88], ""),
    ("C3-sib88-w065",  FOOT_FULL, "sitting, foot focus",
                        STACK + [(SIB88[0], SIB88[1], SIB88[2], 0.65, 1.0)], ""),
    ("C4-sib52-w050",  FOOT_FULL, "sitting, foot focus",
                        STACK + [(SIBLING[0], SIBLING[1], SIBLING[2], 0.5, 1.0)], ""),
    ("C5-c2-depollute", FOOT_FULL, "sitting, foot focus", STACK + [SIB88], DEPOLLUTE),
    ("C6-c2-main115",   FOOT_FULL, "sitting, foot focus",
                        [STACK[0], STACK[1], ANKASHA,
                         (THROUGH[0], THROUGH[1], THROUGH[2], 1.15, 1.0), SIB88], DEPOLLUTE),
]

_want = [a for a in sys.argv[1:] if a[:1] in ("A", "B") and len(a) > 1 and a[1].isdigit()]
if _want:
    VARIANTS = [v for v in VARIANTS if v[0].split("-")[0] in _want]


def main() -> None:
    rtb.apply_preset(PRESET_ID)
    rtb.SEED = SEED
    rtb.MAC_OUT_DIR = MAC_OUT
    rtb.QUALITY_PREFIX = QUALITY
    rtb.NEGATIVE = NEGATIVE
    rtb.LORAS = STACK
    rtb.PAGE_RULES = []
    rtb.AUTO_ACTION_LORAS = False
    print(f"🧱 底模：silvermoonmixAnima_v23_INT8（引擎固定 832x1216）")
    print(f"🧱 LoRA：{' / '.join(l[1] for l in STACK)}")
    print(f"🎯 投递：队首（插队）")
    print(f"🧪 {len(VARIANTS)} 个变体，seed={SEED} 固定")
    print("=" * 70)

    for tag, foot_tags, framing, loras, extra_neg in VARIANTS:
        pos = f"{QUALITY}\n\n{SUBJECT}, {foot_tags}, {framing}"
        rtb.LORAS = loras
        rtb.NEGATIVE = f"{NEGATIVE}, {extra_neg}" if extra_neg else NEGATIVE
        print(f"\n[{tag}]\n      足交 tag：{foot_tags}\n      构图：{framing}")
        print(f"      LoRA：{' + '.join(f'{l[1]}@{l[3]}' for l in loras)}")
        if extra_neg:
            print(f"      额外负面：{extra_neg[:70]}…")
        try:
            wf = rtb.build_workflow(pos, f"{OUT_SUBDIR}/{tag}")
            pid = rtb.queue_prompt(wf, front=True)     # 插队
            print(f"      → {pid[:8]}…")
            imgs = rtb.wait_done(pid, timeout=600)
            if imgs:
                print(f"      ✅ {imgs[0]['filename']}")
                for p in rtb.fetch_images(imgs, MAC_OUT):
                    print(f"      ⬇️  {p}")
            else:
                print("      ❌ 超时/失败")
        except Exception as e:
            print(f"      ❌ {e}")

    print(f"\n{'=' * 70}\n输出：{MAC_OUT}/{OUT_SUBDIR}/")


if __name__ == "__main__":
    main()
