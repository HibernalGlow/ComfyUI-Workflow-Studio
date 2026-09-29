#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""量当前启动参数下的一页耗时（与改动前的 17.52s 对比）。

每次换 seed —— ComfyUI 逐节点缓存，同 seed 同图会被直接复用，测出来是 0.1s。
"""
import json, statistics, sys, time, urllib.request, copy
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import vram

HOST = "127.0.0.1:8188"
BASE = json.load(open("/tmp/luoqian/RB001_workflow.json"))
N = 4


def build(seed):
    wf = copy.deepcopy(BASE)
    s2 = wf["41"]["inputs"]
    s2.update({"latent_image": ["4", 0], "steps": 17, "cfg": 1.6,
               "sampler_name": "dpmpp_2m_sde_gpu", "scheduler": "beta57",
               "denoise": 1.0, "seed": seed})
    wf["40"]["inputs"]["seed"] = seed
    wf["60"]["inputs"]["filename_prefix"] = f"PARAMS/s{seed}"
    return wf


def run(seed):
    req = urllib.request.Request(f"http://{HOST}/prompt",
                                data=json.dumps({"prompt": build(seed), "client_id": "params"}).encode(),
                                headers={"Content-Type": "application/json"}, method="POST")
    pid = json.loads(urllib.request.urlopen(req, timeout=60).read())["prompt_id"]
    lo = None
    while True:
        time.sleep(0.6)
        v = vram.vram_free_mib(HOST, timeout=10)
        if v is not None:
            lo = v if lo is None else min(lo, v)
        try:
            d = json.loads(urllib.request.urlopen(f"http://{HOST}/history/{pid}", timeout=60).read().decode()).get(pid)
        except Exception:
            d = None
        if d and d.get("status", {}).get("completed"):
            m = d["status"].get("messages", [])
            a = next((x[1]["timestamp"] for x in m if x[0] == "execution_start"), None)
            b = next((x[1]["timestamp"] for x in m if x[0] == "execution_success"), None)
            return (b - a) / 1000.0, lo


print(f"空闲显存 {vram.vram_free_mib(HOST)} MiB")
print("热身…", flush=True)
run(20_000_001)
xs, los = [], []
for i in range(N):
    t, lo = run(20_000_010 + i)
    xs.append(t); los.append(lo)
    print(f"  {i+1}/{N}  {t:6.2f}s   渲染中最低空闲 {lo} MiB", flush=True)
med = statistics.median(xs)
print(f"\n中位 {med:.2f}s   全部 {[round(x,1) for x in xs]}")
print(f"对比改动前（同一页、同 17 步、6 样本）：17.52s  →  {med:.2f}s  "
      f"({(med/17.52-1)*100:+.0f}%)")
print(f"渲染中最低空闲显存：{min(los)} MiB")
