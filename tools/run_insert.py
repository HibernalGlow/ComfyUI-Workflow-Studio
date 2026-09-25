"""
插队跑批 —— 把别的任务插进**正在跑**的批次中间。

原理
----
ComfyUI 的 `POST /prompt` 支持 `front: true`：服务端会把该任务的序号取负，
heapq 里负号排最前，于是它会在**当前正在执行的节点跑完后立刻执行**，
插在队列里所有已排队的任务前面。这是唯一能对「已在运行的批次进程」生效的插队
方式 —— 不需要重启那个进程（改代码/改配置对已 import 的进程无效，见 handoff §6.3）。

⚠️ 超时预算（必须知道）
--------------------
批次 runner 是「投递一页 → wait_done(该页) → 再投递下一页」。所以插进去的任务
**完全占用**下一页的等待时间：插队任务耗时 T，则批次下一页的墙上等待变成
T + 本页耗时。批次默认单页上限 `WAIT_TIMEOUT=300s`，正常一页约 60s，
即**插队总耗时超过约 240s 就会把批次下一页误判为超时**（连续 3 次会触发中止保护）。

对策：
  · 少量插入（≤3 页）没问题；
  · 大批量插入前，先把作品的 batch.toml 里 `[output] wait_timeout` 调大
    （例如 1800），再重启该批次 —— 对已在跑的进程无效，只对下次生效；
  · 或者本工具加 `--no-front`，老老实实排到队尾（不占别人的超时预算）。

用法
----
    tools/run_batch.sh run_insert.py <作品 batch.toml> --only SL003,SL041
    tools/run_batch.sh run_insert.py <作品 batch.toml> --index 7,9 --tag _probe
    tools/run_batch.sh run_insert.py <作品 batch.toml> --only SL001 --dry-run

    --only  CODE,CODE    按页前缀码选（SL003）
    --index N,N          按 1 基序号选（在 page_glob 排序后的位置）
    --tag   SUFFIX       输出子目录后缀，默认 _jump（避免覆盖正式批次产物）
    --no-front           不插队，排到队尾
    --timeout SECONDS    单页等待上限，默认取作品 TOML 的 wait_timeout（否则 300）
    --dry-run            只打印要跑什么，不投递
"""

import json
import sys
import time
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from story_config import load_story          # noqa: E402

COMFY_HOST = "127.0.0.1:8188"


def queue_status():
    """(运行中数量, 待跑数量)；取不到返回 (None, None)。"""
    try:
        with urllib.request.urlopen(f"http://{COMFY_HOST}/queue", timeout=10) as r:
            d = json.loads(r.read().decode("utf-8"))
        return len(d.get("queue_running") or []), len(d.get("queue_pending") or [])
    except Exception:
        return None, None


def parse_args(argv):
    opts = {"toml": None, "only": None, "index": None, "tag": "_jump",
            "front": True, "timeout": None, "dry": False}
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--only" and i + 1 < len(argv):
            opts["only"] = [x.strip().upper() for x in argv[i + 1].split(",") if x.strip()]
            i += 2; continue
        if a == "--index" and i + 1 < len(argv):
            opts["index"] = [int(x) for x in argv[i + 1].split(",") if x.strip()]
            i += 2; continue
        if a == "--tag" and i + 1 < len(argv):
            opts["tag"] = argv[i + 1]; i += 2; continue
        if a == "--timeout" and i + 1 < len(argv):
            opts["timeout"] = int(argv[i + 1]); i += 2; continue
        if a == "--no-front":
            opts["front"] = False; i += 1; continue
        if a == "--dry-run":
            opts["dry"] = True; i += 1; continue
        if a.startswith("--"):
            print(f"⚠️  忽略未知参数：{a}"); i += 1; continue
        opts["toml"] = Path(a); i += 1
    return opts


