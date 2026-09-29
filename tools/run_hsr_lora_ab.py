"""
星穹铁道 爻光 / 火花(Sparxie) / 花火(Sparkle) —— 角色 LoRA 候选横评

底模不认识这三个角色，必须先选出该挂哪份角色 LoRA。
本脚本照 run_qinliu_artists.py 的路子：**基线完全读作品 batch.toml**
（预设 / 正负面前缀 / 动作规则 / 回传都一样），只把「角色 LoRA + 其触发词」
这一项轮换掉，同页同 seed，横向比。

本作 batch.toml 目前**没有**角色 page_rule，所以候选直接以 [base] 追加项注入，
每次渲染保证栈里只有 1 个角色 LoRA —— 不会出现两份角色 LoRA 互抢。

用法：
    tools/run_batch.sh run_hsr_lora_ab.py              # 全部候选
    tools/run_batch.sh run_hsr_lora_ab.py C1 S2 X1     # 只跑指定标号
    tools/run_batch.sh run_hsr_lora_ab.py --chars 爻光  # 只跑某个角色
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from story_config import load_story          # noqa: E402

TOML = Path("/Users/glow/Base/Works/ComfyUI/Workflows/wild/storyboard/"
            "星穹铁道_爻光_火花_花火/batch.toml")

OUT_SUBDIR = "星铁角色AB"
SEED       = 20260927            # 固定种子，候选之间才可比

# 每个角色挑一页：走普通双层采样（不落踩脚规则，省一半时间），
# 且都带 explicit 正词（penis / sex / vaginal / cervical penetration），
# 这样一次同时能看出两件事：① 角色 LoRA 像不像  ② SFW 负词问题修好没
TEST_PAGE = {
    "爻光":   "YSH007—a01爻光-棋局逆转.txt",      # cowgirl, erect penis
    "火花":   "YSH017—a02火花-道具木箱.txt",      # missionary, sex
    "花火":   "YSH025—a03花火-抵死宫口.txt",      # missionary, vaginal
}

# (标号, 角色, LoRA元组, 触发词)
# 触发词 = None 表示页面 [tags] 里已经有该词（原生 Danbooru tag），不用再加；
# 非原生的私有触发词一律按 anima-storyboard 政策写成 (token:1.3)。
# LoRA 元组填 None = **不挂角色 LoRA 的对照组** —— 没有它就无法判断候选到底有没有起作用。
T = r"_test_hsr"
CANDIDATES = [
    # ── 对照组：不挂任何角色 LoRA（= 底模原生识别能力）
    ("C0", "爻光", None, None),
    ("S0", "花火", None, None),
    ("X0", "火花", None, None),

    # ── 爻光（Danbooru 原生 tag 是 yao guang，带空格；下面几个训练者都用了不带空格的 yaoguang）
    ("C1", "爻光", ("On", "爻光·Techannel 2962601",
                    rf"{T}\yaoguang_techannel.safetensors", 0.8, 1.0),
     r"(yaoguanghsr:1.3)"),
    ("C2", "爻光", ("On", "爻光·HermitST 2840605",
                    rf"{T}\yaoguang_hermitst.safetensors", 0.8, 1.0),
     r"(yaoguang \(honkai: star rail\):1.3)"),
    ("C3", "爻光", ("On", "爻光·Qiyuan 合集",
                    rf"{T}\col_yaoguang.safetensors", 0.9, 1.0),
     r"(yaoguang:1.3)"),
    ("C4", "爻光", ("On", "爻光·Shenrui_Ma 2419122 (α4→scale0.25 补偿)",
                    rf"{T}\yaoguang_shenrui.safetensors", 1.3, 1.0),
     r"(yaoguang:1.3)"),

    # ── 花火 Sparkle（原生 tag sparkle \(honkai: star rail\)）
    ("S1", "花火", ("On", "花火·CopperSulfate 2676266 (500图)",
                    rf"{T}\sparkle_coppersulfate.safetensors", 0.9, 1.0),
     r"(sparkle \(honkai\):1.3)"),
    ("S2", "花火", ("On", "花火·Tomosimp 918078 (4.2Kdl/80图/双角色)",
                    rf"{T}\sparkle_sparxie_tomosimp.safetensors", 1.0, 1.0),
     r"(sparklehsr:1.3)"),
    ("S3", "花火", ("On", "花火·Qiyuan 合集",
                    rf"{T}\col_sparkle.safetensors", 0.9, 1.0),
     None),

    # ── 火花 Sparxie（原生 tag sparxie \(honkai: star rail\)，页面已带）
    ("X1", "火花", ("On", "火花·szyrus 2920905 (2245图 α4→scale0.25 补偿)",
                    rf"{T}\sparxie_szyrus.safetensors", 1.2, 1.0),
     None),
    ("X2", "火花", ("On", "火花·Qiyuan 合集",
                    rf"{T}\col_sparxie.safetensors", 0.9, 1.0),
     None),
    ("X3", "火花", ("On", "火花·storyAura 2714372 (51图)",
                    rf"{T}\sparxie_storyaura.safetensors", 1.0, 1.0),
     None),
]


def main() -> None:
    argv = sys.argv[1:]
    want_ids, want_chars, only = [], [], False
    i = 0
    while i < len(argv):
        if argv[i] == "--chars" and i + 1 < len(argv):
            want_chars = [c.strip() for c in argv[i + 1].split(",") if c.strip()]
            i += 2
            continue
        if argv[i].startswith("--"):
            i += 1
            continue
        want_ids.append(argv[i])
        i += 1
    only = bool(want_ids or want_chars)

    cands = CANDIDATES
    if want_ids:
        cands = [c for c in cands if c[0] in want_ids]
    if want_chars:
        cands = [c for c in cands if c[1] in want_chars]
    if not cands:
        print("❌ 没有匹配的候选。可用标号：", ", ".join(c[0] for c in CANDIDATES))
        return

    rtb, cfg, base_preset = load_story(TOML)
    base_loras = list(rtb.LORAS)          # Turbo / Aesthetic / Freng / FootRepair
    prefix_tmpl = cfg["prompt"]["quality_prefix"]

    rtb.SEED = SEED
    rtb.apply_preset(base_preset)
    rtb.MAC_OUT_DIR = Path("/Users/glow/Base/Works/ComfyUI/Outputs")

    pages = set()
    for _id, ch, _lora, _trig in cands:
        pages.add(ch)

    print(f"📄 基线来自：{TOML}")
    print(f"🧱 共用底座：{' / '.join(l[1] for l in base_loras)}")
    print(f"🧪 {len(pages)} 个角色 × 候选 {len(cands)} 个 = {len(cands)} 张，seed={SEED} 固定")
    print(f"📁 输出：{OUT_SUBDIR}/（并回传 {rtb.MAC_OUT_DIR}/{OUT_SUBDIR}）")
    print("=" * 72)

    results = []
    for cid, ch, lora, trig in cands:
        page = rtb.PAGES_DIR / TEST_PAGE[ch]
        if not page.is_file():
            print(f"❌ 找不到页面：{page}")
            continue
        rtb.LORAS = base_loras + ([lora] if lora else [])
        rtb.QUALITY_PREFIX = (f"{prefix_tmpl}, {trig}" if trig else prefix_tmpl)

        stem = page.stem
        prefix = f"{OUT_SUBDIR}/{stem}_{cid}"
        print(f"\n[{cid}] {ch} · {stem}")
        print(f"      角色LoRA：{lora[1] + f'（w={lora[3]}）' if lora else '【对照组·不挂】'}")
        print(f"      触发词：{trig or '(原生 tag 已在页面里，不加)'}")
        print(f"      采样：{rtb.STEPS}步 CFG{rtb.CFG} {rtb.SAMPLER}/{rtb.SCHEDULER} "
              f"Turbo={'On' if rtb.TURBO_ENABLED else 'Off'}")
        try:
            wf = rtb.build_workflow(rtb.parse_txt(page), prefix)
            pid = rtb.queue_prompt(wf)
            print(f"      → prompt_id={pid[:8]}…")
            imgs = rtb.wait_done(pid)
            if imgs:
                print(f"      ✅ {imgs[0]['filename']}")
                for p in rtb.fetch_images(imgs, rtb.MAC_OUT_DIR):
                    print(f"      ⬇️  {p}")
                results.append({"id": cid, "ch": ch, "ok": True, "file": imgs[0]["filename"]})
            else:
                print("      ❌ 超时/失败")
                results.append({"id": cid, "ch": ch, "ok": False, "file": None})
        except Exception as e:
            print(f"      ❌ 异常：{e}")
            results.append({"id": cid, "ch": ch, "ok": False, "file": str(e)})

    ok = sum(1 for r in results if r["ok"])
    print(f"\n{'=' * 72}\n✅ 成功 {ok} / {len(results)}")
    for r in results:
        if not r["ok"]:
            print(f"   FAIL {r['id']} {r['ch']} → {r['file']}")
    if ok:
        print(f"\n同页同 seed，横向比。定稿后把中选 LoRA 写进 {TOML.name} 的")
        print("[[page_rule]] 角色条 + 页面 [tags] 触发词。")


if __name__ == "__main__":
    main()
