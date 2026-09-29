#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""带逐步计时的 in-context A/B —— 上一版总量对比把我的模型打脸了。

上一版：A(832x1216) 91.2s / B(512x768) 100.7s / C(512x768,end0.70) 92.1s
→ 降参考图分辨率不但没快，还慢了 11%。所以「注意力 ∝ n²，降 token 就快」
  这个模型至少在这个节点上不成立。必须看清时间花在哪一段。

做法：每次提交前后数 app.log 行数，把新增行里的 tqdm 进度
（`x/y [mm:ss<mm:ss, s/it]`）全抽出来。s/it 序列会直接显示「参考生效段」
和「参考失效段」各自多快、各占多少步。

配置（同一 seed / 同一 17 步 / 同一 LoRA）：
    A  2 refs @832x1216  end 0.85   ← 改前
    B  2 refs @512x768   end 0.85
    C  2 refs @512x768   end 0.70
    D  2 refs @832x1216  end 0.70
    E  1 ref  @832x1216  end 0.85   ← 检验「参考张数」才是那个真旋钮
"""
import importlib.util as iu
import json
import os
import re
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import vram

HOST = "127.0.0.1:8188"
OUT = "/tmp/luoqian/incontext_ab2"
os.makedirs(OUT, exist_ok=True)
LOG = "C:/Users/30902/AppData/Roaming/Comfy Desktop/logs/app.log"
HERE = Path(__file__).resolve().parent

# --- 复用上一版的图构造（它已加 __main__ 守卫，import 不会跑主流程）---
_s = iu.spec_from_file_location("probe_incontext_ab", HERE / "probe_incontext_ab.py")
_ab = iu.module_from_spec(_s)
_s.loader.exec_module(_ab)
ab = {"graph": _ab.graph, "post": _ab.post, "SEED": _ab.SEED, "W": _ab.W, "H": _ab.H}

TQDM = re.compile(r"(\d+)/(\d+)\s*\[[\d:]+<[\d:]+,\s*([\d.]+)s/it\]")


def _ssh(cmd):
    p = subprocess.run(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=25", "win30902", cmd],
                       capture_output=True)
    return p.stdout.decode("utf-8", errors="replace")


def log_count():
    out = _ssh(f'powershell -NoProfile -Command "(Get-Content \'{LOG}\').Count"')
    try:
        return int(out.strip().splitlines()[-1])
    except Exception:
        return -1


def log_since(n):
    return _ssh(f'powershell -NoProfile -Command "Get-Content \'{LOG}\' | Select-Object -Skip {n}"')


def profile(text):
    seen = {}
    for m in TQDM.finditer(text):
        seen[int(m.group(1))] = float(m.group(3))
    if not seen:
        return None
    steps = [seen[k] for k in sorted(seen)]
    bi, drop = None, 0.0
    for i in range(1, len(steps)):
        d = steps[i - 1] - steps[i]
        if d > drop:
            drop, bi = d, i
    if bi and drop > 0.3 * max(steps):
        slow, fast = steps[:bi], steps[bi:]
    else:
        slow, fast = steps, []
    return {"ns": len(slow), "slow": sum(slow) / len(slow),
            "nf": len(fast), "fast": (sum(fast) / len(fast) if fast else None),
            "all": steps}


def graph_1ref(rw, rh, endp, seed, prefix):
    g = ab["graph"](rw, rh, endp, seed, prefix)
    # 单参考：AnimaRefEncode 直接接 AnimaInContextApply，跳过 LatentBatch
    g["20"]["inputs"]["ref_latent"] = ["13", 0]
    del g["14"], g["15"], g["11"]
    return g


CFG = [
    ("A_2ref_832x1216_e0.85", 832, 1216, 0.85, 2),
    ("B_2ref_512x768_e0.85", 512, 768, 0.85, 2),
    ("C_2ref_512x768_e0.70", 512, 768, 0.70, 2),
    ("D_2ref_832x1216_e0.70", 832, 1216, 0.70, 2),
    ("E_1ref_832x1216_e0.85", 832, 1216, 0.85, 1),
]

print(f"起始空闲显存 {vram.vram_free_mib(HOST)} MiB\n")
res = {}
for label, rw, rh, endp, nref in CFG:
    before = log_count()
    t0 = time.time()
    g = ab["graph"](rw, rh, endp, ab["SEED"], f"ICAB2/{label}") if nref == 2 \
        else graph_1ref(rw, rh, endp, ab["SEED"], f"ICAB2/{label}")
    pid = ab["post"]("/prompt", {"prompt": g, "client_id": "icab2"})["prompt_id"]
    sec = None
    while time.time() - t0 < 1200:
        time.sleep(1.0)
        try:
            d = json.loads(urllib.request.urlopen(f"http://{HOST}/history/{pid}", timeout=60)
                           .read().decode()).get(pid)
        except Exception:
            d = None
        if d and d.get("status", {}).get("completed"):
            mm = d["status"].get("messages", [])
            a = next((x[1]["timestamp"] for x in mm if x[0] == "execution_start"), None)
            b = next((x[1]["timestamp"] for x in mm if x[0] == "execution_success"), None)
            sec = (b - a) / 1000.0 if (a and b) else time.time() - t0
            for vv in d.get("outputs", {}).values():
                for im in vv.get("images", []):
                    q = urllib.parse.urlencode({"filename": im["filename"],
                                                "subfolder": im.get("subfolder", ""), "type": "output"})
                    with urllib.request.urlopen(f"http://{HOST}/view?{q}", timeout=180) as r, \
                            open(f"{OUT}/{label}.png", "wb") as f:
                        f.write(r.read())
            break
    if sec is None:
        print(f"  {label}: ❌ 超时"); continue
    p = profile(log_since(before))
    res[label] = (sec, p)
    if p:
        fs = f"{p['fast']:.2f}s/it ×{p['nf']}" if p["fast"] else "—"
        print(f"  {label:<24} {sec:6.1f}s | 慢段 {p['slow']:.2f}s/it ×{p['ns']:>2}  "
              f"快段 {fs}", flush=True)
    else:
        print(f"  {label:<24} {sec:6.1f}s | （没抓到 tqdm）", flush=True)

print("\n  s/it 序列：")
for k, (sec, p) in res.items():
    if p:
        print(f"    {k:<24} {[round(x, 2) for x in p['all']]}")