def main() -> int:
    opts = parse_args(sys.argv[1:])
    if not opts["toml"]:
        print(__doc__)
        return 2

    rtb, cfg, base_preset = load_story(opts["toml"])
    all_pages = sorted(rtb.PAGES_DIR.glob(rtb.PAGE_GLOB))

    # ── 选页 ───────────────────────────────────────────────────
    if opts["only"]:
        want = set(opts["only"])
        pages = [p for p in all_pages if p.stem.split("—")[0].upper() in want]
        missing = want - {p.stem.split("—")[0].upper() for p in pages}
        if missing:
            print(f"⚠️  没匹配到：{', '.join(sorted(missing))}")
    elif opts["index"]:
        pages = [all_pages[i - 1] for i in opts["index"] if 1 <= i <= len(all_pages)]
    else:
        print("❌ 必须给 --only 或 --index 指定要插队的页")
        return 2

    if not pages:
        print("❌ 没有选中任何页")
        return 2

    timeout = opts["timeout"] or getattr(rtb, "WAIT_TIMEOUT", 300)
    out_subdir = f"{rtb.OUTPUT_SUBDIR}{opts['tag']}"
    run_n, pend_n = queue_status()

    print(f"📄 作品配置：{opts['toml']}")
    print(f"   作品：{cfg.get('story', {}).get('name')}｜共 {len(all_pages)} 页，"
          f"本次插队 {len(pages)} 页")
    print(f"   插入位置：{'队首（插队，占用批次下一页的超时预算）' if opts['front'] else '队尾（不插队）'}")
    print(f"   输出：{out_subdir}/｜单页等待上限：{timeout}s")
    if run_n is not None:
        print(f"   ComfyUI 队列现状：运行中 {run_n}，待跑 {pend_n}")
    if opts["front"] and not opts["dry"]:
        print(f"   ⚠️  插队总耗时若超过约 {timeout - 60}s，会把批次下一页误判为超时"
              f"（连续 3 次会触发中止保护）")
    print("=" * 70)

    if opts["dry"]:
        for p in pages:
            positive = rtb.parse_txt(p)
            rules = rtb.matched_page_rules(positive)
            pre = next((r for r in rules if r.get("preset")), None)
            names = " + ".join(r.get("name", "?") for r in rules) or "—"
            print(f"   {p.stem}   规则：{names}   预设：{pre['preset'] if pre else base_preset}")
        print("\n（--dry-run，未投递）")
        return 0

    ok = fail = 0
    t_start = time.time()
    for i, page in enumerate(pages, 1):
        stem = page.stem
        try:
            positive = rtb.parse_txt(page)
            rules = rtb.matched_page_rules(positive)
            pre = next((r for r in rules if r.get("preset")), None)
            if pre:
                rtb.apply_preset(pre["preset"], quiet=True)
                print(f"\n[{i}/{len(pages)}] {stem}   ⚙️  {pre['preset']}")
            elif base_preset:
                rtb.apply_preset(base_preset, quiet=True)
                print(f"\n[{i}/{len(pages)}] {stem}")
            else:
                print(f"\n[{i}/{len(pages)}] {stem}")

            wf  = rtb.build_workflow(positive, f"{out_subdir}/{stem}")
            pid = rtb.queue_prompt(wf, front=opts["front"])
            print(f"      → 已投递{'（队首）' if opts['front'] else ''} prompt_id={pid[:8]}…")
            imgs = rtb.wait_done(pid, timeout=timeout)
            if imgs:
                print(f"      ✅ {imgs[0]['filename']}")
                if rtb.MAC_OUT_DIR:
                    for p in rtb.fetch_images(imgs, rtb.MAC_OUT_DIR):
                        print(f"      ⬇️  {p}")
                ok += 1
            else:
                print(f"      ❌ 超时/失败（{timeout}s）")
                fail += 1
        except Exception as e:
            print(f"      ❌ 异常：{e}")
            fail += 1

    dur = time.time() - t_start
    print(f"\n{'=' * 70}")
    print(f"✅ 插队完成：成功 {ok}，失败 {fail}，总耗时 {dur:.0f}s")
    if opts["front"] and fail == 0:
        print(f"   注意：本次插队占用批次约 {dur:.0f}s，"
              f"批次下一页的等待预算剩下 {max(0, timeout - dur - 60):.0f}s")
    return 0 if fail == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
