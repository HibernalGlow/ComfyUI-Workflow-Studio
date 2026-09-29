"""tools/vram.py — 出图前把上一次任务占的显存清掉。

## 为什么需要

ComfyUI 默认是 full cache mode：上一次任务用过的模型、LoRA 栈、文本编码器残块、
latent 缓存，全都留在显存里等着复用。页数一多（storyboard 一批几十页），新一页
能用的空间就只剩零头，于是权重被 async offload 到内存，**每一步都走 PCIe**。
症状很有欺骗性：`nvidia-smi` 显示 GPU 利用率 90%+、温度八十多度、功耗也上去了，
但就是慢 —— 看起来像跑在集成显卡上，其实是显存不够、一直在等总线。

## 用的是哪个接口，以及它的真实语义（重要）

ComfyUI core 自带 `POST /free`（`server.py` 的 `post_free`）。但它**不是立刻执行**，
而是给队列**留一个待办标记**：

    # server.py —— 只是设 flag
    if unload_models: self.prompt_queue.set_flag("unload_models", True)
    if free_memory:   self.prompt_queue.set_flag("free_memory", True)

    # main.py 的主循环 —— 注意顺序：取任务 → 执行 → 才读 flag 并清零
    while True:
        queue_item = q.get(timeout=...)      # (A) 取下一件
        if queue_item is not None:
            e.execute(...)                   # (B) 执行
        flags = q.get_flags()                # (C) 读走并清空
        if flags.get("unload_models"): unload_all_models()
        if free_memory:                e.reset()          # 清执行缓存
        gc.collect(); soft_empty_cache()     # torch.cuda.empty_cache()

所以有两件必须知道的事：

1. **它永远不会打断正在跑的任务** —— 只在两次任务之间的空档生效。
2. **如果「提交前一秒才发 /free」，清理会晚一页才生效**：那时任务已经进了队列，
   主循环会先执行它、再读 flag。要让「本页开跑前就干净」，必须等一个空闲轮询周期
   （`gc_collect_interval` = 10s）让 flag 落地 —— 见 `settle_timeout`。

于是最省时间的用法是**反着来**：提交完一页立刻留标记（`mark_free()`）。
那一页渲染期间标记一直挂着，渲染一结束主循环就读走并清理干净，
下一页天生从干净显存开始，**steady-state 零额外耗时**。

## 开关（默认**关**）

实测：对一张 832×1216 / 17 步的页，逐页清显存只会多花 **+5.4s/页（+31%）** ——
清掉之后下一张要重新装载模型、重打 LoRA patch，而显存根本没到紧的地步
（渲染期间最低空闲还有 ~3990 MiB）。所以它不是默认该开的东西。

只在显存真的紧张时才开：

* `FREE_VRAM=1` / `FREE_VRAM=0`（环境变量，`1`/`true`/`yes`/`on` 开，
  `0`/`false`/`no`/`off` 关）—— **设了就盖过 TOML**，方便一行命令临时开关；
* 不设环境变量时看作品 TOML 的 `[runtime] free_vram = true`；
* 两者都没有 → 不开。

该不该开的判据 = 渲染期间的**最低空闲显存**：低于约 1GB 才值得，
因为过那条线 ComfyUI 就会把权重往内存里换、每步走 PCIe。用
`tools/probe_pressure.py` 去量。
"""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request

DEFAULT_HOST = os.environ.get("COMFY_HOST", "127.0.0.1:8188")
DEFAULT_TIMEOUT = 30.0

# main.py 的空闲轮询间隔（gc_collect_interval）。等 flag 落地至少要跨过它。
GC_INTERVAL = 10.0
SETTLE_TIMEOUT = GC_INTERVAL + 6.0

# 一次清理要发的请求体。batch_generator.py（在 Studio 目录之外）有它自己的副本，
# tools/test_vram_gate.py 会钉住两边一致。
FREE_PAYLOAD = {"unload_models": True, "free_memory": True}

_TRUTHY = ("1", "true", "yes", "on")


def env_override() -> bool | None:
    """FREE_VRAM 显式设了就返回它的布尔值，没设（或空）返回 None。

    "显式设过" 和 "设成空" 要分开：空字符串当作没设，这样默认值才能是关。
    """
    raw = os.environ.get("FREE_VRAM")
    if raw is None or str(raw).strip() == "":
        return None
    return str(raw).strip().lower() in _TRUTHY


