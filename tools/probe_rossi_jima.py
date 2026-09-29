"""
洛茜 (Rossi) —— 画风 LoRA 探针：双重 JiMA 混合权重标定

背景
----
用户要求把「《学园偶像大师》那套 JIMA 画风」搬到洛茜项目，并且做成 **双重 JiMA 混合**
（库里有两支不同作者的 Jima 风格 LoRA）。本脚本在**固定页面原文 + 固定 seed** 的
前提下只改画师 LoRA 栈，用来定权重。

只用两支 Jima LoRA（互相独立、非同一作者的两次训练）：
  · anima\\artist\\260924\\JIMA12.safetensors            触发词 jimafg   （偶像大师在用的那支）
  · anima\\artist\\260613\\Jima.safetensors              触发词 jima

变体
----
  J12   ：JIMA12 1.2                          （偶像大师基线，单支）
  D96   ：JIMA12 0.9 + Jima 0.6               （双支，主 JIMA12）
  D69   ：JIMA12 0.6 + Jima 0.9               （双支，主 Jima）

跑法
----
    tools/run_batch.sh probe_rossi_jima.py            # 全部变体
    tools/run_batch.sh probe_rossi_jima.py J12 D96    # 只跑指定变体

输出：ComfyUI output/明日方舟终末地_洛茜_JIMA探针/<页名>_<变体>_00001.png
"""

import importlib.util
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("rtb", HERE / "run_typhon_batch.py")
rtb = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(rtb)

# ─── 配置 ─────────────────────────────────────────────────────
PRESET_ID  = "anima-single-17"          # 2026-09-28 起线的默认预设（单层 17 步）
PAGES_DIR  = Path("/Users/glow/Base/Works/ComfyUI/Workflows/wild/storyboard/"
                  "明日方舟终末地_洛茜/pages")
OUT_SUBDIR = "明日方舟终末地_洛茜_JIMA探针"
SEED       = 88888888                   # 与 run_rossi_artists.py 同一颗种子，可与旧画师对比

TEST_PAGES = [
    "RS021—a01洛茜-战甲解封.txt",        # 单帧 full body（拓荒整备装）
    "RS042—a01洛茜-丝套褪系.txt",        # 单帧 cowboy（夜巡礼装）
]

AESTH = ("On", "Aesthetic Boost",
         r"anima\beauty\anima-highres-aesthetic-boost.safetensors", 0.48, 1.0)
ROSSI = ("On", "Rossi v2 Anima",
         r"anima\chara\endfield\rossi_v2_anima.safetensors", 1.0, 1.0)

JIMA12 = ("On", "JIMA12", r"anima\artist\260924\JIMA12.safetensors", 1.2, 1.0)
JIMA12_9 = ("On", "JIMA12", r"anima\artist\260924\JIMA12.safetensors", 0.9, 1.0)
JIMA12_6 = ("On", "JIMA12", r"anima\artist\260924\JIMA12.safetensors", 0.6, 1.0)
JIMA_6 = ("On", "Jima (260613)", r"anima\artist\260613\Jima.safetensors", 0.6, 1.0)
JIMA_9 = ("On", "Jima (260613)", r"anima\artist\260613\Jima.safetensors", 0.9, 1.0)

JIMA_5 = ("On", "Jima (260613)", r"anima\artist\260613\Jima.safetensors", 0.5, 1.0)

# (变体键, 画师 LoRA 列表, 触发词)
VARIANTS = [
    ("J12", [JIMA12],           "jimafg"),
    ("D96", [JIMA12_9, JIMA_6], "jimafg, jima"),
    ("D69", [JIMA12_6, JIMA_9], "jimafg, jima"),
    ("D95", [JIMA12_9, JIMA_5], "jimafg, jima"),
]

_want = [a for a in sys.argv[1:] if a in {v[0] for v in VARIANTS}]
if _want:
    VARIANTS = [v for v in VARIANTS if v[0] in _want]


def main() -> None:
    preset = rtb.apply_preset(PRESET_ID)
    rtb.SEED = SEED
    rtb.SEED_FIXED = True

    print(f"🧪 {len(TEST_PAGES)} 页 × {len(VARIANTS)} 画师栈 = "
          f"{len(TEST_PAGES) * len(VARIANTS)} 张，seed={SEED} 固定")
    print("=" * 62)

    results = []
    for page_name in TEST_PAGES:
        page = PAGES_DIR / page_name
        if not page.is_file():
            print(f"❌ 找不到页面：{page}")
            continue
        for tag, artists, trigger in VARIANTS:
            rtb.LORAS = [AESTH, *artists, ROSSI]
            rtb.QUALITY_PREFIX = (
                f"masterpiece, best quality, aesthetic, highly detailed, "
                f"{trigger}, uncensored"
            )
            stem = page.stem
            prefix = f"{OUT_SUBDIR}/{stem}_{tag}"
            stack = " + ".join(f"{a[1]}@{a[3]}" for a in artists)
            print(f"\n[{tag}] {stem}   ← {stack}  (trigger: {trigger})")
            try:
                wf = rtb.build_workflow(rtb.parse_txt(page), prefix)
                pid = rtb.queue_prompt(wf)
                print(f"      → prompt_id={pid[:8]}…")
                # 兼容后端正被别的批次占用：排队等久一点
                imgs = rtb.wait_done(pid, timeout=5400)
                if imgs:
                    print(f"      ✅ {imgs[0]['filename']}")
                    results.append({"v": tag, "page": stem, "ok": True,
                                    "file": imgs[0]["filename"]})
                else:
                    print("      ❌ 超时/失败")
                    results.append({"v": tag, "page": stem, "ok": False, "file": None})
            except Exception as e:  # noqa: BLE001
                print(f"      ❌ 异常：{e}")
                results.append({"v": tag, "page": stem, "ok": False, "file": str(e)})

    ok = sum(1 for r in results if r["ok"])
    print(f"\n{'=' * 62}\n✅ 成功 {ok} / {len(results)}")
    for r in results:
        if not r["ok"]:
            print(f"   FAIL {r['v']} {r['page']} → {r['file']}")
    if ok:
        print(f"\n输出目录：D:\\1Repo\\Github\\ComfyUI\\Library\\output\\{OUT_SUBDIR}\\")
        print("同页同 seed 横比：J12 = 偶像大师单支基线；D96 / D69 = 双重 JiMA 混合。")


if __name__ == "__main__":
    main()
