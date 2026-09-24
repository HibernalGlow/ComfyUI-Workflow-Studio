"""
Rossi (洛茜) 角色认知测试
目的：判断底模是否默认认识 `rossi \\(arknights)`，还是必须挂角色 LoRA。

方法：同一页面、同一 seed，只改 LoRA 组合，其余全部复用 run_typhon_batch.py 的管线：
  V1-nochar  : 画师(villainchin) + 美学提升          <- 测"默认认识吗"
  V2-endfield: 上面 + anima-base-1-arknights-endfield-v31  <- 测"加 lora 有用吗"

采样参数从运行中的 Studio 实时预设读取（默认 anima-native-30：30步/CFG4.0/er_sde/beta57/无Turbo）。
输出到独立目录，不污染正式出图。
"""

import importlib.util
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent

# 复用已验证的管线（build_workflow / parse_txt / queue_prompt / wait_done）
_spec = importlib.util.spec_from_file_location("rtb", HERE / "run_typhon_batch.py")
rtb = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(rtb)

# ─── 配置 ─────────────────────────────────────────────────────
PRESET_ID  = "anima-native-30"
PAGES_DIR  = Path("/Users/glow/Base/Works/ComfyUI/Workflows/wild/storyboard/明日方舟终末地_洛茜/pages")
OUT_SUBDIR = "明日方舟终末地_洛茜_测试"
SEED       = 88888888

# 测试页：RS042 = cowboy shot（脸看得清），RS021 = full body（整体比例）
TEST_PAGES = [
    "RS042—a01洛茜-丝套褪系.txt",
    "RS021—a01洛茜-战甲解封.txt",
]

ARTIST = ("On", "Villainchin", r"anima\artist\260924\@style_villainchin-v2.0-000012.safetensors", 1.0, 1.0)
AESTH  = ("On", "Aesthetic Boost", r"anima\beauty\anima-highres-aesthetic-boost.safetensors", 0.48, 1.0)
ENDFLD = ("On", "Endfield Base v31", r"anima\chara\endfield\anima-base-1-arknights-endfield-v31.safetensors", 1.0, 1.0)
ROSSI  = ("On", "Rossi v2 Anima", r"anima\chara\endfield\rossi_v2_anima.safetensors", 1.0, 1.0)
# LyCORIS LoKr dim32；Civitai trainedWords = @metatar0u（是数字 0，不是字母 o）
META   = ("On", "Metatarou", r"anima\artist\260924\anima_metatarou.safetensors", 1.0, 1.0)

VILLAIN_TRIG = "@style_villainchin"
METATAR_TRIG = "@metatar0u"      # Civitai trainedWords：[ "@metatar0u" ]
HAIR_FIX     = "blonde hair, low twintails, "   # LoRA 作者建议：发色/发型跑偏时补


def _q(trigger: str, hair: bool = False) -> str:
    core = f"masterpiece, best quality, aesthetic, highly detailed, {trigger}, uncensored"
    return (HAIR_FIX + core) if hair else core


# 顺序沿用已验证的 typhon 管线：品质 → 画师 → 角色
# V3 已跑过，作为两条对比轴的共同基准：
#   画师轴 = V3(villainchin) vs V4(metatarou)，都不加发型修正
#   发型轴 = V3(不加)        vs V5(加)，      都用 villainchin
VARIANTS = [
    ("V1-nochar",         [AESTH, ARTIST],           _q(VILLAIN_TRIG)),
    ("V2-endfield",       [AESTH, ARTIST, ENDFLD],   _q(VILLAIN_TRIG)),
    ("V3-rossi",          [AESTH, ARTIST, ROSSI],    _q(VILLAIN_TRIG)),
    ("V4-metatarou",      [AESTH, META,   ROSSI],    _q(METATAR_TRIG)),
    ("V5-villain-hair",   [AESTH, ARTIST, ROSSI],    _q(VILLAIN_TRIG, hair=True)),
    ("V6-metatarou-hair", [AESTH, META,   ROSSI],    _q(METATAR_TRIG, hair=True)),
]

# 可选：只跑指定变体，例如 `python run_rossi_test.py V4-metatarou V5-villain-hair`
_want = [a for a in sys.argv[1:] if a.startswith("V")]
if _want:
    VARIANTS = [v for v in VARIANTS if v[0] in _want]


def main() -> None:
    # 采样参数走 Studio 实时预设（单一事实来源）
    preset = rtb.load_preset(PRESET_ID)
    s = preset.get("sampler_settings") or {}
    rtb.STEPS       = int(s.get("steps", 30))
    rtb.CFG         = float(s.get("cfg", 4.0))
    rtb.SAMPLER     = s.get("sampler_name", "er_sde")
    rtb.SCHEDULER   = s.get("scheduler", "beta57")
    rtb.TURBO_ENABLED = rtb.preset_turbo_enabled(preset)
    rtb.SEED = SEED

    print(f"📌 预设 {preset.get('id')}｜{rtb.STEPS}步 CFG{rtb.CFG} {rtb.SAMPLER}/{rtb.SCHEDULER} Turbo={rtb.TURBO_ENABLED}")
    print(f"🎨 画师触发词：villainchin={VILLAIN_TRIG}  metatarou={METATAR_TRIG}")
    print(f"🧪 {len(TEST_PAGES)} 页 × {len(VARIANTS)} 变体 = {len(TEST_PAGES)*len(VARIANTS)} 张，seed={SEED} 固定")
    print("=" * 60)

    results = []
    for page_name in TEST_PAGES:
        page = PAGES_DIR / page_name
        if not page.is_file():
            print(f"❌ 找不到页面：{page}")
            continue
        for tag, loras, qprefix in VARIANTS:
            rtb.LORAS = loras
            rtb.QUALITY_PREFIX = qprefix
            stem   = page.stem
            prefix = f"{OUT_SUBDIR}/{stem}_{tag}"
            print(f"\n[{tag}] {stem}")
            print(f"      前缀：{qprefix}")
            try:
                wf = rtb.build_workflow(rtb.parse_txt(page), prefix)
                pid = rtb.queue_prompt(wf)
                print(f"      → prompt_id={pid[:8]}… {[l[1] for l in loras]}")
                imgs = rtb.wait_done(pid)
                if imgs:
                    print(f"      ✅ {imgs[0]['filename']}")
                    results.append({"v": tag, "page": stem, "ok": True, "file": imgs[0]["filename"]})
                else:
                    print("      ❌ 超时/失败")
                    results.append({"v": tag, "page": stem, "ok": False, "file": None})
            except Exception as e:
                print(f"      ❌ 异常：{e}")
                results.append({"v": tag, "page": stem, "ok": False, "file": str(e)})

    ok = sum(1 for r in results if r["ok"])
    print(f"\n{'='*60}\n✅ 成功 {ok} / {len(results)}")
    for r in results:
        if not r["ok"]:
            print(f"   FAIL {r['v']} {r['page']} → {r['file']}")
    if ok:
        print(f"\n输出目录：D:\\1Repo\\Github\\ComfyUI\\Library\\output\\{OUT_SUBDIR}\\")
        print("对比 V1-nochar 与 V2-endfield 判断：底模是否默认认识 rossi、加 LoRA 是否更像。")


if __name__ == "__main__":
    main()
