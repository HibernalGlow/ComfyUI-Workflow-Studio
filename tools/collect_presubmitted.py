#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
**队列收集器** —— 配合 `presubmit_batch.py`：把已经排进 ComfyUI 的预投批次守到落地。

工作方式
--------
1. 读 `<作品目录>/presubmit_manifest.json` 的 `prompt_id → 页` 映射；
2. 每 `--poll` 秒扫一遍还没落地的页：`GET /history/<prompt_id>`，
   有图就 `fetch_images()` 回传到 Mac 的镜像目录；
3. 队列空了但还有页没落地 ⇒ 那些 prompt 丢了（ComfyUI 重启/被清理），
   重跑 `presubmit_batch.py` 把它们重新排队（它只投未落地的页，天然幂等）；
4. 最多 `--rounds` 轮，最后写 `<作品目录>/collect_report.txt`。

用法（挂成 detached 屏，派发机重启后重跑即可继续收）：
    screen -dmS rossi_collect bash -lc 'cd <Studio> && exec /opt/homebrew/bin/python3 \\
        tools/collect_presubmitted.py 明日方舟终末地_洛茜 > /tmp/rossi_collect.log 2>&1'
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
import urllib.request
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


def queue_depth(host: str) -> int:
    try:
        d = json.loads(urllib.request.urlopen(
            f"http://{host}/queue", timeout=20).read().decode())
        return len(d.get("queue_running", [])) + len(d.get("queue_pending", []))
    except Exception:                                            # noqa: BLE001
        return -1


def history_images(host: str, pid: str) -> list | None:
    """返回该 prompt 的 images 列表；不在 history 里返回 None。"""
    try:
        d = json.loads(urllib.request.urlopen(
            f"http://{host}/history/{pid}", timeout=30).read().decode())
    except Exception:                                            # noqa: BLE001
        return None
    if pid not in d:
        return None
    imgs = []
    for out in (d[pid].get("outputs") or {}).values():
        imgs.extend(out.get("images") or [])
    return imgs


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("story")
    ap.add_argument("--rounds", type=int, default=4)
    ap.add_argument("--poll", type=int, default=30, help="轮询间隔秒（默认 30）")
    ap.add_argument("--idle-stop", type=int, default=2,
                    help="队列空后连续 N 轮仍无进展就算收敛（默认 2）")
    args = ap.parse_args()

    story = resolve_story_dir(args.story)
    rtb, cfg, _ = load_story(story / "batch.toml")
    name = cfg.get("story", {}).get("name", story.name)
    subdir = rtb.OUTPUT_SUBDIR
    mac_root = Path(rtb.MAC_OUT_DIR) if rtb.MAC_OUT_DIR else None
    host = rtb.COMFY_HOST
    report_path = story / "collect_report.txt"

    logs: list[str] = []

    def log(msg: str) -> None:
        line = f"[{time.strftime('%H:%M:%S')}] {msg}"
        print(line, flush=True)
        logs.append(line)

    def landed() -> set:
        d = (mac_root / subdir) if mac_root else None
        return {p.name.rsplit("_", 1)[0] for p in d.glob("*.png")} if d and d.is_dir() else set()

    log(f"🧾 收集器启动：{name}｜回传目录 {mac_root}/{subdir}")

    for rnd in range(1, args.rounds + 1):
        man_path = story / "presubmit_manifest.json"
        if not man_path.is_file():
            log(f"⚠️ 没有清单 {man_path.name} —— 先跑 presubmit_batch.py")
            break
        man = json.loads(man_path.read_text(encoding="utf-8"))
        entries = man.get("entries", [])
        log(f"—— 第 {rnd} 轮：清单 {len(entries)} 条")

        idle = 0
        while True:
            done = landed()
            todo = [e for e in entries if e["page"] not in done]
            if not todo:
                log("   ✅ 清单内页面全部落地")
                break
            qd = queue_depth(host)
            # 收一批
            got = 0
            for e in list(todo):
                imgs = history_images(host, e["prompt_id"])
                if imgs and mac_root:
                    try:
                        rtb.fetch_images(imgs, mac_root)
                        got += 1
                    except Exception as ex:                      # noqa: BLE001
                        log(f"   ⚠️ 回传失败 {e['page']}：{ex}")
            if got:
                idle = 0
                log(f"   ⬇️  回传 {got} 页｜队列 {qd}｜剩余 {len(todo) - got} 页")
            else:
                idle += 1
                if idle % 10 == 1:
                    log(f"   ⏳ 队列 {qd}｜剩余 {len(todo)} 页｜等待中…")
                if qd == 0 and idle >= args.idle_stop:
                    log("   ℹ️ 队列已空且无进展 —— 判定这些 prompt 已丢，转入重投")
                    break
            time.sleep(args.poll)

        # 队列空后若仍有缺口：重投（presubmit 只投未落地的页）
        done = landed()
        missing = [e for e in entries if e["page"] not in done]
        if not missing:
            break
        log(f"   🔁 重投 {len(missing)} 页…")
        subprocess.run([str(HERE / "run_batch.sh"), "presubmit_batch.py", str(story)],
                       cwd=str(STUDIO))

    done = landed()
    if mac_root:
        # 兜底：把 ComfyUI 端存在但没走 history 路径的图也拉一遍
        subprocess.run([sys.executable, str(HERE / "mirror_output.py"), subdir, str(mac_root)],
                       cwd=str(STUDIO))
        done = landed()
    log(f"🏁 收尾：Mac 已落地 {len(done)} 页")
    report_path.write_text("\n".join(logs) + "\n", encoding="utf-8")
    log(f"📄 报告：{report_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
