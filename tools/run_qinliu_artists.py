"""
琴柳 (Saileach) 画师画风对比

基线直接读作品 batch.toml —— 保证与正式跑批**完全同一管线**（预设 / 前缀 / 角色
触发词 / 回传），只把「画师 LoRA + 画师触发词」这一项轮换掉。

琴柳无角色 LoRA：底模 silvermoonmixAnima_v23 原生认识 saileach \\(arknights\\)，
角色特征靠页面 [tags] 里的角色标签锚定。

用法：
    tools/run_batch.sh run_qinliu_artists.py              # 跑全部画师
    tools/run_batch.sh run_qinliu_artists.py A1-mgk000    # 只跑指定画师
"""

import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from story_config import load_story          # noqa: E402

TOML = Path("/Users/glow/Base/Works/ComfyUI/Workflows/wild/storyboard/"
            "明日方舟_琴柳/batch.toml")

OUT_SUBDIR = "琴柳_画师测试"
SEED       = 88888888            # 固定种子，画师之间才可比

# 测试页：SL001 全身（看体态/服装） + SL012 特写（看脸/发丝）
TEST_PAGES = [
    "SL001—a01琴柳-退朝卸甲.txt",
    "SL012—a01琴柳-花冠落额.txt",
]

# batch.toml 里已写死 SANTA；这里把触发词抠成占位符，避免两处维护。
SANTA_TRIG = r"rtkt\(santa\)_5ty1e"

# (标签, LoRA元组, 触发词) —— 触发词一律来自各 LoRA 的 .trigger.txt / .notrigger.txt，不要猜
# 触发词为 None = 该 LoRA 无触发词（靠权重生效），提示词里不加任何 token
ARTISTS = [
    ("A1-santa",  ("On", "SANTA",   r"anima\artist\260613\rtkt(santa)_5ty1e.safetensors", 1.0, 1.0),
     SANTA_TRIG),                                        # 触发词含括号必须转义，否则被当权重语法
    ("A2-mgk000", ("On", "mgk000",  r"anima\artist\260614\style_mgk000_anima_style_resume4000_to8000-step00004000@style_mgk000.safetensors", 1.0, 1.0),
     "@style_mgk000"),

    # Oyari 两套权重互不相同，别用同一套提示词互相找：
    #   自练（dim64/alpha32, 516 图）触发词 oyari；reweik 版无触发词
    ("A3-oyari2400", ("On", "Oyari 2400 (自练)",
                      r"anima\artist\260614\oyari-step00002400.safetensors", 1.0, 1.0),
     "oyari"),
    ("A4-oyari3000", ("On", "Oyari 3000 (自练)",
                      r"anima\artist\self\oyari\oyari-step00003000.safetensors", 1.0, 1.0),
     "oyari"),
    ("A5-oyari-ashito", ("On", "Oyari Ashito (reweik)",
                         r"anima\artist\260924\style-Oyari_Ashito-Anima-v01.safetensors", 1.0, 1.0),
     None),                                              # 无触发词；训练集含 speech bubble / censored，已由页面 uncensored 压制
]

_want = [a for a in sys.argv[1:] if a.startswith("A")]
if _want:
    ARTISTS = [a for a in ARTISTS if a[0] in _want]


def main() -> None:
    rtb, cfg, base_preset = load_story(TOML)

    # 画师槽 = 基线里路径含 \artist\ 的那条；其余（Turbo / Aesthetic）作为共用底座
    non_artist = [l for l in rtb.LORAS if r"artist" not in l[2].lower()]
    if len(non_artist) == len(rtb.LORAS):
        print("⚠️  基线里没找到画师 LoRA（路径含 \\artist\\），"
              "画师将被**追加**在栈尾")

    prefix_tmpl = cfg["prompt"]["quality_prefix"]
    if SANTA_TRIG in prefix_tmpl:
        prefix_tmpl = prefix_tmpl.replace(SANTA_TRIG, "{trig}")
    else:
        prefix_tmpl = prefix_tmpl + ", {trig}"

    rtb.SEED = SEED
    rtb.apply_preset(base_preset)
    rtb.MAC_OUT_DIR = Path("/Users/glow/Base/Works/ComfyUI/Outputs")

    print(f"📄 基线来自：{TOML}")
    print(f"🧱 共用底座：{' / '.join(l[1] for l in non_artist)}")
    print(f"🧪 {len(TEST_PAGES)} 页 × {len(ARTISTS)} 画师 = "
          f"{len(TEST_PAGES) * len(ARTISTS)} 张，seed={SEED} 固定")
    print(f"📁 输出：{OUT_SUBDIR}/（并回传 {rtb.MAC_OUT_DIR}/{OUT_SUBDIR}）")
    print("=" * 66)

    results = []
    for page_name in TEST_PAGES:
        page = rtb.PAGES_DIR / page_name
        if not page.is_file():
            print(f"❌ 找不到页面：{page}")
            continue
        for tag, artist_lora, trigger in ARTISTS:
            rtb.LORAS = non_artist + [artist_lora]
            # 无触发词的画师：把占位符整段摘掉，别留下悬空的逗号
            rtb.QUALITY_PREFIX = (prefix_tmpl.format(trig=trigger) if trigger
                                  else prefix_tmpl.replace(", {trig}", "").format(trig=""))

            stem   = page.stem
            prefix = f"{OUT_SUBDIR}/{stem}_{tag}"
            print(f"\n[{tag}] {stem}")
            print(f"      LoRA：{' / '.join(l[1] for l in rtb.LORAS)}")
            print(f"      触发词：{trigger or '(无，靠权重生效)'}｜{rtb.STEPS}步 CFG{rtb.CFG} "
                  f"{rtb.SAMPLER}/{rtb.SCHEDULER} Turbo={rtb.TURBO_ENABLED}")
            print(f"      前缀：{rtb.QUALITY_PREFIX}")
            try:
                wf  = rtb.build_workflow(rtb.parse_txt(page), prefix)
                pid = rtb.queue_prompt(wf)
                print(f"      → prompt_id={pid[:8]}…")
                imgs = rtb.wait_done(pid)
                if imgs:
                    print(f"      ✅ {imgs[0]['filename']}")
                    got = rtb.fetch_images(imgs, rtb.MAC_OUT_DIR)
                    for p in got:
                        print(f"      ⬇️  {p}")
                    results.append({"v": tag, "page": stem, "ok": True,
                                    "file": imgs[0]["filename"]})
                else:
                    print("      ❌ 超时/失败")
                    results.append({"v": tag, "page": stem, "ok": False, "file": None})
            except Exception as e:
                print(f"      ❌ 异常：{e}")
                results.append({"v": tag, "page": stem, "ok": False, "file": str(e)})

    ok = sum(1 for r in results if r["ok"])
    print(f"\n{'=' * 66}\n✅ 成功 {ok} / {len(results)}")
    for r in results:
        if not r["ok"]:
            print(f"   FAIL {r['v']} {r['page']} → {r['file']}")
    if ok:
        print("\n同页同 seed，横向比画师。定稿后把中选画师写回 batch.toml 的 [base.loras]，"
              "\n并把 quality_prefix 里的触发词一并换掉。")


if __name__ == "__main__":
    main()
