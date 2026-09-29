#!/usr/bin/env python3
"""
清显存闸门回归测试 —— 不需要 GPU / 不需要 ComfyUI，纯函数 + 源码断言。

守的规矩：**每个会投递任务的脚本，投递完都要给 ComfyUI 留一个清显存标记。**

为什么值得钉住：ComfyUI 默认 full cache mode，上一个任务的模型 / LoRA 栈 /
文本编码器 / latent 缓存全留着。storyboard 一批几十页连跑时，新一页只剩零头显存，
权重就被 async offload 到内存、每步走 PCIe —— 症状是 `nvidia-smi` 显示
GPU 利用率 90%+、温度也高，但就是慢，看着像跑在集显上。

为什么是「投递完留标记」而不是「投递前清」：ComfyUI 的 `POST /free` 只是
`prompt_queue.set_flag(...)`，真正执行在 main.py 主循环里，而且是

    取任务 → 执行 → 读 flag 并清空 → unload_all_models() / e.reset() / empty_cache()

也就是**在一次任务执行完之后的空档**。所以：

  · 提交后立刻留标记 → 本页渲染期间标记挂着，渲染一结束就清干净，
    下一页从干净显存开始，steady-state 零额外耗时  ← 正确用法
  · 提交前一秒才清   → 那时任务已进队，清理会晚一页才生效  ← 曾经的错法

用法：python3 tools/test_vram_gate.py
退出码：0 = 全通；1 = 有用例失败。
"""

import json
import os
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))

import vram  # noqa: E402

FAILS = []


def check(name, ok, detail=""):
    print(f"  {'✅' if ok else '❌'} {name}")
    if not ok:
        print(f"       {detail}")
        FAILS.append(name)


def read(rel):
    return (ROOT / rel).read_text(encoding="utf-8")


# ---------------------------------------------------------------------------
# 1. 请求体：两处副本必须一致（vram.py 与 Studio 目录之外的 batch_generator.py）
# ---------------------------------------------------------------------------
print("1. /free 的请求体")
WANT = {"unload_models": True, "free_memory": True}
check("vram.FREE_PAYLOAD 正确", vram.FREE_PAYLOAD == WANT, f"实际 {vram.FREE_PAYLOAD}")

bg_path = ROOT.parent / "batch_generator.py"
if bg_path.exists():
    bg = bg_path.read_text(encoding="utf-8")
    m = re.search(r"json\.dumps\(\{([^}]*)\}\)\.encode", bg)
    body = m.group(1) if m else ""
    ok = ("\"unload_models\": True" in body.replace("'", '"')
          and "\"free_memory\": True" in body.replace("'", '"'))
    check("batch_generator.py 用同一个请求体", ok, f"实际 {body!r}")
    check("batch_generator.py 的 submit_task 会留标记",
          re.search(r"def submit_task[\s\S]{0,400}?mark_free_vram\(", bg) is not None
          or re.search(r"def submit_task[\s\S]{0,400}?/free", bg) is not None)
    check("batch_generator.py 有开跑前 settle 的版本",
          "def free_vram_and_wait" in bg)
else:
    print(f"     ⏭  跳过（{bg_path} 不在）")


# ---------------------------------------------------------------------------
# 2. 每个投递脚本都要留标记
# ---------------------------------------------------------------------------
print("\n2. 投递脚本的覆盖")
targets = [
    ("tools/run_typhon_batch.py", "def queue_prompt", "mark_free_vram("),
    ("tools/run_illust_sandaljob.py", "def queue(", "_free_vram_marker("),
    ("tools/run_typhon_test.py", "def queue_prompt", "_free_vram_marker("),
]
for rel, func, marker in targets:
    src = read(rel)
    seg = src[src.index(func):] if func in src else ""
    seg = seg[:1200]
    check(f"{rel}: {func.strip('def ')} 里留了标记",
          marker in seg, f"{func} 之后 1200 字符内没找到 {marker}")

# run_insert 不自建提交函数，走 rtb.queue_prompt —— 只要它用 rtb 的路子就自动覆盖
ri = read("tools/run_insert.py")
check("tools/run_insert.py 走 rtb.queue_prompt（自动继承标记）",
      "rtb.queue_prompt(" in ri, "它自己造了提交函数就会绕过标记")

# 引擎里提交完就留标记，调用方不用各自记
rtb_src = read("tools/run_typhon_batch.py")
seg = rtb_src[rtb_src.index("def queue_prompt"):]
seg = seg[:1400]
check("run_typhon_batch.queue_prompt 提交成功后才留标记",
      seg.index("prompt_id") < seg.index("mark_free_vram("),
      "标记要在拿到 prompt_id 之后发，否则提交失败也会留一堆标记")


# ---------------------------------------------------------------------------
# 3. settle 的时机：开跑前等，逐页不等
# ---------------------------------------------------------------------------
print("\n3. settle 时机")
check("settle 超时跨过一个空闲轮询周期（否则 flag 落不了地）",
      vram.SETTLE_TIMEOUT > vram.GC_INTERVAL,
      f"SETTLE_TIMEOUT={vram.SETTLE_TIMEOUT} 必须 > GC_INTERVAL={vram.GC_INTERVAL}")
check("GC_INTERVAL 对齐 ComfyUI main.py 的 gc_collect_interval=10.0",
      vram.GC_INTERVAL == 10.0, f"实际 {vram.GC_INTERVAL}")
