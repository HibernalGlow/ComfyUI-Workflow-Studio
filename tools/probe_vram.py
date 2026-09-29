#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""量三件事（GPU 空闲时才有意义）：

  1. 固定开销 F 与每步成本 s —— 回答「为什么 12 步和 17 步耗时差不多」
  2. 一次出图之后显存被占了多少、/free 能释放多少
  3. 清完再跑同一页，耗时有没有变

图：RB001 的 API 图，单阶段（只用节点 41），832x1216，seed 固定。
"""
import json, os, sys, time, urllib.parse, urllib.request, copy
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import vram

HOST = "127.0.0.1:8188"
BASE = json.load(open("/tmp/luoqian/RB001_workflow.json"))


def build(steps, prefix):
    wf = copy.deepcopy(BASE)
    s2 = wf["41"]["inputs"]
    s2.update({"latent_image": ["4", 0], "steps": steps, "cfg": 1.6,
               "sampler_name": "dpmpp_2m_sde_gpu", "scheduler": "beta57",
               "denoise": 1.0, "seed": 88888888})
    wf["40"]["inputs"]["seed"] = 88888888
    wf["60"]["inputs"]["filename_prefix"] = prefix
    return wf


def post(p, d):
    r = urllib.request.Request(f"http://{HOST}{p}", data=json.dumps(d).encode(),
                               headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(r, timeout=120) as resp:
        return json.loads(resp.read().decode())


def get(p, timeout=120):
    with urllib.request.urlopen(f"http://{HOST}{p}", timeout=timeout) as resp:
        return json.loads(resp.read().decode())


def run(steps, tag):
    pid = post("/prompt", {"prompt": build(steps, f"VRAMPROBE/{tag}"), "client_id": tag})["prompt_id"]
    while True:
        time.sleep(1.0)
        rec = get(f"/history/{pid}").get(pid)
        if rec and rec.get("status", {}).get("completed"):
            msgs = rec["status"].get("messages", [])
            ta = next((m[1]["timestamp"] for m in msgs if m[0] == "execution_start"), None)
            tb = next((m[1]["timestamp"] for m in msgs if m[0] == "execution_success"), None)
            return (tb - ta) / 1000.0


def free_mib():
    return vram.vram_free_mib(HOST)


print(f"起始空闲显存: {free_mib()} MiB\n")

print("── 热身 ──", flush=True)
print(f"   {run(17, 'warmup'):.1f}s", flush=True)

print("\n── 1) 固定开销 vs 每步成本 ──", flush=True)
t1 = run(1, "s1")
print(f"   steps=1   {t1:6.2f}s", flush=True)
t4 = run(4, "s4")
print(f"   steps=4   {t4:6.2f}s", flush=True)
t12 = run(12, "s12")
print(f"   steps=12  {t12:6.2f}s", flush=True)
t17 = run(17, "s17")
print(f"   steps=17  {t17:6.2f}s", flush=True)
s = (t17 - t1) / 16.0
F = t1 - s
print(f"\n   拟合：每步 ≈ {s*1000:.0f} ms    固定开销(装载/CLIP/VAE解码/存图) ≈ {F:.1f}s")
print(f"   12 步 → 17 步，理论上只多 {(17-12)*s:.1f}s（{t12:.1f}s → {t17:.1f}s）"
      f"，占总耗时 {(17-12)*s/max(t17,1e-9)*100:.0f}%")

print("\n── 2) 一次出图后的显存占用 / /free 释放多少 ──", flush=True)
dirty = free_mib()
print(f"   出图刚结束（缓存还留着）: 空闲 {dirty} MiB")
ok = vram.free_vram(host=HOST, quiet=False, why="探针")
time.sleep(1.0)
clean = free_mib()
print(f"   清理后:                    空闲 {clean} MiB")
if dirty is not None and clean is not None:
    print(f"   → /free 释放了 {clean - dirty} MiB")

print("\n── 3) 干净状态下重跑同一页 ──", flush=True)
t17b = run(17, "s17clean")
print(f"   steps=17（清理后）{t17b:6.2f}s   vs 之前 {t17:.2f}s   "
      f"→ {'快' if t17b < t17 else '慢'} {abs(t17b-t17):.1f}s")
