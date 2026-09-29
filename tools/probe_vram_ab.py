#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""A/B：逐页清显存 vs 不清，到底谁快。

上一轮单次测量给出「清完再跑慢 6.4s」，但那只有一次样本、还是连续第 5 次运行，
可能是热/缓存效应。这里交替跑、取中位数，并且在渲染期间采样显存最低点，
看「显存到底紧不紧」—— 因为清显存的唯一价值就是避免显存不足导致的权重换出。

序列：dirty dirty dirty | clean clean clean | dirty dirty dirty
      （第一个 dirty 之前先热身一次并丢弃）
"""
import json, statistics, sys, time, urllib.request, copy
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import vram

HOST = "127.0.0.1:8188"
BASE = json.load(open("/tmp/luoqian/RB001_workflow.json"))
STEPS = 17


def build(prefix, seed):
    wf = copy.deepcopy(BASE)
    s2 = wf["41"]["inputs"]
    s2.update({"latent_image": ["4", 0], "steps": STEPS, "cfg": 1.6,
               "sampler_name": "dpmpp_2m_sde_gpu", "scheduler": "beta57",
               "denoise": 1.0, "seed": seed})
    wf["40"]["inputs"]["seed"] = seed
    wf["60"]["inputs"]["filename_prefix"] = prefix
    return wf


def post(p, d):
    r = urllib.request.Request(f"http://{HOST}{p}", data=json.dumps(d).encode(),
                               headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(r, timeout=120) as resp:
        return json.loads(resp.read().decode())


_seed = [10_000_000]


def run(tag):
    """跑一页；渲染期间采样显存最低点。返回 (耗时, 最低空闲显存 MiB)。

    ⚠️ 每次必须换 seed：ComfyUI 是**逐节点缓存**的，同 seed 同图时采样器的输出
    会被直接复用，整页 0.1s 就"跑完"了 —— 那测的是缓存命中，不是渲染。
    """
    _seed[0] += 1
    pid = post("/prompt", {"prompt": build(f"VRAMAB/{tag}", _seed[0]), "client_id": tag})["prompt_id"]
    lo = None
    while True:
        time.sleep(0.7)
        v = vram.vram_free_mib(HOST, timeout=10)
        if v is not None:
            lo = v if lo is None else min(lo, v)
        rec = urllib.request.urlopen(f"http://{HOST}/history/{pid}", timeout=60)
        data = json.loads(rec.read().decode()).get(pid)
        if data and data.get("status", {}).get("completed"):
            msgs = data["status"].get("messages", [])
            ta = next((m[1]["timestamp"] for m in msgs if m[0] == "execution_start"), None)
            tb = next((m[1]["timestamp"] for m in msgs if m[0] == "execution_success"), None)
            return (tb - ta) / 1000.0, lo


print("热身…", flush=True)
run("warmup")

seq = [("dirty", f"d{i}") for i in range(1, 4)] + \
      [("clean", f"c{i}") for i in range(1, 4)] + \
      [("dirty", f"d{i}") for i in range(4, 7)]

res = {"dirty": [], "clean": []}
for mode, tag in seq:
    if mode == "clean":
        vram.free_vram(host=HOST, quiet=True, why=tag, settle_timeout=16.0)
        time.sleep(1.0)
    t, lo = run(tag)
    res[mode].append(t)
    print(f"   {mode:5s} {tag:4s}  {t:6.2f}s   渲染中最低空闲显存 {lo} MiB"
          + ("   ⚠️ 紧" if lo is not None and lo < 900 else ""), flush=True)

print()
for mode in ("dirty", "clean"):
    xs = res[mode]
    print(f"   {mode:5s}: n={len(xs)}  中位 {statistics.median(xs):6.2f}s  "
          f"min {min(xs):6.2f}s  max {max(xs):6.2f}s  全部 {[round(x,1) for x in xs]}")
d = statistics.median(res["dirty"])
c = statistics.median(res["clean"])
print(f"\n   → 逐页清显存 {'更快' if c < d else '更慢'} {abs(c-d):.1f}s/页 "
      f"（{(c/d-1)*100:+.0f}%）")
