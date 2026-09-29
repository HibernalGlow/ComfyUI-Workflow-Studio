#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
**排队预投** —— 把整批页面一次性全部推进 ComfyUI 队列，而不是一页一页等。

跟 `run_typhon_batch.py` 的关系
------------------------------
不是绕开引擎：本脚本 **import 同一个引擎模块**，逐页走的还是引擎那几支函数
（`parse_txt` → `resolve_preset` → `apply_preset` → 采样闸 `check_foot_preset`
→ `resolve_page_canvas` → `build_workflow` → `queue_prompt`）。唯一去掉的是
`wait_done()` —— 投完就走，不站着等图。

为什么要这么做
--------------
`run_typhon_batch.py` 是「投一页 → 等一页 → 回传一页」。好处是失败隔离、逐页回传；
代价是：

1. **GPU 空转**：每页渲染完到下一页投递之间有几个秒的往返，几十页就是几分钟；
2. **派发机一睡/一重启，队列就空了** —— 只有一页在 ComfyUI 里，剩下的根本没进去。

预投之后队列全在 **Windows 那台算力机**上：派发机重启也不影响渲染继续，
之后 `collect_presubmitted.py` 或 `mirror_output.py` 再来收图即可。

用法
----
    tools/run_batch.sh presubmit_batch.py <作品目录>              # 只投未落地的页
    tools/run_batch.sh presubmit_batch.py <作品目录> --all        # 全部重投
    tools/run_batch.sh presubmit_batch.py <作品目录> --front      # 插到队首
    tools/run_batch.sh presubmit_batch.py <作品目录> --dry        # 只打印不投递

清单落在 `<作品目录>/presubmit_manifest.json`（供收集器使用）。
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
STUDIO = HERE.parent
STORYBOARD = STUDIO.parent / "Workflows/wild/storyboard"

sys.path.insert(0, str(HERE))
from story_config import load_story          # noqa: E402


def resolve_story_dir(arg: str) -> Path:
    p = Path(arg).expanduser()
    for c in (p, STORYBOARD / arg):
        if (c / "batch.toml").is_file():
            return c.resolve()
    raise SystemExit(f"❌ 找不到作品目录（需含 batch.toml）：{arg}")


def landed_stems(mac_root: Path | None, subdir: str) -> set:
    if not mac_root:
        return set()
    d = Path(mac_root) / subdir
    if not d.is_dir():
        return set()
    return {p.name.rsplit("_", 1)[0] for p in d.glob("*.png")}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("story", help="作品目录名（或路径），需含 batch.toml")
    ap.add_argument("--all", action="store_true", help="不跳过已落地的页，全部重投")
    ap.add_argument("--front", action="store_true", help="插到 ComfyUI 队列队首")
    ap.add_argument("--dry", action="store_true", help="只打印，不真投")
    ap.add_argument("--tag", default="", help="输出目录后缀（同 run_typhon_batch.py）")
    args = ap.parse_args()

    story = resolve_story_dir(args.story)
    rtb, cfg, base_preset = load_story(story / "batch.toml")
    name = cfg.get("story", {}).get("name", story.name)
    subdir = f"{rtb.OUTPUT_SUBDIR}{args.tag}"

    pages = sorted(rtb.PAGES_DIR.glob(rtb.PAGE_GLOB))
    have = set() if args.all else landed_stems(rtb.MAC_OUT_DIR, subdir)
    todo = [p for p in pages if p.stem not in have]

    print(f"🧾 {name}｜应有 {len(pages)} 页｜Mac 已落地 {len(have)} 页"
          f"｜本次预投 {len(todo)} 页")
    print(f"   预设基线：{base_preset}｜输出目录：{subdir}/")
    if rtb.MAC_OUT_DIR:
        print(f"   回传根目录：{rtb.MAC_OUT_DIR}")
    print("=" * 62)
    if args.dry:
        for p in todo[:20]:
            print("   ·", p.stem)
        print(f"   … 共 {len(todo)} 页（--dry 不投递）")
        return 0

    entries, skipped, failed = [], [], []
    last_preset = base_preset
    t0 = time.time()

    for i, page in enumerate(todo, 1):
        stem = page.stem
        prefix = f"{subdir}/{stem}"
        try:
            rtb.SEED = rtb.next_seed(stem)
            positive = rtb.parse_txt(page)

            preset_id, psrc, rules = rtb.resolve_preset(positive, base_preset, last_preset)
            if preset_id:
                last_preset = preset_id
                rtb.apply_preset(preset_id, quiet=True)

            # 采样验证闸：踩脚页禁止双彩（与主批次同一道门）
            hits = rtb.check_foot_preset(positive, preset_id)
            if hits and rtb.FOOT_GATE_MODE == "block":
                print(f"[{i:03d}/{len(todo)}] ⛔ {stem} 被采样闸拦下（{preset_id}）")
                skipped.append({"page": stem, "reason": ", ".join(hits[:6])})
                continue

            w, h = rtb.WIDTH, rtb.HEIGHT
            ep = rtb.INCONTEXT.get("end_percent", 0.90) if rtb.INCONTEXT else None
            canvas = rtb.resolve_page_canvas(stem)
            if canvas:
                w = canvas.get("width") or w
                h = canvas.get("height") or h
                if canvas.get("end_percent") is not None:
                    ep = canvas["end_percent"]

            wf = rtb.build_workflow(positive, prefix, width=w, height=h, end_percent=ep)
            pid = rtb.queue_prompt(wf, front=args.front)
            entries.append({"page": stem, "prompt_id": pid, "seed": rtb.SEED,
                            "preset": preset_id, "prefix": prefix})
            flag = "⚙️" if psrc == "rule" else "  "
            print(f"[{i:03d}/{len(todo)}] {flag} {stem}  {preset_id}  seed={rtb.SEED}  "
                  f"→ {pid[:8]}…")
        except Exception as e:                                   # noqa: BLE001
            print(f"[{i:03d}/{len(todo)}] ❌ {stem} 投递异常：{e}")
            failed.append({"page": stem, "error": str(e)})

    manifest = {
        "story": name,
        "story_dir": str(story),
        "output_subdir": subdir,
        "created": time.strftime("%Y-%m-%d %H:%M:%S"),
        "count": len(entries),
        "entries": entries,
        "gate_skipped": skipped,
        "submit_failed": failed,
    }
    out = story / "presubmit_manifest.json"
    out.write_text(json.dumps(manifest, ensure_ascii=False, indent=1), encoding="utf-8")

    print("=" * 62)
    print(f"✅ 预投完成：{len(entries)} 页已进队列（{time.time() - t0:.1f}s）"
          f"｜采样闸拦下 {len(skipped)}｜投递失败 {len(failed)}")
    print(f"📄 清单：{out}")
    print("   接下来：tools/collect_presubmitted.py <作品目录>   （守着收图）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