def enabled_from_env() -> bool:
    """默认关。只有 FREE_VRAM 显式给 1/true/yes/on 才开。

    给没有 TOML 可读的独立脚本用（run_illust_sandaljob / run_typhon_test /
    batch_generator）。有 TOML 的那条路请用 resolve()。
    """
    return bool(env_override())


def resolve(default: bool = False, enabled: bool | None = None) -> bool:
    """决定这次到底清不清。优先级从高到低：

      1. 调用方显式传的 enabled=
      2. 环境变量 FREE_VRAM（设了就盖过 TOML，让人能一行命令临时开关）
      3. default（作品 TOML [runtime] free_vram，或模块默认）

    用「盖过」而不是「与」：如果两者都必须为真，那 FREE_VRAM=1 单独设了却不开，
    与文档说的「全局开」相矛盾，属于会用错的设计。
    """
    if enabled is not None:
        return bool(enabled)
    ov = env_override()
    return bool(default) if ov is None else ov


def vram_free_mib(host: str | None = None, timeout: float = 20.0):
    """当前空闲显存（MiB）；读不到返回 None（不影响主流程）。"""
    h = host or DEFAULT_HOST
    try:
        with urllib.request.urlopen(f"http://{h}/system_stats", timeout=timeout) as r:
            for dev in json.loads(r.read().decode()).get("devices", []):
                if "vram_free" in dev:
                    return int(dev["vram_free"] / (1024 * 1024))
    except Exception:
        pass
    return None


def mark_free(host: str | None = None, timeout: float = DEFAULT_TIMEOUT) -> bool:
    """只留标记，不等待。返回有没有发出去。

    给「提交完一页立刻调用」用：标记会在那一页渲染结束时被主循环消费，
    于是**下一页**从干净显存开始，且不花额外时间。
    """
    h = host or DEFAULT_HOST
    try:
        req = urllib.request.Request(
            f"http://{h}/free",
            data=json.dumps(FREE_PAYLOAD).encode(),
            headers={"Content-Type": "application/json"},
        )
        urllib.request.urlopen(req, timeout=timeout).read()
        return True
    except (urllib.error.URLError, OSError, ValueError) as e:
        print(f"      ⚠️  清显存标记没发出去（不影响出图）：{type(e).__name__}: {e}")
        return False


def free_vram(host: str | None = None, quiet: bool = False, why: str = "",
              enabled: bool | None = None, settle: bool = True,
              settle_timeout: float = SETTLE_TIMEOUT,
              timeout: float = DEFAULT_TIMEOUT) -> bool:
    """清一次显存，并在需要时**等到它真的落地**。

    settle=True（默认）：标记之后等到显存明显被释放、或等满一个空闲轮询周期。
    适合「批次开跑前」用一次 —— 代价最多十几秒，换来第一页也干净。
    settle=False：只留标记立刻返回（等同 mark_free），适合逐页循环里用。
    timeout：只作用于那次 HTTP 请求本身。
    """
    if enabled is None:
        enabled = enabled_from_env()
    if not enabled:
        return False

    h = host or DEFAULT_HOST
    before = None if quiet else vram_free_mib(h, timeout=20.0)
    if not mark_free(h, timeout=timeout):
        return False
    if not settle:
        return True

    # 等 flag 落地：主循环空闲轮询间隔是 GC_INTERVAL，跨过它才会被读走并执行。
    deadline = time.time() + settle_timeout
    released = False
    while time.time() < deadline:
        time.sleep(0.5)
        cur = vram_free_mib(h, timeout=10.0)
        if cur is None:
            break
        if before is not None and cur >= before + 64:   # 明显释放了，不用等满
            released = True
            break
        if before is None:
            released = True
            break

    if not quiet:
        tag = f"（{why}）" if why else ""
        after = vram_free_mib(h, timeout=20.0)
        if before is not None and after is not None:
            freed = after - before
            note = "" if released else "（等满一个轮询周期，可能有别的任务在跑）"
            print(f"      🧹 已清显存{tag}：空闲 {before} → {after} MiB"
                  + (f"（释放 {freed} MiB）" if freed > 0 else "") + note)
        else:
            print(f"      🧹 已清显存{tag}")
    return True