check("批次开跑前有一次会等待的清理",
      re.search(r"free_vram\(why=f\"批次开跑前", rtb_src) is not None,
      "第一页没有「上一页渲染期间」可挂标记，必须在开跑前 settle 一次")
check("逐页循环里只用不等的那种",
      re.search(r"for idx, page in enumerate[\s\S]{0,6000}?mark_free_vram\(", rtb_src) is None
      and "mark_free_vram()" in rtb_src,
      "逐页调会等待的版本 = 每页白等十几秒")
# 逐页路径上不能出现会 settle 的 free_vram(quiet=False/默认)
loop = rtb_src[rtb_src.index("for idx, page in enumerate"):]
loop = loop[:8000]
bad = re.findall(r"[^_]free_vram\((?![^)]*settle=False)[^)]*\)", loop)
check("逐页循环里没有会等待的 free_vram 调用", not bad, f"发现 {bad[:3]}")


# ---------------------------------------------------------------------------
# 4. 开关：环境变量 + 作品 TOML
# ---------------------------------------------------------------------------
print("\n4. 开关（默认必须是关）")
saved = os.environ.get("FREE_VRAM")
try:
    for raw, want in (("", False), ("0", False), ("false", False), ("off", False),
                      ("NO", False), ("2", False), ("true", True), ("1", True),
                      ("YES", True), ("on", True), ("TRUE", True)):
        os.environ["FREE_VRAM"] = raw
        check(f"FREE_VRAM={raw!r} → {want}", vram.enabled_from_env() is want,
              f"实际 {vram.enabled_from_env()}")
    os.environ.pop("FREE_VRAM", None)
    check("FREE_VRAM 未设置时默认【关】", vram.enabled_from_env() is False,
          "默认开会让每一页白付 +31% 墙钟")
finally:
    if saved is None:
        os.environ.pop("FREE_VRAM", None)
    else:
        os.environ["FREE_VRAM"] = saved

check("关掉开关时一个请求都不发", vram.free_vram(enabled=False) is False)
check("run_typhon_batch 的模块级默认也是关",
      re.search(r"^FREE_VRAM_BEFORE_PAGE = False", rtb_src, re.M) is not None,
      "模块默认开着的话，没设环境变量的批跑会白付 +31%")
check("run_typhon_batch 用 resolve() 决定（env 盖过 TOML）",
      "_vram.resolve(default=FREE_VRAM_BEFORE_PAGE)" in rtb_src,
      "写成 and 会让 FREE_VRAM=1 单独设了却不开，与文档矛盾")

# 优先级：调用方 > 环境变量 > 默认（TOML）
_envbak = os.environ.get("FREE_VRAM")
try:
    os.environ.pop("FREE_VRAM", None)
    case = [("不设 env + 默认 False", vram.resolve(default=False), False),
            ("不设 env + 默认 True ", vram.resolve(default=True), True)]
    os.environ["FREE_VRAM"] = "1"
    case += [("env=1 盖过默认 False", vram.resolve(default=False), True),
             ("env=1 盖过默认 True ", vram.resolve(default=True), True)]
    os.environ["FREE_VRAM"] = "0"
    case += [("env=0 盖过默认 False", vram.resolve(default=False), False),
             ("env=0 盖过默认 True ", vram.resolve(default=True), False)]
    os.environ["FREE_VRAM"] = "1"
    case += [("enabled= 参数最优先  ", vram.resolve(default=True, enabled=False), False)]
    for name, got, want in case:
        check(f"{name} → {want}", got is want, f"实际 {got}")
finally:
    if _envbak is None:
        os.environ.pop("FREE_VRAM", None)
    else:
        os.environ["FREE_VRAM"] = _envbak
for rel in ("tools/run_illust_sandaljob.py", "tools/run_typhon_test.py"):
    src = read(rel)
    check(f"{rel}: 标记函数受开关控制",
          re.search(r"def _free_vram_marker\(\):[\s\S]{0,700}?if not _vram_on\(\):\s*\n\s*return", src) is not None,
          "没判开关就等于默认开")
if bg_path.exists():
    bg2 = bg_path.read_text(encoding="utf-8")
    check("batch_generator.py: 标记函数受开关控制",
          re.search(r"def mark_free_vram[\s\S]{0,900}?if not _vram_on\(\):\s*\n\s*return", bg2) is not None)

sc = read("tools/story_config.py")
check("story_config 支持 [runtime] free_vram 逐作品开",
      re.search(r'runtime\s*=\s*cfg\.get\("runtime"', sc) is not None
      and "FREE_VRAM_BEFORE_PAGE" in sc,
      "TOML 开关没接上，就只能靠环境变量全局开")


# ---------------------------------------------------------------------------
# 5. 失败必须只告警，不能中断整批
# ---------------------------------------------------------------------------
print("\n5. 失败容忍")
check("mark_free 收窄了异常类型且只打印告警",
      "清显存标记没发出去（不影响出图）" in read("tools/vram.py")
      or "清显存失败（不影响出图）" in read("tools/vram.py"),
      "清理失败不能让几十页白跑")
check("free_vram 在 ComfyUI 不可达时不抛异常",
      vram.free_vram(host="127.0.0.1:1", quiet=True) is False,
      "打不通的端口应该返回 False，不是抛异常")


print()
if FAILS:
    print(f"❌ {len(FAILS)} 个用例失败：")
    for f in FAILS:
        print(f"   · {f}")
    sys.exit(1)
print("✅ 全部通过 —— 清显存默认关、要开才开，且开的时候不拖慢 steady-state")
