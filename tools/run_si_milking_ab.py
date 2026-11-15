"""
祀·榨精协议 —— 马形阳具 A/B 对照（直接出 vs 加 LoRA）

基线完全读作品 batch.toml（预设 / 负面 / 画风 @atdan / 角色 LoRA 都不动），
只换下面几件事（同页同 seed 20261027 横向比）：
  a0   现状：页面原样（含 horse penis / animal penis）
  a1   去掉 (horse penis:0.7)，只留 (animal penis:0.8)
  a2   A0 + 巨根 LoRA 0.6（huge-penis-insertion，触发词 penis）
  a3   A0 + Freaky dicks 0.6（pearlyfrd；2026-10-27 新装）
  p    A0 + 本页对应玩法 LoRA（手交 / 深喉 / 肛指+扩肛）
  a3p  a3 + 本页玩法 LoRA（最终候选组合）
  m1   A0 + Improved Horsecock 0.8（触发 equine penis）
  m2   m1 但删掉 horse/animal tag（只靠 LoRA）
  m3   A0 + Hyper Horse Cock 0.6（触发 Hyper Horse Cock, Thick Medial Ring）
  m4   m3 但删掉 horse/animal tag

玩法 LoRA 按页挂（见 PLAY）：MK004 手交、MK009 深喉、MK030 肛、MK040 无。

判定三件事：
  ① 龟头是否外翻  ② 中段有没有环  ③ 有没有长出马头/马身/四条腿

为什么生成临时页面文件而不是在 prompt 字符串上改：
  parse_txt() 只接收 Path，且会把 QUALITY_PREFIX 拼进去；
  生成临时文件能保证除 horse tag / 追加触发词外，逐字节与原页一致。

用法：
    tools/run_batch.sh run_si_milking_ab.py --dry          # 只看提示词差异，不投递
    tools/run_batch.sh run_si_milking_ab.py                # 4 页 × 6 变体（MK040 少 p/a3p）= 22 张
    tools/run_batch.sh run_si_milking_ab.py --pages MK030  # 只跑指定页
    tools/run_batch.sh run_si_milking_ab.py --variants a0,a2,a3
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from story_config import load_story          # noqa: E402

TOML = Path("/Users/glow/Base/Works/ComfyUI/Workflows/wild/storyboard/"
            "2610/261027/祀_榨精协议/batch.toml")

OUT_SUBDIR = "祀—新玩法_ab"
SEED       = 20261027                 # 固定种子，三组之间才可比
LOG_NAME   = "AB-RUN-LOG.json"

TEST_CODES = ["MK004", "MK009", "MK030", "MK040"]

HORSE_TAG  = "(horse penis:0.7)"
BIG_LORA   = ("On", "huge-penis-insertion",
              r"anima\huge-penis-insertion-anima-base.safetensors", 0.6, 1.0)
BIG_TRIGGER = r"(penis:1.0)"           # 原生 tag，只给 A2 当 LoRA 触发词

FREAKY_LORA    = ("On", "freaky-dicks",
                  r"anima\action\penis\freaky_dicks_anima.safetensors", 0.6, 1.0)
FREAKY_TRIGGER = "pearlyfrd"           # Civitai 作者给的唯一触发词

# 马形 LoRA（2026-10-27 新装）
IMP_HORSE_LORA = ("On", "improved-horsecock",
                  r"anima\action\penis\improved_horsecock_anima.safetensors", 0.8, 1.0)
IMP_HORSE_TRIG = "equine penis"
HYP_HORSE_LORA = ("On", "hyper-horsecock",
                  r"anima\action\penis\hyper_horsecock_anima.safetensors", 0.6, 1.0)
HYP_HORSE_TRIG = "Hyper Horse Cock, Thick Medial Ring"

ANIMAL_TAG = "(animal penis:0.8)"

# 玩法 LoRA 按页挂：(额外 LoRA 列表, 前缀追加触发词)
JOBS = ("On", "hj-from-side",
        r"anima\action\handjob\hj_from_side_v3_anima.safetensors", 0.8, 1.0)
PLAY = {
    "MK004": ([JOBS], "handjob_from_side"),
    "MK009": ([("On", "extreme-deepthroat",
                r"anima\action\oral\extreme_deepthroat_anima.safetensors", 0.7, 1.0)],
              "extremedeepthroat, throat bulge"),
    "MK030": ([("On", "sex-anal-fingering",
                r"anima\action\anal\sex_anal_fingering_anima.safetensors", 0.75, 1.0),
               ("On", "anal-gape-slider",
                r"anima\action\anal\anal_gape_slider_anima.safetensors", 0.6, 1.0)],
              "anal fingering, sex from behind, anus"),
    # MK040 是体外射精页，没有对应的插入/口交玩法 LoRA → 不挂
}

SOCK_OLD = "(stirrup legwear:1.3), (toeless legwear:1.2), mary janes"
# 同库（拉菲II）验证过的写法：白色 + 踩脚 + 白裤袜 + 露趾露跟
SOCK_WHITE = ("(white stirrup legwear:1.3), (stirrup legwear:1.3), "
              "white pantyhose, bare toes, bare heels, mary janes")
# 用户口径：只说明是踩脚的，不写任何袜色
SOCK_MIN = "(stirrup legwear:1.3), bare toes, bare heels, mary janes"

# (标号, 说明, 要删的 tag 列表, 额外 LoRA 列表, 前缀追加词,
#  是否叠玩法 LoRA, 追加到男角的 tag, 追加负面, caption 追加句, 袜子写法)
VARIANTS = [
    ("a0",  "A0 现状（horse + animal）",        [],            [],           None,           False, None, None, None, None),
    ("a1",  "A1 去 horse，只留 animal",          ["horse"],     [],           None,           False, None, None, None, None),
    ("a2",  "A2 A0 + 巨根 LoRA 0.6",            [],            [BIG_LORA],   BIG_TRIGGER,    False, None, None, None, None),
    ("a3",  "A3 A0 + Freaky dicks 0.6",         [],            [FREAKY_LORA], FREAKY_TRIGGER, False, None, None, None, None),
    ("p",   "P  A0 + 本页玩法 LoRA",            [],            [],           None,           True,  None, None, None, None),
    ("a3p", "A3P A3 + 本页玩法 LoRA",           [],            [FREAKY_LORA], FREAKY_TRIGGER, True,  None, None, None, None),
    # —— 马形专项：2026-10-27 用户反馈「就是普通人」后新增 ——
    ("m1",  "M1 Improved Horsecock 0.8 + 原 tags",       [],                 [IMP_HORSE_LORA], IMP_HORSE_TRIG, False, None, None, None, None),
    ("m2",  "M2 Improved Horsecock 0.8，去 horse/animal",  ["horse","animal"], [IMP_HORSE_LORA], IMP_HORSE_TRIG, False, None, None, None, None),
    ("m3",  "M3 Hyper Horse Cock 0.6 + 原 tags",          [],                 [HYP_HORSE_LORA], HYP_HORSE_TRIG, False, None, None, None, None),
    ("m4",  "M4 Hyper Horse Cock 0.6，去 horse/animal",    ["horse","animal"], [HYP_HORSE_LORA], HYP_HORSE_TRIG, False, None, None, None, None),
    # —— 调色：M1 形状通过，皮肤太黑（2026-10-27 用户反馈） ——
    ("c1",  "C1 M1 + 粉屌 tag，压暗屌",
     [], [IMP_HORSE_LORA], IMP_HORSE_TRIG, False,
     "(pink penis:1.2)", "(dark penis:1.2)", None, None),
    ("c2",  "C2 M1 + 浅肤/粉屌，压暗肤/暗屌",
     [], [IMP_HORSE_LORA], IMP_HORSE_TRIG, False,
     "(pale skin:1.2), (pink penis:1.2)", "(dark skin:1.1), (dark penis:1.2)", None, None),
    ("c3",  "C3 M1 + 轻量粉屌 + caption 写明浅粉",
     [], [IMP_HORSE_LORA], IMP_HORSE_TRIG, False,
     "(pink penis:1.0)", "(dark penis:1.1)",
     "The shaft is pale pink, the glans a slightly deeper pink, and the medial ring sits in a lighter band.", None),
    ("c4",  "C4 M1 降到 0.6 + 浅肤/粉屌",
     [], [("On", "improved-horsecock",
           r"anima\action\penis\improved_horsecock_anima.safetensors", 0.6, 1.0)],
     IMP_HORSE_TRIG, False,
     "(pale skin:1.2), (pink penis:1.2)", "(dark skin:1.1), (dark penis:1.2)", None, None),
    # —— c5/c6：修根部发黑 + 袜子 + futa（2026-10-27 用户反馈） ——
    ("c5",  "C5 c1 + 压 two-tone/mottled/futanari + 白色踩脚袜 + caption 统一浅粉",
     [], [IMP_HORSE_LORA], IMP_HORSE_TRIG, False,
     "(pink penis:1.3)",
     ("(dark penis:1.3), (two-tone penis:1.3), (mottled penis:1.3), "
      "(futanari:1.4), (dickgirl:1.4), (female penis:1.3), "
      "(girl penis:1.3), (newhalf:1.2)"),
     "The entire shaft, from root to tip, is a uniform pale pink; the base is not darker than the rest.",
     "white"),
    ("c6",  "C6 c5 但只写踩脚（不写袜色）+ 去 colored extremities",
     [], [IMP_HORSE_LORA], IMP_HORSE_TRIG, False,
     "(pink penis:1.3)",
     ("(dark penis:1.3), (two-tone penis:1.3), (mottled penis:1.3), "
      "(futanari:1.4), (dickgirl:1.4), (female penis:1.3), "
      "(girl penis:1.3), (newhalf:1.2)"),
     "The entire shaft, from root to tip, is a uniform pale pink; the base is not darker than the rest.",
     "minimal"),
]


def strip_tag(text: str, tag: str) -> str:
    """按逗号边界删掉一个 tag，避免留下 ,, 或悬空逗号。"""
    for pat in (f", {tag}", f"{tag}, ", tag):
        if pat in text:
            text = text.replace(pat, "", 1)
    return text


def add_to_male_line(text: str, extra: str) -> str:
    """把 extra 追加到以 `1boy,` 开头的那一行末尾（只改男角，不动女角/场景）。"""
    lines = text.splitlines()
    for i, ln in enumerate(lines):
        if ln.strip().startswith("1boy,"):
            lines[i] = ln.rstrip() + ", " + extra
            return "\n".join(lines)
    raise AssertionError("页面里找不到 `1boy,` 行，无法追加男角 tag")


def parse_args() -> tuple:
    pages, variants, dry = [], [], False
    argv = sys.argv[1:]
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--dry":
            dry = True
            i += 1
        elif a == "--pages" and i + 1 < len(argv):
            pages = [c.strip().upper() for c in argv[i + 1].split(",") if c.strip()]
            i += 2
        elif a == "--variants" and i + 1 < len(argv):
            variants = [c.strip().lower() for c in argv[i + 1].split(",") if c.strip()]
            i += 2
        else:
            i += 1
    return (pages or TEST_CODES, variants, dry)


def main() -> None:
    codes, want_variants, dry = parse_args()
    variants = [v for v in VARIANTS if not want_variants or v[0] in want_variants]
    if not variants:
        print("❌ 没有匹配的变体，可用：", ", ".join(v[0] for v in VARIANTS))
        return

    rtb, cfg, base_preset = load_story(TOML)
    base_loras = list(rtb.LORAS)
    base_negative = rtb.NEGATIVE
    prefix_tmpl = cfg["prompt"]["quality_prefix"]

    rtb.SEED = SEED
    rtb.SEED_FIXED = True                # build_workflow 直接读 SEED
    if base_preset:
        rtb.apply_preset(base_preset)
    rtb.MAC_OUT_DIR = Path(cfg["output"]["mac_dir"])

    # 临时页面目录：放在作品目录里（可复用、不污染 pages/ 的 MK*.txt 通配）
    scratch = TOML.parent / "ab_pages"
    scratch.mkdir(exist_ok=True)

    print(f"📄 基线：{TOML}")
    print(f"🧱 底座 LoRA：{' / '.join(l[1] for l in base_loras)}")
    total = sum(1 for c in codes for v in variants
                if v[0] not in ("p", "a3p") or c in PLAY)
    print(f"🧪 {len(codes)} 页 × ≤{len(variants)} 变体 = {total} 张"
          f"｜seed={SEED}｜预设={base_preset}")
    print(f"📁 输出：{OUT_SUBDIR}/（回传 {rtb.MAC_OUT_DIR}/{OUT_SUBDIR}）")
    print("=" * 78)

    results = []
    for code in codes:
        hits = sorted(rtb.PAGES_DIR.glob(f"{code}*.txt"))
        if not hits:
            print(f"❌ 找不到页面：{code}")
            continue
        src = hits[0]
        raw = src.read_text(encoding="utf-8")
        if HORSE_HIT := (HORSE_TAG in raw):
            print(f"\n■ {src.stem}（含 {HORSE_TAG}）")
        else:
            print(f"\n■ {src.stem}（⚠️ 原页没有 {HORSE_TAG}）")

        for (vid, desc, drops, extra_loras, trig, use_play,
             male_add, neg_add, cap_add, sock_mode) in variants:
            if use_play and code not in PLAY:
                print(f"\n  [{vid}] {desc} → 跳过（{code} 没有对应玩法 LoRA）")
                continue

            body = raw
            if "horse" in drops:
                assert HORSE_HIT, "原页本就没有 horse tag，去 horse 无意义"
                body = strip_tag(body, HORSE_TAG)
            if "animal" in drops:
                assert ANIMAL_TAG in raw, "原页没有 animal penis tag"
                body = strip_tag(body, ANIMAL_TAG)
            if "horse" in drops:
                assert HORSE_TAG not in body, "horse tag 没删干净"
            if "animal" in drops:
                assert ANIMAL_TAG not in body, "animal tag 没删干净"

            body = add_to_male_line(body, male_add) if male_add else body
            if sock_mode == "white":
                assert SOCK_OLD in body, "页面里找不到默认袜子写法"
                body = body.replace(SOCK_OLD, SOCK_WHITE)
            elif sock_mode == "minimal":
                assert SOCK_OLD in body, "页面里找不到默认袜子写法"
                body = body.replace(SOCK_OLD, SOCK_MIN)
                body = body.replace("colored extremities, ", "")
            if cap_add:
                body = body.rstrip() + "\n" + cap_add + "\n"

            tmp_page = scratch / f"{src.stem}_{vid}.txt"
            tmp_page.write_text(body, encoding="utf-8")

            loras = list(extra_loras)
            trigs = [trig] if trig else []
            if use_play:
                play_loras, play_trig = PLAY[code]
                loras += list(play_loras)
                trigs.append(play_trig)

            rtb.LORAS = base_loras + loras
            # 触发词追加到 quality_prefix：仅本变体生效，不会泄漏到正式批次
            rtb.QUALITY_PREFIX = ", ".join([prefix_tmpl] + [t for t in trigs if t])
            rtb.NEGATIVE = (f"{base_negative}, {neg_add}" if neg_add
                            else base_negative)

            positive = rtb.parse_txt(tmp_page)
            base_paths = {l[2].lower() for l in rtb.LORAS}
            stack = (list(rtb.LORAS)
                     + rtb.auto_action_loras(positive, base_paths))
            prefix = f"{OUT_SUBDIR}/{src.stem}_{vid}"

            print(f"\n  [{vid}] {desc}")
            print(f"       seed={rtb.SEED}｜LoRA栈 {len(stack)}: "
                  + " / ".join(f"{l[1]}@{l[3]}" for l in stack))
            print(f"       删 tag：{drops or '无'}｜"
                  f"触发词：{', '.join(trigs) or '(无追加)'}")
            if male_add or neg_add or cap_add or sock_mode:
                print(f"       男角追加：{male_add or '无'}｜"
                      f"负面追加：{neg_add or '无'}｜caption 追加：{cap_add or '无'}｜"
                      f"袜子：{sock_mode or '原样'}")

            if dry:
                print("       [dry] 正向提示词：")
                for ln in positive.splitlines():
                    if ln.strip():
                        print(f"         {ln}")
                results.append({"page": code, "variant": vid, "dry": True})
                continue

            try:
                wf = rtb.build_workflow(positive, prefix)
                pid = rtb.queue_prompt(wf)
                print(f"       → prompt_id={pid[:8]}…")
                imgs = rtb.wait_done(pid, timeout=rtb.WAIT_TIMEOUT)
                if not imgs:
                    print("       ❌ 超时/失败")
                    results.append({"page": code, "variant": vid, "ok": False})
                    continue
                print(f"       ✅ {imgs[0]['filename']}")
                saved = rtb.fetch_images(imgs, rtb.MAC_OUT_DIR)
                for p in saved:
                    print(f"       ⬇️  {p}")
                results.append({
                    "page": code, "variant": vid, "ok": True,
                    "seed": rtb.SEED, "prompt_id": pid,
                    "file": imgs[0]["filename"],
                    "mac": [str(p) for p in saved],
                })
            except Exception as e:
                print(f"       ❌ 异常：{e}")
                results.append({"page": code, "variant": vid, "ok": False,
                                "error": str(e)})

    if dry:
        print("\n✅ 干跑完成：没有投递任何任务。")
        return

    ok = sum(1 for r in results if r.get("ok"))
    print(f"\n{'=' * 78}\n✅ 成功 {ok} / {len(results)}")
    for r in results:
        if not r.get("ok"):
            print(f"   FAIL {r['page']} {r['variant']} → {r.get('error', '超时')}")

    log = TOML.parent / LOG_NAME
    log.write_text(json.dumps({
        "seed": SEED, "preset": base_preset,
        "tests": results,
    }, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"🧾 运行日志：{log}")
    print("   判定：① 龟头外翻 ② 中段环 ③ 无马头/马身/四条腿；定稿后回灌 batch.toml")


if __name__ == "__main__":
    main()
