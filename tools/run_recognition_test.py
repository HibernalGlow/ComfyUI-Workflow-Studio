"""
底模角色识别 A/B 测试 —— 同一批分镜页，轮换**底模**，看哪版认得角色/形态。

与 run_qinliu_artists.py（轮换画师 LoRA）对称：这里只换底模，画师/基线/规则/负面
全部沿用作品 batch.toml，保证与正式跑批同一管线。

用法：
    tools/run_batch.sh run_recognition_test.py <作品 batch.toml> \
        --models kazuri,29b --pages LF001,LF021,LF041 [--tag _识别测试]

    --models  逗号分隔的短名（见 BASE_MODELS），或直接写已注册的 unet 全名
    --pages   页前缀码，逗号分隔
    --tag     输出子目录后缀，默认 _识别测试
"""

import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from story_config import load_story          # noqa: E402

# 短名 → ComfyUI 已注册的 unet_name
BASE_MODELS = {
    "v23":    "silvermoonmixAnima_v23_INT8.safetensors",
    "v23std": "silvermoonmixAnima_v23.safetensors",          # 标准版（非 INT8）
    "v20":    "silvermoonmixAnima_v20_INT8.safetensors",
    "29b":    "silvermoonmixAnima29B_v23_INT8.safetensors",
    "base10": "anima-base-v1.0.safetensors",
    "kazuri": r"kirazuriAnima_v40\anima-kirazuri-v4-int8-convrot.safetensors",
}


def parse_args(argv):
    o = {"toml": None, "models": ["kazuri"], "pages": None, "tag": "_识别测试"}
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--models" and i + 1 < len(argv):
            o["models"] = [x.strip() for x in argv[i + 1].split(",") if x.strip()]; i += 2; continue
        if a == "--pages" and i + 1 < len(argv):
            o["pages"] = [x.strip().upper() for x in argv[i + 1].split(",") if x.strip()]; i += 2; continue
        if a == "--tag" and i + 1 < len(argv):
            o["tag"] = argv[i + 1]; i += 2; continue
        if not a.startswith("--"):
            o["toml"] = Path(a)
        i += 1
    return o


def main() -> int:
    o = parse_args(sys.argv[1:])
    if not o["toml"] or not o["pages"]:
        print(__doc__)
        return 2
    rtb, cfg, base_preset = load_story(o["toml"])

    # 解析底模短名
    models = []
    for m in o["models"]:
        full = BASE_MODELS.get(m.lower(), m)
        models.append((m, full))

    all_pages = sorted(rtb.PAGES_DIR.glob(rtb.PAGE_GLOB))
    want = set(o["pages"])
    pages = [p for p in all_pages if p.stem.split("—")[0].upper() in want]
    missing = want - {p.stem.split("—")[0].upper() for p in pages}
    if missing:
        print(f"⚠️  没匹配到：{', '.join(sorted(missing))}")

    rtb.apply_preset(base_preset)
    # 后缀防重：output_subdir 若已以 tag 结尾就不再叠一层（否则出 深靛_识别测试_识别测试）
    tag = o["tag"]
    out_root = (rtb.OUTPUT_SUBDIR if tag and rtb.OUTPUT_SUBDIR.endswith(tag)
                else f"{rtb.OUTPUT_SUBDIR}{tag}")

    print(f"📄 作品配置：{o['toml']}")
    print(f"🧪 {len(pages)} 页 × {len(models)} 底模 = {len(pages) * len(models)} 张")
    print(f"🧱 共用基线 LoRA：{' / '.join(l[1] for l in rtb.LORAS)}")
    print(f"📁 输出：{out_root}/<底模tag>/")
    print("=" * 70)

    ok = fail = 0
    for mtag, unet in models:
        rtb.UNET_NAME = unet
        print(f"\n{'━' * 70}\n🖥️  底模 [{mtag}] {unet}")
        for page in pages:
            positive = rtb.parse_txt(page)
            # 与引擎一致：命中带 preset 的页规则就换预设，否则回基线
            preset, psrc, _rules = rtb.resolve_preset(positive, base_preset, base_preset)
            rtb.apply_preset(preset, quiet=True)
            if psrc == "rule":
                print(f"      ⚙️  命中规则 → {preset}")

            prefix = f"{out_root}/{mtag}/{page.stem}"
            print(f"  [{mtag}] {page.stem}  ({preset})")
            try:
                wf = rtb.build_workflow(positive, prefix)
                pid = rtb.queue_prompt(wf, front=False)   # 不插队，避免抢别人队列
                imgs = rtb.wait_done(pid, timeout=rtb.WAIT_TIMEOUT)
                if imgs:
                    print(f"      ✅ {imgs[0]['filename']}")
                    if rtb.MAC_OUT_DIR:
                        for p in rtb.fetch_images(imgs, rtb.MAC_OUT_DIR):
                            print(f"      ⬇️  {p}")
                    ok += 1
                else:
                    print(f"      ❌ 超时/失败")
                    fail += 1
            except Exception as e:
                print(f"      ❌ 异常：{e}")
                fail += 1

    print(f"\n{'=' * 70}\n✅ 成功 {ok}，失败 {fail}")
    if ok:
        print(f"\n同页同 seed，横向比底模（识别率）。输出：{out_root}/")
    return 0 if fail == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
