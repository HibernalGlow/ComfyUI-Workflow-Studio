#!/usr/bin/env python3
"""把「祀 · 角色 LoRA 横向对比」的成品图拼成按页的 6 宫格接触表。

用法：
    python3 tools/sheet_si_models.py [输出根目录]

输入目录结构（run_si_models.py 产出）：
    <root>/<model_tag>/SC00X—..._0000N.png

每页取**序号最大**的那张（同页重跑不会拼到旧图），3×2 排列：
    2547832 / 2795280 / 2794878
    2988374 / 3003142 / 2834394
输出：<root>/_sheets/SC00X_sheet.jpg
"""

import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(sys.argv[1] if len(sys.argv) > 1 else
            "/Users/glow/Base/Works/ComfyUI/Outputs/明日方舟终末地_祀_模型对比")

MODELS = [
    ("2547832_v2", "2547832 v2"),
    ("2795280_v1", "2795280 v1"),
    ("2794878_v1_te", "2794878 TE"),
    ("2988374_ingame", "2988374 ingame"),
    ("3003142_community", "3003142 community"),
    ("2834394_v2", "2834394 v2"),
]
PAGES = {
    "SC001": "front full body",
    "SC002": "three-quarter",
    "SC003": "back full body",
    "SC004": "upper body",
    "SC005": "stirrup sock detail",
}
FONT = "/System/Library/Fonts/Supplemental/Arial.ttf"


def latest(model_dir: Path, code: str):
    files = list(model_dir.glob(f"{code}*.png"))
    if not files:
        return None

    def seq(p):
        m = re.search(r"_(\d+)\.png$", p.name)
        return int(m.group(1)) if m else -1

    return max(files, key=seq)


def main() -> int:
    out_dir = ROOT / "_sheets"
    out_dir.mkdir(parents=True, exist_ok=True)
    made = 0
    for code, title in PAGES.items():
        args = ["magick", "montage",
                "-background", "#141414",
                "-fill", "#f2f2f2",
                "-font", FONT,
                "-pointsize", "24",
                "-title", f"{code} — {title}  ·  6 LoRA A/B",
                "-tile", "3x2",
                "-geometry", "560x819+10+14",
                "-gravity", "south"]
        missing = []
        for folder, label in MODELS:
            img = latest(ROOT / folder, code)
            if img is None:
                missing.append(label)
                continue
            args += ["-label", label, str(img)]
        if missing:
            print(f"⚠️  {code} 缺图：{', '.join(missing)}")
        if len(args) <= 24:
            continue
        out = out_dir / f"{code}_sheet.jpg"
        subprocess.run(args + [str(out)], check=True)
        print(f"✅ {out}")
        made += 1

    # 汇总成一张：5 页 × 6 模型 = 30 格，行=机位，列=LoRA。
    args = ["magick", "montage",
            "-background", "#141414",
            "-fill", "#f2f2f2",
            "-font", FONT,
            "-pointsize", "18",
            "-tile", "6x5",
            "-geometry", "380x556+6+10",
            "-gravity", "south"]
    for code in PAGES:
        for folder, label in MODELS:
            img = latest(ROOT / folder, code)
            if img is None:
                continue
            args += ["-label", f"{code} · {label}", str(img)]
    tmp = out_dir / "_ALL_body.jpg"
    out = out_dir / "ALL_sheet.jpg"
    subprocess.run(args + [str(tmp)], check=True)
    # montage -title 会被顶边裁掉半行字，改成先拼图、再补一条标题栏。
    subprocess.run([
        "magick", str(tmp),
        "-background", "#141414", "-gravity", "north", "-splice", "0x64",
        "-font", FONT, "-pointsize", "28", "-fill", "#f2f2f2",
        "-annotate", "+0+18",
        "Si · 6 LoRA A/B — same seed, same kanzarin style, colors left to each LoRA",
        str(out),
    ], check=True)
    tmp.unlink(missing_ok=True)
    print(f"✅ {out}")
    made += 1
    return 0 if made else 1


if __name__ == "__main__":
    raise SystemExit(main())
