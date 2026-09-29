#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
批次收尾器 —— 等当前跑批进程退出后，把**漏掉的页面**自动补跑到底。

为什么需要它
------------
跑批会中断（Mac 睡眠/重启、ComfyUI 卡住、某页超时、误按 Ctrl-C），而
`run_typhon_batch.py` 的失败保护只会「跳过这一页继续跑」，不会回头补。于是
长批次跑完总差几张，得人工比对目录再 `--only` 补 —— 这一步现在自动化。

工作方式（幂等，可反复执行）
---------------------------
1. 读作品 `batch.toml`，算出 `pages/` 里的**应有页**（stem 集合）；
2. 数 `mac_dir/output_subdir/` 里的 `*.png`，得到**已落地页**；
3. 若还有别的 runner 在跑同作品 → 先等它退出；
4. 对每个缺口：`run_batch.sh <runner> 1 --only <缺失码>` → `mirror_output.py` 回传；
5. 最多 `--rounds` 轮，每轮结束重新比对；写 `<作品目录>/finish_report.txt`。

用法
----
    tools/run_batch.sh finish_batch.py 明日方舟终末地_洛茜 run_rossi_batch.py
    tools/run_batch.sh finish_batch.py 明日方舟终末地_洛茜 run_rossi_batch.py --rounds 5

建议挂成 detached 屏（这样它连同批次一起不受父进程影响）：
    screen -dmS rossi_finish bash -lc 'cd <Studio> && exec /opt/homebrew/bin/python3 \\
        tools/finish_batch.py 明日方舟终末地_洛茜 run_rossi_batch.py > /tmp/rossi_finish.log 2>&1'
"""

from __future__ import annotations

import argparse
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
STUDIO = HERE.parent
STORYBOARD = STUDIO.parent / "Workflows/wild/storyboard"

try:
    import tomllib as _toml
except ModuleNotFoundError:                      # pragma: no cover
    import tomli as _toml                        # type: ignore


def resolve_story_dir(arg: str) -> Path:
    p = Path(arg).expanduser()
    for c in (p, STORYBOARD / arg):
        if (c / "batch.toml").is_file():
            return c.resolve()
    raise SystemExit(f"❌ 找不到作品目录（需含 batch.toml）：{arg}")


def running_pids(runner: str) -> list[int]:
    """同 runner 的活进程。

    必须排除自己：本脚本的命令行里也带着 runner 名字（argv），screen 的包装
    shell 更是把整条命令行抄了一遍 —— 不排掉就会“等自己退出”等到天亮。
    """
    out = subprocess.run(["ps", "-axo", "pid=,command="],
                         capture_output=True, text=True).stdout
    pids = []
    for line in out.splitlines():
        line = line.strip()
        if not line:
            continue
        pid, _, cmd = line.partition(" ")
        if not pid.isdigit() or runner not in cmd:
            continue
        if "finish_batch.py" in cmd or "pgrep" in cmd:
            continue
        # 只认真正在跑的 python 进程。screen 服务进程 / login shell 的命令行里
        # 也抄着 runner 名字，但它们可能比子进程活得久（screen 会话残留），
        # 把它们算进来就会“等一个不会退出的东西”。
        if "python" not in cmd.lower():
            continue
        pids.append(int(pid))
    return pids


def expected_stems(story: Path, cfg: dict) -> list[str]:
    pages_dir = (story / cfg["paths"]["pages_dir"]).resolve()
    glob = cfg["paths"].get("page_glob", "*.txt")
    return sorted(p.stem for p in pages_dir.glob(glob))


def landed_stems(story: Path, cfg: dict) -> set[str]:
    mac_root = (story / cfg["output"]["mac_dir"]).resolve()
    subdir = cfg["paths"]["output_subdir"]
    d = mac_root / subdir
    if not d.is_dir():
        return set()
    return {p.name.rsplit("_", 1)[0] for p in d.glob("*.png")}


def code_of(stem: str) -> str:
    return stem.split("—")[0].strip()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("story", help="作品目录名（或路径），需含 batch.toml")
    ap.add_argument("runner", help="作品 runner 文件名，例 run_rossi_batch.py")
    ap.add_argument("--rounds", type=int, default=3, help="最多补跑轮数（默认 3）")
    ap.add_argument("--wait-max", type=int, default=21600,
                    help="等当前批次退出的上限秒数（默认 6h）")
    args = ap.parse_args()

    story = resolve_story_dir(args.story)
    cfg = _toml.loads((story / "batch.toml").read_text(encoding="utf-8"))
    name = cfg.get("story", {}).get("name", story.name)
    report_path = story / "finish_report.txt"

    want = expected_stems(story, cfg)
    log_lines: list[str] = []

    def log(msg: str) -> None:
        line = f"[{time.strftime('%H:%M:%S')}] {msg}"
        print(line, flush=True)
        log_lines.append(line)

    log(f"🧾 作品：{name}（{story}）  应有 {len(want)} 页   runner={args.runner}")

    # ── 1. 等当前批次退出 ────────────────────────────────────────────────
    waited = 0
    while True:
        pids = running_pids(args.runner)
        if not pids:
            break
        if waited >= args.wait_max:
            log(f"❌ 等当前批次超时（{args.wait_max}s），pids={pids} —— 放弃补跑")
            report_path.write_text("\n".join(log_lines) + "\n", encoding="utf-8")
            return 2
        if waited % 300 == 0:
            done = len(landed_stems(story, cfg))
            log(f"⏳ 当前批次仍在跑（pids={pids}），已落地 {done}/{len(want)} 页 —— 继续等")
        time.sleep(30)
        waited += 30

    # ── 2. 逐轮补跑 ─────────────────────────────────────────────────────
    for rnd in range(1, args.rounds + 1):
        have = landed_stems(story, cfg)
        missing = [s for s in want if s not in have]
        log(f"—— 第 {rnd} 轮：{len(want) - len(missing)}/{len(want)} 页已落地，缺 {len(missing)} 页")
        if not missing:
            break
        codes = sorted({code_of(s) for s in missing})
        log(f"   补跑：{','.join(codes[:40])}{' …' if len(codes) > 40 else ''}")

        cmd = [str(HERE / "run_batch.sh"), args.runner, "1", "--only", ",".join(codes)]
        log(f"   $ {' '.join(cmd[1:])}")
        proc = subprocess.run(cmd, cwd=str(STUDIO))
        log(f"   补跑退出码 {proc.returncode}")

        subprocess.run([sys.executable, str(HERE / "mirror_output.py"),
                        cfg["paths"]["output_subdir"],
                        str((story / cfg["output"]["mac_dir"]).resolve())],
                       cwd=str(STUDIO))

    # ── 3. 收尾报告 ─────────────────────────────────────────────────────
    have = landed_stems(story, cfg)
    missing = [s for s in want if s not in have]
    log(f"🏁 收尾：{len(want) - len(missing)}/{len(want)} 页已落地"
        + (f"，仍缺 {len(missing)} 页：{', '.join(sorted({code_of(s) for s in missing}))}"
           if missing else "，全部完成 ✅"))
    report_path.write_text("\n".join(log_lines) + "\n", encoding="utf-8")
    log(f"📄 报告已写入 {report_path}")
    return 0 if not missing else 1


if __name__ == "__main__":
    sys.exit(main())
