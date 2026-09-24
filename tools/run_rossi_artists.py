"""
Rossi (洛茜) 画师画风对比
在固定「角色 LoRA + 美学提升 + 发型已定稿」的前提下，轮换画师 LoRA。

发型定稿方式 = replace：
  页面标签里的 `wavy hair` / `sidelocks` / `low-tied sidelocks` 一律删除，
  改为 `low twintails`（LoRA 作者给的修正标签），避免两套发型标签打架。

采样参数来自运行中的 Studio 实时预设（默认 anima-native-30）。
其余与 run_typhon_batch.py 完全同一管线，保证与既有 V1~V6 可比。
"""

import importlib.util
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("rtb", HERE / "run_typhon_batch.py")
rtb = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(rtb)

# ─── 配置 ─────────────────────────────────────────────────────
PRESET_ID  = "anima-native-30"
PAGES_DIR  = Path("/Users/glow/Base/Works/ComfyUI/Workflows/wild/storyboard/明日方舟终末地_洛茜/pages")
OUT_SUBDIR = "明日方舟终末地_洛茜_测试"
SEED       = 88888888
HAIR_MODE  = "none"             # 定稿：190 页已于 01:10-01:11 全部改写为 low twintails，直接用页面原文

TEST_PAGES = [
    "RS042—a01洛茜-丝套褪系.txt",
    "RS021—a01洛茜-战甲解封.txt",
]

AESTH = ("On", "Aesthetic Boost", r"anima\beauty\anima-highres-aesthetic-boost.safetensors", 0.48, 1.0)
ROSSI = ("On", "Rossi v2 Anima", r"anima\chara\endfield\rossi_v2_anima.safetensors", 1.0, 1.0)

# (标签, LoRA元组, 触发词)
ARTISTS = [
    ("A0-villainchin", ("On", "Villainchin",  r"anima\artist\260924\@style_villainchin-v2.0-000012.safetensors", 1.0, 1.0), "@style_villainchin"),
    ("A1-xaea",        ("On", "Xaea-xp",      r"anima\artist\260625\xaea-xp_v1.safetensors",                    1.0, 1.0), "@xaeax6"),
    ("A2-mikozin",     ("On", "Mikozin",      r"anima\artist\260620\mikozin_style.safetensors",                 1.0, 1.0), "mikozin"),
    ("A3-healthyman",  ("On", "Healthyman",   r"anima\artist\260614\healthyman_v1_epoch28@hea1thy.safetensors", 1.0, 1.0), "@hea1thy"),
    # 注意：260703 那份是 0 字节的坏下载（会报 ModelMMAP OS Error 87），必须用 260704
    ("A4-jiaozi",      ("On", "Smilejiaozi",  r"anima\artist\260704\smilejiaozi_v1_epoch24.safetensors",        1.0, 1.0), "@smilej1aozi"),
    ("A5-kincora",     ("On", "Kincora",      r"anima\artist\260614\style-Kincora-Anima-v01.safetensors",       1.0, 1.0), "kincora"),
]

# 可选：只跑指定画师，例如 `python run_rossi_artists.py A1-xaea A5-kincora`
_want = [a for a in sys.argv[1:] if a.startswith("A")]
if _want:
    ARTISTS = [a for a in ARTISTS if a[0] in _want]

HAIR_DROP = ["low-tied sidelocks", "wavy hair", "sidelocks"]
HAIR_ADD  = "low twintails"
TMP_DIR   = Path("/tmp/rossi_hairfix")


def apply_hair_replace(text: str) -> str:
    """删掉原发型标签，换成 low twintails。"""
    for tok in HAIR_DROP[:2]:
        text = re.sub(rf"(?i){re.escape(tok)}\s*,\s*", "", text)
    text = re.sub(r"(?i)(?<!-)sidelocks\s*,\s*", "", text)   # 独立 sidelocks
    if HAIR_ADD and not re.search(r"(?i)twintail", text):     # 幂等：已有就不再插
        text = re.sub(r"(?i)(long hair,\s*)", rf"\1{HAIR_ADD}, ", text, count=1)
    return text


def page_for_parse(page: Path) -> Path:
    """按发型定稿方式产出用于解析的临时页面文件。"""
    if HAIR_MODE == "none":
        return page
    raw = page.read_text(encoding="utf-8", errors="ignore")
    if HAIR_MODE == "replace":
        fixed = apply_hair_replace(raw)
    else:  # add
        fixed = re.sub(r"(?i)(\[tags\]\s*)", rf"\1{HAIR_ADD}, ", raw, count=1)
    TMP_DIR.mkdir(parents=True, exist_ok=True)
    out = TMP_DIR / page.name
    out.write_text(fixed, encoding="utf-8")
    return out


def main() -> None:
    preset = rtb.load_preset(PRESET_ID)
    s = preset.get("sampler_settings") or {}
    rtb.STEPS         = int(s.get("steps", 30))
    rtb.CFG           = float(s.get("cfg", 4.0))
    rtb.SAMPLER       = s.get("sampler_name", "er_sde")
    rtb.SCHEDULER     = s.get("scheduler", "beta57")
    rtb.TURBO_ENABLED = rtb.preset_turbo_enabled(preset)
    rtb.SEED          = SEED

    print(f"📌 预设 {preset.get('id')}｜{rtb.STEPS}步 CFG{rtb.CFG} {rtb.SAMPLER}/{rtb.SCHEDULER} Turbo={rtb.TURBO_ENABLED}")
    print(f"💇 发型定稿 = {HAIR_MODE}：删 {HAIR_DROP} → 加 {HAIR_ADD!r}")
    print(f"🧪 {len(TEST_PAGES)} 页 × {len(ARTISTS)} 画师 = {len(TEST_PAGES)*len(ARTISTS)} 张，seed={SEED} 固定")
    print("=" * 60)

    # 先把改写后的发型标签打出来，便于确认
    for pn in TEST_PAGES:
        p = PAGES_DIR / pn
        if not p.is_file():
            continue
        before = re.search(r"(?i)\[tags\]\s*(.*)", p.read_text(encoding="utf-8", errors="ignore")).group(1)
        after  = re.search(r"(?i)\[tags\]\s*(.*)", page_for_parse(p).read_text(encoding="utf-8")).group(1)
        b = [t.strip() for t in before.split(",") if re.search(r"(?i)hair|sidelock", t)]
        a = [t.strip() for t in after.split(",")  if re.search(r"(?i)hair|sidelock", t)]
        print(f"💇 {pn}")
        print(f"   改前发型标签: {b}")
        print(f"   改后发型标签: {a}")
    print("=" * 60)

    results = []
    for page_name in TEST_PAGES:
        page = PAGES_DIR / page_name
        if not page.is_file():
            print(f"❌ 找不到页面：{page}")
            continue
        src = page_for_parse(page)
        for tag, artist_lora, trigger in ARTISTS:
            rtb.LORAS = [AESTH, artist_lora, ROSSI]
            rtb.QUALITY_PREFIX = (
                f"masterpiece, best quality, aesthetic, highly detailed, {trigger}, uncensored"
            )
            stem   = page.stem
            prefix = f"{OUT_SUBDIR}/{stem}_{tag}"
            print(f"\n[{tag}] {stem}")
            try:
                wf  = rtb.build_workflow(rtb.parse_txt(src), prefix)
                pid = rtb.queue_prompt(wf)
                print(f"      → prompt_id={pid[:8]}… trigger={trigger}")
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
        print("同页同 seed，直接横向比画师；A0-villainchin 是换了新发型后的基准。")


if __name__ == "__main__":
    main()
