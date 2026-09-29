"""
妃咲 (Kisaki) 画风 A/B —— Kedama 系（礼服 + 两套泳装）

管线与正式跑批**完全同一套**：直接读作品 batch.toml（预设 / 前缀 / 角色 LoRA /
逐页规则 / 回传），只轮换「画师 LoRA + 画师触发词（+ 可选预设）」。
seed 固定 88888888，同一页不同候选之间可直接横比。

用法：
    tools/run_batch.sh run_kisaki_artists.py                 # 跑全部候选
    tools/run_batch.sh run_kisaki_artists.py K1-kd4m K2-kd4m-30
    tools/run_batch.sh run_kisaki_artists.py K1-kd4m K3-mi1k XM001   # 只跑 1 页，快速筛

═══════════════════════════════════════════════════════════════════════════
为什么会有 K2/K4 这种「同一 LoRA 两套采样」的候选
═══════════════════════════════════════════════════════════════════════════
C 站上 @mi1k（ID 2624534）作者明确写了出图要求：
    CFG 4~5 ／ Sampler er_sde ／ Steps **30~40** ／ 1.25x Highres
而本作 50 页里 **34 页走 anima-two-stage-standard（5+12 双层采样）**，步数不够，
@mi1k 画风会被压掉。所以必须单独验证「采样步数对画风的影响」，否则会把
「画风不对」误判成「这个 LoRA 不行」。

@kd4m（ID 2648265）作者没提出图要求，但也一并测 30 步，作为对照。
═══════════════════════════════════════════════════════════════════════════
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from story_config import load_story          # noqa: E402

TOML = Path("/Users/glow/Base/Works/ComfyUI/Workflows/wild/storyboard/"
            "蔚蓝档案_妃咲/batch.toml")

OUT_SUBDIR = "蔚蓝档案_妃咲_画风AB_kd"
SEED       = 88888888            # 固定种子，候选之间才可比

# 测试页（用户指定：主要测礼服 + 两套泳装）
TEST_PAGES = [
    "XM001—a05妃咲-解颈链褪裙.txt",   # 礼服全身：挂脖/露背/分离袖套 + 体态
    "SW001—a02妃咲-海湾褪袍.txt",     # 泳装全身：看泳装角色 LoRA(1.0) 与画风是否打架
    "KP001—a04妃咲-池畔承足.txt",     # 幼泳全身：看 Kiki 角色 LoRA(1.0) 与画风是否打架
]

KEDAMA_DIR = r"anima\artist\260613\kedama"
KD4M = KEDAMA_DIR + r"\kedama_kd4m_artist32_adamw_lr2e5_te0_unetonly_@kd4m.safetensors"
MI1K = KEDAMA_DIR + r"\anima_mi1k_v1.3-epoch16.safetensors"
MAOYU = KEDAMA_DIR + r"\anima_maoyuniuru.safetensors"
X4X0 = KEDAMA_DIR + r"\kedama-milk_V2.0_epoch45@4x0style.safetensors"

# (标签, LoRA元组, 触发词, 预设覆盖 or None)
#   权重一律 1.0 —— 作者未标推荐值，按本库标准「默认强度一」
ARTISTS = [
    # ── C 站 Kedama 系 Anima 端口碑第一（赞/下载 12.2%）────────────────
    ("K1-kd4m", ("On", "Kedama kd4m",
                 KD4M, 1.0, 1.0),
     "@kd4m, @kedama milk", None),
    ("K2-kd4m-30", ("On", "Kedama kd4m",
                    KD4M, 1.0, 1.0),
     "@kd4m, @kedama milk", "anima-native-30"),

    # ── C 站 v1.3（赞/下载 4.0%），作者要求 30~40 步 ────────────────────
    ("K3-mi1k", ("On", "Kedama mi1k v1.3",
                 MI1K, 1.0, 1.0),
     "@mi1k, @kedama milk", None),
    ("K4-mi1k-30", ("On", "Kedama mi1k v1.3",
                    MI1K, 1.0, 1.0),
     "@mi1k, @kedama milk", "anima-native-30"),

    # ── 只写 @mi1k、不加画师 tag，看 @kedama milk 到底值不值得加 ────────
    ("K5-mi1k-notag", ("On", "Kedama mi1k v1.3",
                       MI1K, 1.0, 1.0),
     "@mi1k", "anima-native-30"),

    # ── 本地这两件 C 站搜不到，一起过一遍 ──────────────────────────────
    ("K6-maoyuniuru", ("On", "maoyuniuru",
                       MAOYU, 1.0, 1.0),
     "@maoyuniuru", None),
    ("K7-4x0style", ("On", "kedama-milk V2.0 @4x0style",
                     X4X0, 1.0, 1.0),
     "@4x0style", None),
]

_want = [a for a in sys.argv[1:] if a.startswith("K")]
_pages = [a for a in sys.argv[1:] if a.startswith(("XM", "SW", "KP", "KS", "KG"))]
if _want:
    ARTISTS = [a for a in ARTISTS if a[0] in _want]
if _pages:
    TEST_PAGES = [p for p in TEST_PAGES if p.split("—")[0] in _pages]
    if not TEST_PAGES:
        print("❌ --page 选中的页不在 TEST_PAGES 里"); sys.exit(2)


def main() -> None:
    rtb, cfg, base_preset = load_story(TOML)

    non_artist = [l for l in rtb.LORAS if r"artist" not in l[2].lower()]
    if len(non_artist) == len(rtb.LORAS):
        print("ℹ️  基线里没有画师 LoRA（画风槽当前空置）—— 画师追加在栈尾")

    prefix_tmpl = cfg["prompt"]["quality_prefix"]
    if "{trig}" not in prefix_tmpl:
        prefix_tmpl = (prefix_tmpl.replace("cinematic lighting,", "cinematic lighting, {trig},", 1)
                       if "cinematic lighting," in prefix_tmpl else prefix_tmpl + ", {trig}")

    rtb.SEED = SEED
    rtb.MAC_OUT_DIR = Path("/Users/glow/Base/Works/ComfyUI/Outputs")

    print(f"📄 基线来自：{TOML}")
    print(f"🧱 共用底座：{' / '.join(l[1] for l in non_artist)}")
    print(f"🧪 {len(TEST_PAGES)} 页 × {len(ARTISTS)} 候选 = "
          f"{len(TEST_PAGES) * len(ARTISTS)} 张，seed={SEED} 固定")
    print(f"📁 输出：{OUT_SUBDIR}/（并回传 {rtb.MAC_OUT_DIR}/{OUT_SUBDIR}）")
    print("=" * 76)

    results = []
    for page_name in TEST_PAGES:
        page = rtb.PAGES_DIR / page_name
        if not page.is_file():
            print(f"❌ 找不到页面：{page}")
            continue
        for tag, artist_lora, trigger, preset_override in ARTISTS:
            rtb.apply_preset(preset_override or base_preset)
            rtb.LORAS = non_artist + [artist_lora]
            rtb.QUALITY_PREFIX = (prefix_tmpl.format(trig=trigger) if trigger
                                  else prefix_tmpl.replace(", {trig}", "").format(trig=""))

            stem = page.stem
            prefix = f"{OUT_SUBDIR}/{stem}_{tag}"
            print(f"\n[{tag}] {stem}")
            print(f"      LoRA：{' / '.join(l[1] for l in rtb.LORAS)}")
            print(f"      触发词：{trigger or '(无)'}")
            print(f"      预设：{preset_override or base_preset} → {rtb.STEPS}步 CFG{rtb.CFG} "
                  f"{rtb.SAMPLER}/{rtb.SCHEDULER} Turbo={rtb.TURBO_ENABLED}")
            try:
                wf = rtb.build_workflow(rtb.parse_txt(page), prefix)
                pid = rtb.queue_prompt(wf)
                print(f"      → prompt_id={pid[:8]}…")
                imgs = rtb.wait_done(pid)
                if imgs:
                    print(f"      ✅ {imgs[0]['filename']}")
                    got = rtb.fetch_images(imgs, rtb.MAC_OUT_DIR)
                    for p in got:
                        print(f"      ⬇️  {p}")
                    results.append({"v": tag, "page": stem, "ok": True, "file": imgs[0]["filename"]})
                else:
                    print("      ❌ 超时/失败")
                    results.append({"v": tag, "page": stem, "ok": False, "file": None})
            except Exception as e:
                print(f"      ❌ 异常：{e}")
                results.append({"v": tag, "page": stem, "ok": False, "file": str(e)})

    ok = sum(1 for r in results if r["ok"])
    print(f"\n{'=' * 76}\n✅ 成功 {ok} / {len(results)}")
    for r in results:
        if not r["ok"]:
            print(f"   FAIL {r['v']} {r['page']} → {r['file']}")
    if ok:
        print("\n同页同 seed，横向比。重点看 K1 vs K2 / K3 vs K4："
              "\n若某件在 30 步下明显更好，说明它需要把对应页面也切到 anima-native-30。"
              "\n定稿后把中选画师写回 batch.toml 的 [base.loras]，并同步 quality_prefix 触发词。")


if __name__ == "__main__":
    main()
