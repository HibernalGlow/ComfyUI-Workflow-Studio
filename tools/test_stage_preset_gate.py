#!/usr/bin/env python3
"""
Stage 采样闸门回归测试 —— 不需要 GPU / 不需要 ComfyUI，纯函数级验证。

守的是这一条规矩：
    双层（two-stage）预设的 Stage 2 denoise 必须 < 1.0。

为什么：`denoise = 1.0` 的采样器会把接到的潜空间丢掉、从纯噪声重开，于是 Stage 1 的
结果永远进不了成图 —— 但它的步数照跑照算。实测（页 RB001 / silvermoonmixAnima_v23_INT8 /
832x1216）：Stage 1 + denoise 1.0 与「干脆删掉 Stage 1」逐像素相同（RMSE = 0），而任何
< 1.0 的取值都会改变成图（RMSE 0.29–0.31）。也就是说，只有 < 1.0 时 Stage 1 才存在。

原来这里有个三层同时漏的 bug，这个文件就是钉它：
    · py/services/gen_presets_service.py 从没往图上写过 denoise
    · 于是 Workflows/*.json 里烤死的 1.0 生效
    · static/js/core/presets.js 的 double 分支也不写这个字段
任何一层复发，本文件都会红。

用法：python3 tools/test_stage_preset_gate.py
退出码：0 = 全通；1 = 有用例失败。
"""

import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(ROOT))

from py.services.gen_presets_service import (   # noqa: E402
    GenPresetsService,
    STAGE2_DENOISE_DEFAULT,
    _DEFAULT_GEN_PRESETS,
)

FAILS = []


def check(name, ok, detail=""):
    print(f"  {'✅' if ok else '❌'} {name}")
    if not ok:
        print(f"       {detail}")
        FAILS.append(name)


def find_preset(mode):
    presets = json.loads((ROOT / "data/gen_presets.json").read_text(encoding="utf-8"))
    for p in presets:
        if p.get("sampling_mode") == mode:
            return p
    raise SystemExit(f"data/gen_presets.json 里没有 sampling_mode={mode!r} 的预设")


# ---------------------------------------------------------------------------
# 1. 落盘的预设记录本身
# ---------------------------------------------------------------------------
print("1. 落盘的双层预设记录")
two = find_preset("double")
check("stage2 denoise < 1.0", two["sampler_stage2"]["denoise"] < 1.0,
      f"实际 {two['sampler_stage2']['denoise']!r} —— 等于 1.0 时 Stage 1 是死代码")
check("stage1 denoise == 1.0", two["sampler_stage1"]["denoise"] == 1.0,
      "Stage 1 从空潜空间起步，低于 1.0 没有意义")
check("单采样预设的 denoise == 1.0", find_preset("single")["sampler_settings"]["denoise"] == 1.0,
      "单采样没有上游阶段可以继承，1.0 才对")


# ---------------------------------------------------------------------------
# 2. UI 格式工作流：真文件、真 applier
# ---------------------------------------------------------------------------
print("2. UI 格式（animanga-liino-clean.json）")
svc = GenPresetsService()
wf_path = ROOT / "Workflows" / "animanga-liino-clean.json"
if not wf_path.exists():
    wf_path = ROOT.parent / "Workflows" / "animanga-liino-clean.json"

