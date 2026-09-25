"""
出图回传 —— 把 ComfyUI 端已生成的成品图镜像到 Mac 端。

用途有两个：
  1. 跑批时自动回传（run_typhon_batch.py 里的 fetch_images，逐张即时回传）；
  2. 对**已经在跑、来不及改代码**的批次做追补 —— 本脚本可以边跑边补。

列举方式走 ComfyUI 自己的 /history，避免用 ssh 列 Windows 目录
（中文文件名经 ssh 回传会被 GBK 编码破坏）。

用法：
  python mirror_output.py <output_subdir> <mac_dest_dir> [--watch-pid PID] [--interval 20]
"""

import argparse
import json
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

COMFY_HOST = "127.0.0.1:8188"


def list_outputs(subdir: str):
    """从 /history 收集该 subfolder 下所有成品图 (filename, subfolder, type)。"""
    with urllib.request.urlopen(f"http://{COMFY_HOST}/history", timeout=60) as r:
        hist = json.load(r)
    seen, out = set(), []
    for entry in hist.values():
        for node_out in (entry.get("outputs") or {}).values():
            for img in (node_out.get("images") or []):
                if img.get("subfolder") != subdir:
                    continue
                key = (img.get("filename"), img.get("subfolder"))
                if key in seen:
                    continue
                seen.add(key)
                out.append(img)
    return out


def mirror_once(subdir: str, dest_root: Path, verbose: bool = True) -> int:
    n = 0
    for img in list_outputs(subdir):
        sub = (img.get("subfolder") or "").replace("\\", "/").strip("/")
        out_dir = dest_root / sub if sub else dest_root
        out_path = out_dir / img["filename"]
        if out_path.exists() and out_path.stat().st_size > 0:
            continue
        try:
            qs = urllib.parse.urlencode({
                "filename": img["filename"], "subfolder": img.get("subfolder", ""),
                "type": img.get("type", "output"),
            })
            with urllib.request.urlopen(f"http://{COMFY_HOST}/view?{qs}", timeout=120) as r:
                blob = r.read()
            if not blob.startswith(b"\x89PNG"):
                raise ValueError("不是 PNG")
            out_dir.mkdir(parents=True, exist_ok=True)
            tmp = out_path.with_suffix(out_path.suffix + ".part")
            tmp.write_bytes(blob)
            tmp.replace(out_path)
            n += 1
            if verbose:
                print(f"   ⬇️  {img['filename']}  ({len(blob)//1024}KB)", flush=True)
        except Exception as e:
            print(f"   ⚠️  跳过 {img.get('filename')}: {e}", flush=True)
    return n


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("subdir")
    ap.add_argument("dest")
    ap.add_argument("--watch-pid", type=int, default=None,
                    help="该 PID 存活期间持续追补；退出后做最后一次全量")
    ap.add_argument("--interval", type=int, default=20)
    a = ap.parse_args()

    dest_root = Path(a.dest).expanduser().resolve()
    dest_root.mkdir(parents=True, exist_ok=True)
    print(f"📥 回传 {a.subdir}  →  {dest_root}", flush=True)

    total = 0
    if a.watch_pid:
        def alive(pid):
            try:
                import os
                os.kill(pid, 0)
                return True
            except OSError:
                return False
        while alive(a.watch_pid):
            total += mirror_once(a.subdir, dest_root, verbose=True)
            time.sleep(a.interval)
        print("   跑批进程已退出，做最后一次全量追补…", flush=True)

    total += mirror_once(a.subdir, dest_root, verbose=True)
    print(f"✅ 本次共回传 {total} 张 → {dest_root}", flush=True)


if __name__ == "__main__":
    main()
