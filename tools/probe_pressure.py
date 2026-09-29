#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""找出「显存开始在哪儿变紧」—— 逐页清显存只在变紧之后才有意义。

对每个配置渲染一页（每次换 seed，避免命中 ComfyUI 的逐节点缓存），
采样渲染期间的**最低空闲显存**。低于约 1GB 时 ComfyUI 就会把权重往内存里换，
那时每步都要走 PCIe，才会出现「像跑在集显上」的体感。

配置：
  A  2B  INT8  832x1216  17 步   ← storyboard 默认
  B  2.9B INT8 832x1216  17 步   ← 规则 0 的默认底模
  C  2.9B INT8 1536x2048 30 步   ← 他们用过的最大画布 + 全扩散
"""
import json, sys, time, urllib.request, copy
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import vram

HOST = "127.0.0.1:8188"
BASE = json.load(open("/tmp/luoqian/RB001_workflow.json"))
V2B = "silvermoonmixAnima_v23_INT8.safetensors"
V29 = "silvermoonmixAnima29B_v23_INT8.safetensors"

CONFIGS = [
    ("A 2B 832x1216 17步", V2B, 832, 1216, 17, "dpmpp_2m_sde_gpu", 1.6, 88888888),
    ("B 2.9B 832x1216 17步", V29, 832, 1216, 17, "dpmpp_2m_sde_gpu", 1.6, 88888889),
    ("C 2.9B 1536x2048 30步", V29, 1536, 2048, 30, "er_sde", 4.0, 88888890),
]


def build(unet, w, h, steps, sampler, cfg, seed, prefix):
    wf = copy.deepcopy(BASE)
    wf["1"]["inputs"]["unet_name"] = unet
    wf["4"]["inputs"].update({"width": w, "height": h})
    s2 = wf["41"]["inputs"]
    s2.update({"latent_image": ["4", 0], "steps": steps, "cfg": cfg,
               "sampler_name": sampler, "scheduler": "beta57", "denoise": 1.0, "seed": seed})
    wf["40"]["inputs"]["seed"] = seed
    wf["60"]["inputs"]["filename_prefix"] = prefix
    return wf


def post(p, d):
    r = urllib.request.Request(f"http://{HOST}{p}", data=json.dumps(d).encode(),
                               headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(r, timeout=180) as resp:
        return json.loads(resp.read().decode())


print(f"总显存 {vram.vram_free_mib(HOST)} MiB 空闲（起始）\n")
for label, unet, w, h, steps, sampler, cfg, seed in CONFIGS:
    tag = label.split()[0]
    pid = post("/prompt", {"prompt": build(unet, w, h, steps, sampler, cfg, seed, f"PRESS/{tag}"),
                           "client_id": tag})["prompt_id"]
    lo, t0 = None, time.time()
    while True:
        time.sleep(0.6)
        v = vram.vram_free_mib(HOST, timeout=10)
        if v is not None:
            lo = v if lo is None else min(lo, v)
        try:
            data = json.loads(urllib.request.urlopen(f"http://{HOST}/history/{pid}", timeout=60).read().decode()).get(pid)
        except Exception:
            data = None
        if data and data.get("status", {}).get("completed"):
            msgs = data["status"].get("messages", [])
            ta = next((m[1]["timestamp"] for m in msgs if m[0] == "execution_start"), None)
            tb = next((m[1]["timestamp"] for m in msgs if m[0] == "execution_success"), None)
            sec = (tb - ta) / 1000.0 if (ta and tb) else (time.time() - t0)
            break
        if time.time() - t0 > 900:
            sec, lo = None, lo
            print(f"  {label}: 超时"); break
    flag = ""
    if lo is not None:
        flag = "  ⚠️ 已经贴地，清显存才有意义" if lo < 1000 else "  余量充足"
    print(f"  {label:<24} {sec:6.1f}s   渲染中最低空闲 {lo} MiB{flag}", flush=True)