if wf_path.exists():
    # Stamp sentinels over the baked sampler values first. Asserting "< 1.0" alone is not enough:
    # node 724 ships with a sub-1 value already, so an applier that never touches it would pass.
    # With 0.11/0.22 in place, only a write can produce the preset's own numbers.
    wf = json.loads(wf_path.read_text(encoding="utf-8"))
    nodes = {n.get("id"): n for n in wf.get("nodes", [])}
    stage1, stage2 = nodes.get(836), nodes.get(724)
    check("双层工作流里找得到 836/724 两个采样器", stage1 is not None and stage2 is not None)
    stage1["widgets_values"][2:7] = [11, 0.11, "euler", "normal", 0.11]
    stage2["widgets_values"][2:7] = [22, 0.22, "euler", "normal", 0.22]

    out = svc.apply_preset_to_workflow(json.loads(json.dumps(wf)), two)
    out_nodes = {n.get("id"): n for n in out.get("nodes", [])}
    w1 = out_nodes[836]["widgets_values"]
    w2 = out_nodes[724]["widgets_values"]
    s1, s2 = two["sampler_stage1"], two["sampler_stage2"]
    check("Stage 1 拿到的是预设的 stage1 值（不是 stage2 的）",
          w1[2:7] == [s1["steps"], s1["cfg"], s1["sampler_name"], s1["scheduler"], s1["denoise"]],
          f"实际 {w1[2:7]}，期望 {[s1['steps'], s1['cfg'], s1['sampler_name'], s1['scheduler'], s1['denoise']]}")
    check("Stage 2 拿到的是预设的 stage2 值",
          w2[2:7] == [s2["steps"], s2["cfg"], s2["sampler_name"], s2["scheduler"], s2["denoise"]],
          f"实际 {w2[2:7]}，期望 {[s2['steps'], s2['cfg'], s2['sampler_name'], s2['scheduler'], s2['denoise']]}")
    check("Stage 2 denoise < 1.0", w2[6] < 1.0, f"实际 {w2[6]!r}")
    check("Stage 1 未被旁路", out_nodes[836].get("mode") == 0, f"mode={out_nodes[836].get('mode')!r}")
    check("Stage 2 未被旁路", out_nodes[724].get("mode") == 0, f"mode={out_nodes[724].get('mode')!r}")

    single = find_preset("single")
    out1 = svc.apply_preset_to_workflow(json.loads(json.dumps(wf)), single)
    out1_nodes = {n.get("id"): n for n in out1.get("nodes", [])}
    ss = single["sampler_settings"]
    check("单采样时 Stage 1 被旁路（mode 4）", out1_nodes[836].get("mode") == 4,
          f"mode={out1_nodes[836].get('mode')!r}")
    check("单采样设置落在 Stage 2 上",
          out1_nodes[724]["widgets_values"][2:7] ==
          [ss["steps"], ss["cfg"], ss["sampler_name"], ss["scheduler"], ss["denoise"]],
          f"实际 {out1_nodes[724]['widgets_values'][2:7]}")
    check("单采样时 Stage 2 denoise == 1.0", out1_nodes[724]["widgets_values"][6] == 1.0)

    # The bug this pins: `KSampler Config (rgthree)` matched the bare substring "KSampler",
    # became Stage 1, and the real Stage 1 was written as if it were Stage 2.
    config_node = next((n for n in wf["nodes"] if "Config" in (n.get("type") or "")), None)
    check("采样器识别不会把 KSampler Config 当采样器",
          config_node is not None and
          out_nodes[config_node["id"]].get("widgets_values") == config_node.get("widgets_values"),
          "Config 节点的 widgets 被改写了 —— 节点识别又退回到按子串匹配")
else:
    print(f"  ⏭  跳过（找不到 {wf_path}）")


# ---------------------------------------------------------------------------
# 3. API 格式工作流（batch 生成走的那条路）
# ---------------------------------------------------------------------------
print("3. API 格式（836/724 直连图）")
api_wf = {
    "836": {"class_type": "FLS_SamplerV4", "inputs": {
        "model": ["1", 0], "latent_image": ["4", 0], "steps": 5, "cfg": 4.6,
        "sampler_name": "er_sde", "scheduler": "simple", "denoise": 1.0}},
    "724": {"class_type": "FLS_SamplerV4", "inputs": {
        "model": ["20", 0], "latent_image": ["836", 0], "steps": 12, "cfg": 1.6,
        "sampler_name": "dpmpp_2m_sde_gpu", "scheduler": "beta57", "denoise": 1.0}},
}
out = svc.apply_preset_to_workflow(json.loads(json.dumps(api_wf)), two)
check("API 图 Stage 2 inputs.denoise < 1.0", out["724"]["inputs"]["denoise"] < 1.0,
      f"实际 {out['724']['inputs']['denoise']!r}")
check("API 图 Stage 2 的 latent 指向 Stage 1", out["724"]["inputs"]["latent_image"] == ["836", 0])
check("API 图 Stage 1 denoise == 1.0", out["836"]["inputs"]["denoise"] == 1.0)

out1 = svc.apply_preset_to_workflow(json.loads(json.dumps(api_wf)), single and find_preset("single"))
check("API 图单采样时 Stage 2 latent 改指空潜空间", out1["724"]["inputs"]["latent_image"] == ["4", 0])
check("API 图单采样时 denoise == 1.0", out1["724"]["inputs"]["denoise"] == 1.0)


# ---------------------------------------------------------------------------
# 4. 防退化：老预设（没有 denoise 字段）也不能退回 1.0
# ---------------------------------------------------------------------------
print("4. 老预设 / 空字段的默认值")
legacy = {"id": "legacy", "sampling_mode": "double",
          "sampler_stage1": {"steps": 5, "cfg": 4.6, "sampler_name": "er_sde", "scheduler": "simple"},
          "sampler_stage2": {"steps": 12, "cfg": 1.6, "sampler_name": "dpmpp_2m_sde_gpu",
                             "scheduler": "beta57"}}
out = svc.apply_preset_to_workflow(json.loads(json.dumps(api_wf)), legacy)
check("缺 denoise 字段时默认值 < 1.0", out["724"]["inputs"]["denoise"] < 1.0,
      f"实际 {out['724']['inputs']['denoise']!r} —— 老预设会静默退回「Stage 1 白跑」")
check("默认值与导出的常量一致", out["724"]["inputs"]["denoise"] == STAGE2_DENOISE_DEFAULT)

# 存成 1.0 的双层预设（Windows 上那两份就是）不许被当真：那个字段在修复前从来没被写进图里，
# 所以 1.0 不记录任何意图；当真就等于「双层」继续退化成「只有第二层」却报告成功。
stale = {"id": "stale", "sampling_mode": "double",
         "sampler_stage1": dict(legacy["sampler_stage1"], denoise=1.0),
         "sampler_stage2": dict(legacy["sampler_stage2"], denoise=1.0)}
out = svc.apply_preset_to_workflow(json.loads(json.dumps(api_wf)), stale)
check("预设显式写 1.0 时会被拒并换成默认值", out["724"]["inputs"]["denoise"] == STAGE2_DENOISE_DEFAULT,
      f"实际 {out['724']['inputs']['denoise']!r} —— 显式的 1.0 被当真了，Stage 1 又变成死代码")
out_ui = svc.apply_preset_to_workflow(
    json.loads(json.dumps({"nodes": [
        {"id": 929, "type": "KSampler Config (rgthree)", "widgets_values": [30, 24, 8, "euler", "beta57"]},
        {"id": 836, "type": "FLS_SamplerV4", "mode": 4, "widgets_values": [1, "randomize", 5, 4.6, "er_sde", "simple", 1]},
        {"id": 724, "type": "FLS_SamplerV4", "mode": 0, "widgets_values": [2, "randomize", 12, 1.6, "dpmpp_2m_sde_gpu", "simple", 1]},
    ]})), stale)
ui_nodes = {n["id"]: n for n in out_ui["nodes"]}
check("UI 格式下也同样拒掉 1.0", ui_nodes[724]["widgets_values"][6] == STAGE2_DENOISE_DEFAULT,
      f"实际 {ui_nodes[724]['widgets_values'][6]!r}")


# ---------------------------------------------------------------------------
# 5. 内置默认预设（首次启动会落盘的那份）
# ---------------------------------------------------------------------------
print("5. _DEFAULT_GEN_PRESETS")
doubles = [p for p in _DEFAULT_GEN_PRESETS if p.get("sampling_mode") == "double"]
check("至少有一份双层默认预设", bool(doubles))
for p in doubles:
    check(f"{p['id']}: stage2 denoise < 1.0", p["sampler_stage2"]["denoise"] < 1.0,
          f"实际 {p['sampler_stage2']['denoise']!r}")


# ---------------------------------------------------------------------------
# 6. 各处的默认值同源（服务端 / 前端 / 批跑脚本 / batch_generator 各有一份）
# ---------------------------------------------------------------------------
print("6. 各处硬编码的默认值")
import re  # noqa: E402

sites = [
    (ROOT / "static/js/core/presets.js",
     r"PRESET_STAGE2_DENOISE_DEFAULT\s*=\s*([0-9.]+)"),
    (ROOT / "tools/run_typhon_batch.py",
     r'1\.0 if mode != "double" else ([0-9.]+)'),
    (ROOT.parent / "batch_generator.py",
     r'"latent_image":\s*\["836", 0\],\s*\n(?:\s*#[^\n]*\n)*\s*"denoise":\s*([0-9.]+)'),
]

check("presets.js 导出了 PRESET_STAGE2_DENOISE_DEFAULT",
      "PRESET_STAGE2_DENOISE_DEFAULT" in (ROOT / "static/js/core/presets.js").read_text(encoding="utf-8"))
check("double 模式的字段清单含 stage2denoise",
      "stage2denoise" in (ROOT / "static/js/core/presets.js").read_text(encoding="utf-8"))
for path, pattern in sites:
    label = path.name
    if not path.exists():
        print(f"  ⏭  {label} 不在（跳过）")
        continue
    m = re.search(pattern, path.read_text(encoding="utf-8"))
    if not m:
        check(f"{label}: 找不到 Stage 2 denoise 默认值", False,
              "模式没匹配上 —— 写法变了就同步改本闸门的 pattern")
        continue
    value = float(m.group(1))
    check(f"{label}: 默认值与 STAGE2_DENOISE_DEFAULT 相同（{value}）",
          value == STAGE2_DENOISE_DEFAULT,
          f"{value} != {STAGE2_DENOISE_DEFAULT}（改值必须四处一起改）")
    check(f"{label}: 默认值 < 1.0", value < 1.0, f"{value} 时 Stage 1 是死代码")

print()
if FAILS:
    print(f"❌ {len(FAILS)} 个用例失败：")
    for f in FAILS:
        print(f"   · {f}")
    sys.exit(1)
print("✅ 全部通过 —— 双层预设的 Stage 1 不会被静默降级成死代码")
