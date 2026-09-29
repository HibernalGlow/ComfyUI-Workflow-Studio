"""
Batch Typhon Storyboard Runner
用 v2.3 底模 + 原版提丰 LoRA + Bubutuke 画师，
按序跑完 明日方舟_提丰/pages/ 下所有 TP*.txt 分镜页面。
"""

import json
import random
import zlib
import urllib.request
import urllib.parse
import time
import uuid
import sys
import os
import re
from pathlib import Path

# 本模块是被 story_config 用 importlib 按路径载入的，包不在 sys.path 上，
# 所以要自己把 tools/ 挂上去才能 import 同级模块。
_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

try:
    import vram as _vram
except ImportError:                    # 单文件拷出去用时降级：不报错，只是不清显存
    _vram = None

COMFY_HOST = "127.0.0.1:8188"
CLIENT_ID  = str(uuid.uuid4())

PAGES_DIR = Path("/Users/glow/Base/Works/ComfyUI/Workflows/wild/storyboard/明日方舟_提丰/pages")
PAGE_GLOB = "TP*.txt"   # 页面文件名模式（各作品前缀不同：提丰=TP，洛茜=R）

# ─── 固定配置 ────────────────────────────────────────────────
# 底模。可由作品 TOML 的 [base] unet 覆盖（不写则用这里这个）。
# 已注册可选：silvermoonmixAnima_v23_INT8.safetensors（默认） /
#             kirazuriAnima_v40\anima-kirazuri-v4-int8-convrot.safetensors /
#             anima-base-v1.0.safetensors / silvermoonmixAnima_v20_INT8.safetensors …
UNET_NAME       = "silvermoonmixAnima_v23_INT8.safetensors"

# ─── 架构开关（由作品 TOML [base] arch 覆盖）─────────────────
#   "anima"（默认）：OTUNetLoaderW8A8 + qwen CLIP/VAE + FLS_SamplerV4 + CR LoRA Stack
#   "illus"        ：CheckpointLoaderSimple + LoraLoader 链 + KSampler（SDXL/Illustrious）
# 两条线的图结构不通用：anima 的 LoRA 挂不上 SDXL checkpoint，反之亦然。
ARCH       = "anima"
CKPT_NAME  = "zukiAnimeILL_best.safetensors"   # illus 线的 checkpoint
WIDTH      = 832                                # anima 默认分辨率
HEIGHT     = 1216

# TOML [sampling] 覆盖：优先级高于采样预设，且因在 apply_preset 内部而逐页都成立。
# 用途：illus 线没有对应的 Studio 预设（那些预设自带 anima-turbo LoRA），直接在这里给定。
SAMPLING_OVERRIDE = {}

# 提示词替换表 [(from, to)]，由 TOML [[prompt.replace]] 提供。
# 用途：分镜里的标签与 LoRA 实际训练的触发词不一致时（常见于同一皮肤的两种英译），
# 在这里把前者换成后者，否则 LoRA 的概念不会被激活。
PROMPT_REPLACE = []
QUALITY_PREFIX  = "masterpiece, best quality, aesthetic, highly detailed, bubutuke, uncensored, typhoeusendfield"
NEGATIVE        = "worst quality, low quality, bad anatomy, bad hands, missing fingers, extra digit, fewer digits, watermark, text"
SEED            = 88888888   # 固定种子值（--seed / [sampling] seed / seed_mode=fixed 时用）
# ── 逐页种子模式（2026-09-28 新增）─────────────────────────────
# 背景：以前 SEED 是硬编码常量且全批只用它 ⇒ 24 页共用一个种子，
#       不同页只差提示词，构图倾向全挤在一起；重跑同一页更是几乎逐像素相同。
# 对齐 ComfyUI 自带的 randomize 语义：默认每页抽一个新随机种子。
#   random（默认）：每页随机 ⇒ 有变化；用的种子会打印并写进图元数据，可回查
#   hash         ：由页名派生 ⇒ 同页永远同种子，改配置后重跑可干净对比
#   fixed        ：全批用 SEED
# 优先级：--seed N / [sampling] seed > [runtime] seed_mode > 默认 random
SEED_MODE       = "random"
SEED_FIXED      = False

# 采样参数默认值 = Studio 预设 "anima-single-turbo"（12步 + Turbo）
STEPS           = 12
CFG             = 1.6
SAMPLER         = "euler_ancestral"
SCHEDULER       = "beta57"
TURBO_ENABLED   = True
TURBO_LORA_NAME = "Turbo-v0.2"

# 采样模式：single = 单采样器；double = Stage1 底模粗采 + Stage2 套 LoRA 精修
SAMPLING_MODE   = "single"
STAGE1          = {"steps": 5, "cfg": 4.6, "sampler_name": "er_sde", "scheduler": "simple", "denoise": 1.0}
# 主采样器 denoise（single 的唯一样本器 / double 的 Stage 2）。
# ⚠️ double 模式下必须 < 1.0，否则 Stage 2 会丢弃 Stage 1 的潜空间，
#    使 Stage 1 彻底变成死代码（实测：跳过 Stage 1 与保留时输出逐像素相同）。
DENOISE         = 1.0

# Studio 预设：优先读运行中 Studio 的实时接口，本地 data/ 仅作离线回退。
# 注意 data/ 在 .gitignore 里、只是 Mac 本地副本；真正的事实来源在 ComfyUI 侧
# user/default/Workflow-Studio/gen_presets.json，由 Studio UI 写入。
STUDIO_PRESETS_API = f"http://{COMFY_HOST}/api/wfm/gen_presets"
PRESETS_FILE = Path(__file__).resolve().parent.parent / "data" / "gen_presets.json"

LORAS = [
    # (switch, name, path, model_w, clip_w)
    ("On", "Turbo-v0.2",        r"anima\turbo\anima-turbo-lora-v0.2.safetensors",                         0.8,  1.0),
    ("On", "Aesthetic Boost",   r"anima\beauty\anima-highres-aesthetic-boost.safetensors",                 0.48, 1.0),
    ("On", "Bubutuke",          r"anima\artist\260924\style-Bubutuke-Anima-v01.safetensors",               1.0,  1.0),
    ("On", "Typhoeus Base",     r"anima\chara\endfield\typhoeus_anima_base_v2.safetensors",               1.1,  1.0),
]

OUTPUT_SUBDIR = "明日方舟_提丰"   # SaveImage 文件名前缀目录名

# ─── in-context 参考图与逐页画布配置 ──────────────────────────────
NL_APPEND       = ""
INCONTEXT       = {}
PAGE_CANVAS     = []

# 生成后自动回传到 Mac 的根目录（None = 不回传，只留在 ComfyUI 端）。
# 由作品 TOML 的 [output] mac_dir 设置；路径按 ComfyUI 的 subfolder 结构镜像。
MAC_OUT_DIR = None

# 单页等待上限（秒）。由作品 TOML 的 [output] wait_timeout 设置。
# 注意：这是**从投递那刻起**算的墙上时间。若用插队（tools/run_insert.py）往队首
# 塞任务，队列里排在前面的一切都会计入本页的等待，所以打算插队就把这个值调大。
WAIT_TIMEOUT = 300

# ─── 触发式动作 LoRA 自动补挂 ─────────────────────────────────
# 背景：LORAS 是"手选基线"（加速/品质/画师/角色）。动作 LoRA 不应写死，
# 否则像 RS003 这类页子会根本没挂 ustirrup，底模自己画脚丫
# → 看起来"镫袜 LoRA 没应用"。这里按分镜文本从规则库自动匹配并追加。
#
# 具体数值全部由作品级 TOML 配置驱动（见 story_config.py / batch.toml），
# 引擎本身不再写死任何作品相关常量。
LORA_RULES_FILE = Path(__file__).resolve().parent.parent / "data" / "lora_rules.json"
AUTO_ACTION_LORAS = True
AUTO_LORA_CATEGORIES = {"action", "repair"}

# 逐页规则，形如：
#   {"name": "镫袜足交",
#    "when_triggers": ["ustirrup", ...],
#    "preset": "anima-native-30",      # 命中后换这个采样预设（None=不换）
#    "bundle_only": True,              # 只挂基线+本规则 loras，不再叠自动规则
#    "exclude_family": ["ustirrup", ...],  # 同族 checkpoint 一律不放行
#    "loras": [("On", name, path, model_w, clip_w), ...]}
PAGE_RULES = []
# 全局排除：名称/路径含这些关键字就不挂（例：hairop / footrepair）
AUTO_EXCLUDE_KEYWORDS = set()

# ─── 采样验证闸：踩脚页禁「双彩」────────────────────────────────
# 双层采样（双彩）是画质向预设，步数少（例 5+12）。镫袜 / 踩脚类 LoRA 的
# 足心横带、足弓、脚趾结构在这么少的步数下根本吃不满，出来必烂 ——
# 这类页面必须走全扩散（例 anima-native-30：30 步 er_sde / CFG4.0 / 无 Turbo）。
#
# 下面的关键词列表与放行预设可由作品 batch.toml 的 [validation] 段覆盖。
DEFAULT_FOOT_PLAY_KEYWORDS = (
    # 足交 / 套弄
    "under-stirrup footjob", "footjob", "dual footjob", "two-footed footjob",
    "rubbing corona with sole", "foot on penis",
    # 踩踏 / 膜拜
    "stepping on another", "trampling", "foot on chest", "foot worship",
    # 足部主导玩法
    "foot tickling", "foot in hand", "toe scrunch", "bare soles pressing",
)
# 第二层：**取景**类词。这些不是「把足部当主体来玩」，只是镜头语言，
# 单靠它们不足以断定必须 30 步 —— 所以只给提醒，不当门禁。
# （历史上把 foot focus 塞进硬门槛，结果 82 个无辜页面被喊狼来了。）
# 也刻意**不**收 bare toes / perfect toes 这类词 —— 它们常写在 quality_prefix 里，
# 每页都有，收进来只会把提醒淹没。
DEFAULT_FOOT_FRAME_KEYWORDS = (
    "foot focus", "sole focus", "presenting own foot",
)
FOOT_PLAY_KEYWORDS  = set()     # 空 = 用 DEFAULT_FOOT_PLAY_KEYWORDS
FOOT_FRAME_KEYWORDS = set()     # 空 = 用 DEFAULT_FOOT_FRAME_KEYWORDS
FOOT_ALLOW_PRESETS  = set()     # 踩脚页允许用的预设（不告警）
DOUBLE_PRESETS      = set()     # 额外指定为「双彩」的预设 id

# ─── 每页出图前清一次显存（**默认关**）─────────────────────
# 为什么默认关：实测对一张 832×1216 / 17 步的页，逐页清显存只会多花
# **+5.4s/页（+31%）** —— 清掉之后下一张要重新装载模型、重打 LoRA patch，
# 而那页渲染期间最低空闲显存还有 ~3990 MiB，根本没到紧的地步。
#
# 什么时候才该开：渲染期间最低空闲显存掉到 ~1GB 以下时 —— 过那条线 ComfyUI
# 就会把权重往内存里换，每步走 PCIe，那才是「GPU 利用率高但是慢」。
# 用 tools/probe_pressure.py 量，确认紧之后再开。
#
# 开启方式（两个都要满足才会真的清）：
#   FREE_VRAM=1              （环境变量，全局，1/true/yes/on）
#   作品 TOML [runtime] free_vram = true   （逐作品）
FREE_VRAM_BEFORE_PAGE = False
FREE_VRAM_TIMEOUT     = 60      # 卸模型可能要等几秒，别用太短的超时
# 踩脚页撞上双彩时的处置："block" 拦下不出图（默认）/ "warn" 只告警照跑
FOOT_GATE_MODE = "block"


def _trigger_hit(trig: str, text: str) -> bool:
    """边界感知匹配：避免 si \\(arknights\\) 命中 rossi \\(arknights\\) 这类子串。"""
    t = trig.strip().lower()
    if not t or not text:
        return False
    if re.search(r"(?<![a-z0-9])" + re.escape(t) + r"(?![a-z0-9])", text):
        return True
    clean = re.sub(r"[\\()@,_]", " ", t)
    clean = re.sub(r"\s+", " ", clean).strip()
    if not clean:
        return False
    return re.search(r"(?<![a-z0-9])" + re.escape(clean) + r"(?![a-z0-9])", text) is not None


def match_page_rule(positive_text: str):
    """返回第一条命中的逐页规则（没命中返回 None）。"""
    text = (positive_text or "").lower()
    for rule in PAGE_RULES:
        if any(_trigger_hit(t, text) for t in rule.get("when_triggers", [])):
            return rule
    return None


def matched_page_rules(positive_text: str) -> list:
    """返回**所有**命中的逐页规则。

    一页可能同时属于多个维度（例：念念 NN022 既是「YD 舞娘服饰」页，
    又是「镫袜足交」页），所以 LoRA 注入要按全部命中的规则并集来算，
    而不是只取第一条。预设则取第一条带 preset 的规则。
    """
    text = (positive_text or "").lower()
    return [r for r in PAGE_RULES
            if any(_trigger_hit(t, text) for t in r.get("when_triggers", []))]


def resolve_preset(positive_text: str, base_preset_id, current_preset_id=None):
    """决定本页用哪个采样预设。**引擎与 dry-run 共用这一份**，不允许各写一遍。

    返回 (preset_id, 来源, 命中的页规则列表)：
      · "rule"    命中带 preset 的页规则（如镫袜页 → anima-native-30）
      · "base"    无命中，回落到基线预设
      · "inherit" 既无命中也没基线，只能沿用上一页 —— **配置错误信号**

    历史教训：这里曾把回退分支写成 `elif base_preset_id and rules:`，于是无命中页
    不重置预设、沿用上一页，镫袜页之后的 80/100 页全部被 native-30 污染。
    别把回退分支改回带条件的写法。
    """
    rules = matched_page_rules(positive_text)
    pre = next((r for r in rules if r.get("preset")), None)
    if pre:
        return pre["preset"], "rule", rules
    if base_preset_id:
        return base_preset_id, "base", rules
    return current_preset_id, "inherit", rules


def foot_play_hits(positive_text: str) -> list:
    """本页命中的**踩脚玩法**关键词（硬门槛用）。"""
    kws  = FOOT_PLAY_KEYWORDS or set(DEFAULT_FOOT_PLAY_KEYWORDS)
    text = (positive_text or "").lower()
    return sorted({k for k in kws if _trigger_hit(k, text)})


def foot_frame_hits(positive_text: str) -> list:
    """本页命中的**足部取景/摆姿**关键词（只提醒，不当门禁）。"""
    kws  = FOOT_FRAME_KEYWORDS or set(DEFAULT_FOOT_FRAME_KEYWORDS)
    text = (positive_text or "").lower()
    return sorted({k for k in kws if _trigger_hit(k, text)})


def check_foot_preset(positive_text: str, preset_id, sampling_mode=None) -> list:
    """采样验证闸：踩脚页跑「双彩」就返回告警。返回命中的手法关键词（空 = 合规）。

    判「双彩」的权威依据是预设自己的 sampling_mode == "double"，而不是猜名字；
    另外允许 TOML 用 [validation].double_presets 显式补点名。
    """
    hits = foot_play_hits(positive_text)
    if not hits:
        return []
    if preset_id and preset_id in FOOT_ALLOW_PRESETS:
        return []
    if preset_id and preset_id in DOUBLE_PRESETS:
        return hits
    mode = SAMPLING_MODE if sampling_mode is None else sampling_mode
    return hits if mode == "double" else []


def _rule_lora_basenames() -> set:
    out = set()
    for rule in PAGE_RULES:
        for _s, _n, p, _m, _c in rule.get("loras", []):
            out.add(Path(p).name.lower())
    return out


def _family_keywords() -> tuple:
    out = []
    for rule in PAGE_RULES:
        out.extend(rule.get("exclude_family", []))
    return tuple(out)


def _load_action_rules():
    """读取 Studio 的 LoRA 规则库（只取指定类别，剔除页规则内的与排除项）。"""
    try:
        rules = json.loads(LORA_RULES_FILE.read_text(encoding="utf-8"))
    except Exception as e:
        print(f"   ⚠️  读不到 {LORA_RULES_FILE.name}，跳过动作 LoRA 自动补挂（{e}）")
        return []
    bundle_paths = _rule_lora_basenames()
    family       = _family_keywords()
    out = []
    for r in rules:
        if r.get("category") not in AUTO_LORA_CATEGORIES:
            continue
        if not r.get("path"):
            continue
        base = Path(r["path"]).name.lower()
        if base in bundle_paths:                       # 已由页规则注入，跳过
            continue
        if family and any(k in base for k in family):  # 同族其余一律不放
            continue
        hay = f"{r.get('name','')} {r['path']}".lower()
        if any(k in hay for k in AUTO_EXCLUDE_KEYWORDS):
            continue
        out.append(r)
    return out


def auto_action_loras(positive_text: str, existing_paths: set):
    """按本页文本补挂动作 LoRA：先走逐页规则，其余走规则库匹配。"""
    if not AUTO_ACTION_LORAS:
        return []
    text = positive_text.lower()
    extra = []

    # 1) 逐页规则：所有命中的规则按顺序整组注入（一页可命中多条）
    rules = matched_page_rules(positive_text)
    skip_auto = False
    for rule in rules:
        for _sw, _nm, path, mw, cw in rule.get("loras", []):
            if path.lower() in existing_paths:
                continue
            extra.append(("On", _nm, path, float(mw), float(cw)))
            existing_paths.add(path.lower())
        if rule.get("bundle_only", False):
            skip_auto = True   # 该页只挂基线+命中的页规则，不再叠规则库
    if skip_auto:
        return extra

    # 2) 其余动作/修复类规则照旧按触发词匹配
    for r in _load_action_rules():
        path = r["path"]
        if path.lower() in existing_paths:
            continue
        if any(_trigger_hit(t, text) for t in r.get("triggers", [])):
            extra.append((
                "On",
                r.get("name") or Path(path).stem,
                path,
                float(r.get("model_weight", 1.0)),
                float(r.get("clip_weight", 1.0)),
            ))
            existing_paths.add(path.lower())
    return extra

# ─── Studio 预设装载 ──────────────────────────────────────────

_PRESET_CACHE = None      # (presets, src) —— 进程内只取一次


def _fetch_presets():
    """返回 (presets, 来源说明)。优先运行中的 Studio，其次本地文件。

    结果在进程内缓存：跑批时每页都会 apply_preset，若不缓存就是每页一次 HTTP，
    100 页 = 100 次请求，且任何一次超时都会悄悄退回本地文件。
    """
    global _PRESET_CACHE
    if _PRESET_CACHE is not None:
        return _PRESET_CACHE
    try:
        with urllib.request.urlopen(STUDIO_PRESETS_API, timeout=10) as r:
            _PRESET_CACHE = (json.loads(r.read().decode("utf-8")), "Studio 实时接口")
    except Exception as e:
        if not PRESETS_FILE.is_file():
            raise SystemExit(f"❌ 取不到 Studio 预设（{e}），本地也没有 {PRESETS_FILE}")
        _PRESET_CACHE = (json.loads(PRESETS_FILE.read_text(encoding="utf-8")),
                         f"本地回退文件（{e}）")
    print(f"   预设来源：{_PRESET_CACHE[1]}")     # 只在真正取一次时打印
    return _PRESET_CACHE


def load_preset(preset_id: str) -> dict:
    """按 id 或名称读取预设：优先运行中的 Studio，其次本地 data/gen_presets.json。"""
    presets, src = _fetch_presets()
    for p in presets:
        if p.get("id") == preset_id or p.get("name") == preset_id:
            return p
    ids = " | ".join(p.get("id", "?") for p in presets)
    raise SystemExit(f"❌ 未找到预设 '{preset_id}'（来源：{src}）。可用：{ids}")


def preset_turbo_enabled(preset: dict) -> bool:
    """预设的 LoRA 列表里含 turbo 则开启 Turbo，否则关闭（原生全扩散）。"""
    return any("turbo" in (l.get("path") or "").lower()
               for l in preset.get("loras", []) if l.get("active", True))


def _apply_sampling_overrides():
    """架构强制 + TOML [sampling] 覆盖。

    apply_preset() 与 main()（作品没写 preset 时）都要调它，
    否则「不写 preset」的配置会拿不到 [sampling] 里的采样参数。
    """
    global STEPS, CFG, SAMPLER, SCHEDULER, TURBO_ENABLED, SAMPLING_MODE, DENOISE, SEED

    # Illustrious 线：anima 的 FLS 双层采样与 anima-turbo 都不适用
    if ARCH == "illus":
        SAMPLING_MODE = "single"
        TURBO_ENABLED = False

    # 覆盖优先级高于预设；写在 apply_preset 内部，所以逐页都成立
    if SAMPLING_OVERRIDE:
        STEPS         = int(SAMPLING_OVERRIDE.get("steps", STEPS))
        CFG           = float(SAMPLING_OVERRIDE.get("cfg", CFG))
        SAMPLER       = SAMPLING_OVERRIDE.get("sampler", SAMPLER)
        SCHEDULER     = SAMPLING_OVERRIDE.get("scheduler", SCHEDULER)
        SAMPLING_MODE = SAMPLING_OVERRIDE.get("mode", SAMPLING_MODE)
        DENOISE       = float(SAMPLING_OVERRIDE.get("denoise", DENOISE))
        if "turbo" in SAMPLING_OVERRIDE:
            TURBO_ENABLED = bool(SAMPLING_OVERRIDE["turbo"])
        if "seed" in SAMPLING_OVERRIDE:
            SEED = int(SAMPLING_OVERRIDE["seed"])
            SEED_FIXED = True


def apply_preset(preset_id: str, quiet: bool = False) -> dict:
    """把 Studio 预设写进模块级采样参数。供 main() 与各预览脚本共用。"""
    global STEPS, CFG, SAMPLER, SCHEDULER, TURBO_ENABLED, SAMPLING_MODE, STAGE1, DENOISE

    preset = load_preset(preset_id)
    mode = preset.get("sampling_mode", "single")
    SAMPLING_MODE = mode
    if mode == "double":
        s1 = preset.get("sampler_stage1") or {}
        STAGE1 = {
            "steps":        int(s1.get("steps", 5)),
            "cfg":          float(s1.get("cfg", 4.6)),
            "sampler_name": s1.get("sampler_name", "er_sde"),
            "scheduler":    s1.get("scheduler", "simple"),
            "denoise":      float(s1.get("denoise", 1.0)),
        }
        s = preset.get("sampler_stage2") or {}
    else:
        s = preset.get("sampler_settings") or {}

    STEPS         = int(s.get("steps", STEPS))
    CFG           = float(s.get("cfg", CFG))
    SAMPLER       = s.get("sampler_name", SAMPLER)
    SCHEDULER     = s.get("scheduler", SCHEDULER)
    # < 1.0 才会从上游潜空间继续精修。single 模式从空潜空间起步，应保持 1.0。
    # double 模式缺字段时的回退必须 < 1.0（同服务端 STAGE2_DENOISE_DEFAULT，
    # tools/test_stage_preset_gate.py 会钉住这四处一致）。
    DENOISE       = float(s.get("denoise", 1.0 if mode != "double" else 0.7))
    TURBO_ENABLED = preset_turbo_enabled(preset)

    _apply_sampling_overrides()

    if not quiet:
        print(f"📌 应用 Studio 预设：{preset.get('name')}  [{preset.get('id')}]  mode={SAMPLING_MODE}")
        if SAMPLING_MODE == "double":
            print(f"   Stage1(底模): {STAGE1['steps']}步 CFG{STAGE1['cfg']} "
                  f"{STAGE1['sampler_name']}/{STAGE1['scheduler']}")
            print(f"   Stage2(LoRA): {STEPS}步 CFG{CFG} {SAMPLER}/{SCHEDULER} denoise={DENOISE}")
        else:
            print(f"   单采样: {STEPS}步 CFG{CFG} {SAMPLER}/{SCHEDULER} denoise={DENOISE}")
        print(f"   Turbo={'On' if TURBO_ENABLED else 'Off'}")
    return preset


# ─── 工具函数 ─────────────────────────────────────────────────

def resolve_page_canvas(stem: str) -> dict:
    """根据分镜页名称匹配 PAGE_CANVAS，返回 dict(width=..., height=..., end_percent=...) 或 {}。"""
    if not PAGE_CANVAS:
        return {}
    code = stem.split("—")[0].strip()
    parts = code.split("-")
    sub_codes = {code, code.upper(), code.lower()}
    for p in parts:
        p_clean = p.strip()
        if p_clean:
            sub_codes.add(p_clean)
            sub_codes.add(p_clean.upper())
            sub_codes.add(p_clean.lower())
            if p_clean.isdigit():
                sub_codes.add(f"{int(p_clean):03d}")
                sub_codes.add(str(int(p_clean)))

    for entry in PAGE_CANVAS:
        target = str(entry.get("page", "")).strip()
        if target in sub_codes or target.upper() in sub_codes:
            return entry
    return {}

def parse_txt(path: Path):
    """解析 [tags] / [caption] 分镜文件，返回正向提示词文本。"""
    raw = path.read_text(encoding="utf-8", errors="ignore")
    tags_m    = re.search(r"\[tags\]\s*(.*?)(?=\[caption\]|$)",    raw, re.DOTALL | re.IGNORECASE)
    caption_m = re.search(r"\[caption\]\s*(.*?)(?=\[/caption\]|$)", raw, re.DOTALL | re.IGNORECASE)
    tags    = tags_m.group(1).strip()    if tags_m    else ""
    caption = caption_m.group(1).strip() if caption_m else ""
    tags    = re.sub(r"^\[tags\]\s*", "", tags,    flags=re.IGNORECASE).strip()
    caption = re.sub(r"\[/?caption\]", "", caption, flags=re.IGNORECASE).strip()
    body    = f"{tags}\n\n{caption}".strip() if (tags and caption) else (tags or caption)
    for _from, _to in PROMPT_REPLACE:
        body = body.replace(_from, _to)
    if NL_APPEND:
        body = f"{body}\n\n{NL_APPEND}".strip() if body else NL_APPEND
    return f"{QUALITY_PREFIX}\n\n{body}".strip()

def next_seed(stem: str) -> int:
    """本页要用的种子。

    random（默认）：每页抽新随机种子（= ComfyUI 原生 randomize 的语义）
    hash         ：由页名派生，同页永远同种子（改配置后重跑能干净对比）
    fixed        ：全批用 SEED
    另：--seed N / [sampling] seed 会置 SEED_FIXED，优先于一切。
    """
    if SEED_FIXED or SEED_MODE == "fixed":
        return SEED
    if SEED_MODE == "hash":
        return (SEED + zlib.crc32(stem.encode("utf-8"))) % (2 ** 63 - 1)
    return random.SystemRandom().randint(1, 2 ** 63 - 1)


def page_seed(stem: str) -> int:
    """派生式种子（等价于 SEED_MODE=\"hash\"），供预览脚本复用。"""
    return (SEED + zlib.crc32(stem.encode("utf-8"))) % (2 ** 63 - 1)


def build_workflow(positive_text: str, filename_prefix: str,
                   width: int = None, height: int = None,
                   end_percent: float = None) -> dict:
    """构造纯净 API 格式工作流。按 ARCH 分流 anima / illus / anima-incontext 三种图结构。"""
    prompt = {}

    w = int(width if width is not None else WIDTH)
    h = int(height if height is not None else HEIGHT)

    # --- 模型装载：三条线完全不同 ---
    if ARCH == "illus":
        # Illustrious/SDXL：checkpoint 自带 CLIP 与 VAE
        prompt["1"] = {"class_type": "CheckpointLoaderSimple",
                       "inputs": {"ckpt_name": CKPT_NAME}}
        base_model_ref, clip_ref, vae_ref = ["1", 0], ["1", 1], ["1", 2]
    elif ARCH == "anima-incontext":
        # Anima in-context 机制（proven graph）：标准 UNETLoader + CLIPLoader + VAELoader
        prompt["1"] = {"class_type": "UNETLoader", "inputs": {
            "unet_name": UNET_NAME, "weight_dtype": "default"
        }}
        prompt["4"] = {"class_type": "CLIPLoader", "inputs": {
            "clip_name": "qwen_3_06b_base.safetensors", "type": "stable_diffusion", "device": "cpu"
        }}
        prompt["5"] = {"class_type": "VAELoader", "inputs": {
            "vae_name": "qwen_image_vae.safetensors"
        }}
        base_model_ref, clip_ref, vae_ref = ["1", 0], ["4", 0], ["5", 0]
    else:
        prompt["1"] = {"class_type": "OTUNetLoaderW8A8", "inputs": {
            "unet_name": UNET_NAME, "weight_dtype": "default",
            "model_type": "anima", "on_the_fly_quantization": False,
            "enable_convrot": True, "lora_mode": "None"
        }}
        prompt["2"] = {"class_type": "CLIPLoader", "inputs": {
            "clip_name": "qwen_3_06b_base.safetensors",
            "type": "stable_diffusion", "device": "cpu"
        }}
        prompt["3"] = {"class_type": "VAELoader",  "inputs": {"vae_name": "qwen_image_vae.safetensors"}}
        base_model_ref, clip_ref, vae_ref = ["1", 0], ["2", 0], ["3", 0]

    # --- 空潜空间 ---
    latent_nid = "30" if ARCH == "anima-incontext" else "4"
    prompt[latent_nid] = {"class_type": "EmptyLatentImage",
                          "inputs": {"width": w, "height": h, "batch_size": 1}}

    # --- LoRA ---
    # 基线 LoRA + 本页按文本匹配到的动作 LoRA（镫袜/子宫口/降龄/发交…）
    base_paths = {l[2].lower() for l in LORAS}
    page_loras = [(sw, nm, path, mw, cw) for (sw, nm, path, mw, cw)
                  in list(LORAS) + auto_action_loras(positive_text, base_paths)
                  if sw == "On" and not (not TURBO_ENABLED and nm == TURBO_LORA_NAME)]

    model_ref = base_model_ref
    if ARCH == "illus":
        # LoraLoader 链 —— Illustrious 线实际在用的写法（见 Outputs/光辉_沙足测试 的图）
        for _i, (_sw, _nm, path, mw, cw) in enumerate(page_loras, 1):
            nid = str(100 + _i)
            prompt[nid] = {"class_type": "LoraLoader", "inputs": {
                "model": model_ref, "clip": clip_ref,
                "lora_name": path.replace("/", "\\"),
                "strength_model": float(mw), "strength_clip": float(cw),
            }}
            model_ref, clip_ref = [nid, 0], [nid, 1]
    elif ARCH == "anima-incontext":
        # LoraLoaderModelOnly 链 —— in-context 实测跑通的组合（单通道只叠 model，不碰 clip）
        for _i, (_sw, _nm, path, mw, _cw) in enumerate(page_loras, 1):
            nid = str(100 + _i)
            prompt[nid] = {"class_type": "LoraLoaderModelOnly", "inputs": {
                "model": model_ref,
                "lora_name": path.replace("/", "\\"),
                "strength_model": float(mw)
            }}
            model_ref = [nid, 0]
    else:
        # CR LoRA Stack（最多 3 个槽 per 节点，自动扩展）
        chunks = [page_loras[i:i+3] for i in range(0, max(len(page_loras), 1), 3)]
        if not chunks:
            chunks = [[]]
        last_stack_id = None
        for s_idx, chunk in enumerate(chunks):
            sid = str(10 + s_idx)
            inp = {}
            if last_stack_id is not None:
                inp["lora_stack"] = [last_stack_id, 0]
            for slot in range(1, 4):
                if slot - 1 < len(chunk):
                    sw, nm, path, mw, cw = chunk[slot-1]
                    inp[f"switch_{slot}"]       = sw
                    inp[f"lora_name_{slot}"]    = path.replace("/", "\\")
                    inp[f"model_weight_{slot}"] = float(mw)
                    inp[f"clip_weight_{slot}"]  = float(cw)
                else:
                    inp[f"switch_{slot}"]       = "Off"
                    inp[f"lora_name_{slot}"]    = "None"
                    inp[f"model_weight_{slot}"] = 1.0
                    inp[f"clip_weight_{slot}"]  = 1.0
            prompt[sid] = {"class_type": "CR LoRA Stack", "inputs": inp}
            last_stack_id = sid

        prompt["20"] = {"class_type": "CR Apply LoRA Stack", "inputs": {
            "model":      base_model_ref,
            "clip":       clip_ref,
            "lora_stack": [last_stack_id, 0]
        }}
        model_ref, clip_ref = ["20", 0], ["20", 1]

    # --- 提示词编码与采样 ---
    if ARCH == "anima-incontext":
        prompt["20"] = {"class_type": "CLIPTextEncode", "inputs": {"clip": clip_ref, "text": positive_text}}
        prompt["21"] = {"class_type": "CLIPTextEncode", "inputs": {"clip": clip_ref, "text": NEGATIVE}}

        # 参考图支路
        refs = INCONTEXT.get("refs", [])
        lat_nodes = []
        for i, ref in enumerate(refs):
            load_nid = str(10 + i)
            enc_nid  = str(12 + i)
            prompt[load_nid] = {"class_type": "LoadImage", "inputs": {"image": ref["image"]}}
            prompt[enc_nid]  = {"class_type": "AnimaRefEncode", "inputs": {
                "vae": vae_ref, "image": [load_nid, 0],
                "target_width": w, "target_height": h
            }}
            lat_nodes.append(enc_nid)

        if len(lat_nodes) == 1:
            ref_latent_ref = [lat_nodes[0], 0]
        elif len(lat_nodes) >= 2:
            batch_fit = INCONTEXT.get("fit_mode", "pad")
            prompt["14"] = {
                "class_type": "AnimaRefLatentBatch",
                "inputs": {"ref_latent_1": [lat_nodes[0], 0],
                           "ref_latent_2": [lat_nodes[1], 0],
                           "fit_mode": batch_fit}
            }
            cur_batch_ref = ["14", 0]
            for extra_i, lat_id in enumerate(lat_nodes[2:], start=1):
                b_nid = f"14_{extra_i}"
                prompt[b_nid] = {
                    "class_type": "AnimaRefLatentBatch",
                    "inputs": {"ref_latent_1": cur_batch_ref,
                               "ref_latent_2": [lat_id, 0],
                               "fit_mode": batch_fit}
                }
                cur_batch_ref = [b_nid, 0]
            ref_latent_ref = cur_batch_ref
        else:
            ref_latent_ref = None

        if ref_latent_ref is not None:
            ep = float(end_percent if end_percent is not None else INCONTEXT.get("end_percent", 0.90))
            prompt["15"] = {
                "class_type": "AnimaInContextApply",
                "inputs": {
                    "model": model_ref,
                    "ref_latent": ref_latent_ref,
                    "strength": float(INCONTEXT.get("strength", 1.0)),
                    "start_percent": float(INCONTEXT.get("start_percent", 0.0)),
                    "end_percent": ep,
                    "cond_only": bool(INCONTEXT.get("cond_only", True)),
                    "fit_mode": str(INCONTEXT.get("fit_mode", "pad")),
                    "ref_timestep": float(INCONTEXT.get("ref_timestep", 0.0))
                }
            }
            sampler_model = ["15", 0]
        else:
            sampler_model = model_ref

        prompt["40"] = {"class_type": "KSampler", "inputs": {
            "model": sampler_model, "positive": ["20", 0], "negative": ["21", 0],
            "latent_image": [latent_nid, 0],
            "seed": SEED, "steps": int(STEPS), "cfg": float(CFG),
            "sampler_name": SAMPLER, "scheduler": SCHEDULER, "denoise": float(DENOISE)
        }}
        last_latent = ["40", 0]
    else:
        prompt["30"] = {"class_type": "CLIPTextEncode", "inputs": {"text": positive_text, "clip": clip_ref}}
        prompt["31"] = {"class_type": "CLIPTextEncode", "inputs": {"text": NEGATIVE,      "clip": clip_ref}}
        if ARCH == "illus":
            # Illustrious 线：单 KSampler（与 Outputs/光辉_沙足测试 的实际图一致）
            prompt["40"] = {"class_type": "KSampler", "inputs": {
                "model": model_ref, "positive": ["30", 0], "negative": ["31", 0],
                "latent_image": ["4", 0],
                "seed": SEED, "steps": int(STEPS), "cfg": float(CFG),
                "sampler_name": SAMPLER, "scheduler": SCHEDULER, "denoise": 1.0
            }}
            last_latent = ["40", 0]
        else:
            def _sampler(model_ref_, latent_ref, steps, cfg, sampler, scheduler, denoise=1.0):
                return {"class_type": "FLS_SamplerV4", "inputs": {
                    "model": model_ref_, "positive": ["30", 0], "negative": ["31", 0],
                    "latent_image": latent_ref,
                    "seed": SEED, "steps": int(steps), "cfg": float(cfg),
                    "sampler_name": sampler, "scheduler": scheduler, "denoise": float(denoise),
                    "fovea_strength": 3.0, "sharpness": 0.5, "mask_inertia": 0.85
                }}

            if SAMPLING_MODE == "double":
                # Stage 1：底模裸跑（不带 LoRA）粗采定骨架（从空潜空间起步 → denoise 保持 1.0）
                prompt["40"] = _sampler(base_model_ref, ["4", 0],
                                        STAGE1["steps"], STAGE1["cfg"],
                                        STAGE1["sampler_name"], STAGE1["scheduler"],
                                        STAGE1.get("denoise", 1.0))
                # Stage 2：套 LoRA 精修，latent 接 Stage 1 输出。
                # denoise 必须 < 1.0；=1.0 时结果与直接跳过 Stage 1 完全相同（Stage 1 白跑）。
                prompt["41"] = _sampler(model_ref, ["40", 0], STEPS, CFG, SAMPLER, SCHEDULER, DENOISE)
                last_latent = ["41", 0]
            else:
                prompt["40"] = _sampler(model_ref, ["4", 0], STEPS, CFG, SAMPLER, SCHEDULER, DENOISE)
                last_latent = ["40", 0]

    prompt["50"] = {"class_type": "VAEDecode",  "inputs": {"samples": last_latent, "vae": vae_ref}}
    prompt["60"] = {
        "class_type": "LayerUtility: SaveImagePlus",
        "inputs": {
            "images": ["50", 0],
            "custom_path": "",
            "filename_prefix": filename_prefix,
            "timestamp": "None",
            "format": "png",
            "quality": 100,
            "meta_data": True,
            "blind_watermark": "",
            "save_workflow_as_json": True,
            "preview": True
        }
    }
    return prompt

def free_vram(quiet: bool = False, why: str = "") -> bool:
    """投递**第一页之前**清一次显存，并等到它真的落地。

    真正的请求体 / 开关 / 超时都在 tools/vram.py，因为好几个脚本都要用。
    这里只负责把模块级开关 FREE_VRAM_BEFORE_PAGE（可由作品 TOML 的
    [runtime] free_vram 覆盖）和 FREE_VRAM 环境变量拼进去。

    清理失败**不**中断整批：清显存是个优化，不能因为它让几十页白跑。
    """
    if _vram is None:
        return False
    return _vram.free_vram(host=COMFY_HOST, quiet=quiet, why=why,
                           enabled=_vram.resolve(default=FREE_VRAM_BEFORE_PAGE),
                           timeout=FREE_VRAM_TIMEOUT)


def mark_free_vram(quiet: bool = True) -> bool:
    """投递完一页立刻调：只留标记不等待。

    ComfyUI 的 /free 是在「两次任务之间的空档」被消费的（不是立即执行）。
    在**下一页渲染期间**留着标记，这一页一结束主循环就读走并卸载+清缓存，
    于是下一页天生从干净显存开始，且 steady-state 不花额外时间。
    """
    if _vram is None:
        return False
    if not _vram.resolve(default=FREE_VRAM_BEFORE_PAGE):
        return False
    if quiet:
        return _vram.mark_free(host=COMFY_HOST, timeout=FREE_VRAM_TIMEOUT)
    return _vram.free_vram(host=COMFY_HOST, quiet=False, why="为下一页预清",
                          enabled=True, settle=False)


def queue_prompt(prompt_workflow: dict, front: bool = False) -> str:
    """投递工作流。front=True 时插到 ComfyUI 队列**队首**。

    ComfyUI 的 post_prompt 看到 front=true 会把序号取负，heapq 里负号排最前，
    所以该任务会在当前正在执行的节点跑完后**立刻**执行，插在已在队的所有任务前面。
    这是唯一能对「已在运行的批次进程」生效的插队方式（不必重启它）。
    """
    body = {
        "prompt": prompt_workflow,
        "client_id": CLIENT_ID,
        "extra_data": {
            "extra_pnginfo": {
                "workflow": prompt_workflow
            }
        }
    }
    if front:
        body["front"] = True
    data = json.dumps(body).encode()
    req  = urllib.request.Request(
        f"http://{COMFY_HOST}/prompt", data=data,
        headers={"Content-Type": "application/json"}
    )
    res  = urllib.request.urlopen(req)
    pid  = json.loads(res.read())["prompt_id"]
    # 提交成功就顺手挂上清理标记 —— 放在这里而不是各个调用方，是为了让
    # run_insert / run_*_artists / run_recognition_test 这些共用本函数（或共享
    # rtb 模块）的脚本全都白得这个行为，不会漏。
    # 详见 tools/vram.py：/free 不在此时执行，而是在本次任务渲染完之后的空档
    # 被主循环消费 —— 所以下一页从干净显存开始，steady-state 不花额外时间。
    mark_free_vram()
    return pid


def fetch_images(images: list, dest_root) -> list:
    """把 ComfyUI 端的成品图回传到 Mac，按 subfolder 结构镜像。返回落地路径列表。

    用 ComfyUI 自己的 /view 端点取图（走同一条隧道），不依赖 Windows 的共享目录。
    """
    dest_root = Path(dest_root)
    saved = []
    for img in images or []:
        try:
            qs = urllib.parse.urlencode({
                "filename":  img.get("filename", ""),
                "subfolder": img.get("subfolder", ""),
                "type":      img.get("type", "output"),
            })
            with urllib.request.urlopen(f"http://{COMFY_HOST}/view?{qs}", timeout=120) as r:
                blob = r.read()
            if not blob.startswith(b"\x89PNG"):
                raise ValueError("返回的不是 PNG")
            sub = (img.get("subfolder") or "").replace("\\", "/").strip("/")
            # 防重嵌套：mac_dir 若已经以该 subfolder 末尾命名结尾，就不再嵌一层
            out_dir = dest_root
            if sub and dest_root.name != sub.split("/")[-1]:
                out_dir = dest_root / sub
            out_dir.mkdir(parents=True, exist_ok=True)
            out_path = out_dir / img["filename"]
            tmp = out_path.with_suffix(out_path.suffix + ".part")
            tmp.write_bytes(blob)
            tmp.replace(out_path)          # 原子替换，避免半截文件
            saved.append(out_path)

            # 同步拉取 LayerUtility: SaveImagePlus 产生的配套工作流 json
            try:
                json_filename = Path(img["filename"]).with_suffix(".json").name
                json_qs = urllib.parse.urlencode({
                    "filename":  json_filename,
                    "subfolder": img.get("subfolder", ""),
                    "type":      img.get("type", "output"),
                })
                with urllib.request.urlopen(f"http://{COMFY_HOST}/view?{json_qs}", timeout=15) as jr:
                    json_blob = jr.read()
                if json_blob.startswith(b"{"):
                    (out_dir / json_filename).write_bytes(json_blob)
            except Exception:
                pass
        except Exception as e:
            print(f"      ⚠️  回传失败 {img.get('filename')}: {e}")
    return saved

def wait_done(prompt_id: str, timeout: int = 300) -> list:
    start      = time.time()
    last_print = 0
    while time.time() - start < timeout:
        try:
            req  = urllib.request.urlopen(f"http://{COMFY_HOST}/history/{prompt_id}")
            data = json.loads(req.read())
            if prompt_id in data:
                imgs = []
                for node_out in data[prompt_id].get("outputs", {}).values():
                    imgs.extend(node_out.get("images", []))
                return imgs
        except Exception:
            pass
        elapsed = int(time.time() - start)
        if elapsed - last_print >= 5:
            print(f"      ⏳ {elapsed}s…", flush=True)
            last_print = elapsed
        time.sleep(1)
    return []

# ─── 主流程 ───────────────────────────────────────────────────

def main():
    # 用法：python run_typhon_batch.py [start_index] [--preset <id|name>] [--tag <后缀>]
    #        [--only RF003,RF004]   ← 只跑指定页（页前缀码，逗号分隔）
    # start_index 从 1 开始计数（即第几个文件）
    global STEPS, CFG, SAMPLER, SCHEDULER, TURBO_ENABLED, SAMPLING_MODE, STAGE1
    global SEED, SEED_FIXED

    start_from = 1
    preset_id  = None
    tag        = ""
    only       = None

    argv = sys.argv[1:]
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--preset" and i + 1 < len(argv):
            preset_id = argv[i + 1]; i += 2; continue
        if a == "--tag" and i + 1 < len(argv):
            tag = argv[i + 1]; i += 2; continue
        if a == "--only" and i + 1 < len(argv):
            only = [x.strip().upper() for x in argv[i + 1].split(",") if x.strip()]
            i += 2; continue
        if a == "--seed" and i + 1 < len(argv):
            SEED = int(argv[i + 1]); SEED_FIXED = True; i += 2; continue
        if a == "--seed-mode" and i + 1 < len(argv):
            SEED_MODE = argv[i + 1].strip().lower(); SEED_FIXED = False; i += 2; continue
        if a.lstrip("-").isdigit():
            start_from = int(a.lstrip("-")); i += 1; continue
        print(f"⚠️  忽略未知参数：{a}")
        i += 1

    base_preset_id = preset_id
    if preset_id:
        apply_preset(preset_id)
    else:
        # 作品没写 [base] preset（illus 线常见）也要让 [sampling] 生效
        _apply_sampling_overrides()
        print(f"📌 无预设，用 TOML [sampling]：{STEPS}步 CFG{CFG} {SAMPLER}/{SCHEDULER} "
              f"mode={SAMPLING_MODE} Turbo={'On' if TURBO_ENABLED else 'Off'}")

    out_subdir = f"{OUTPUT_SUBDIR}{tag}"

    pages = sorted(PAGES_DIR.glob(PAGE_GLOB))
    total = len(pages)

    # 批次开跑前先清一次并**等它落地**：第一页没有「上一页渲染期间」可用来挂标记，
    # 所以这次必须跨过一个空闲轮询周期（~10s）。之后每页只靠 mark_free_vram()。
    if pages and FREE_VRAM_BEFORE_PAGE:
        free_vram(why=f"批次开跑前（共 {total} 页）")
    if only:
        want = set(only)
        def _match_only(p):
            stem = p.stem
            s_up = stem.upper()
            code = stem.split("—")[0].upper()
            if code in want or s_up in want:
                return True
            for part in stem.split("-"):
                if part.strip().upper() in want:
                    return True
            return False
        pages = [p for p in pages if _match_only(p)]
        start_from = 1
    else:
        pages = pages[start_from - 1:]   # 跳过已完成部分

    print(f"\n🎬 批量运行：从第 {start_from} 张开始，共 {total} 个，本次跑 {len(pages)} 张")
    print(f"   底模：{UNET_NAME}")
    print(f"   采样：{STEPS}步  CFG {CFG}  {SAMPLER} / {SCHEDULER}   Turbo={TURBO_ENABLED}")
    print(f"   LoRA：{'  /  '.join(l[1] for l in LORAS)}")
    print(f"   输出：{out_subdir}/")
    print("=" * 60)

    results = []
    gate_skips = []
    last_preset = base_preset_id          # 供 resolve_preset 的 inherit 分支用
    for idx, page in enumerate(pages, 1):
        stem   = page.stem   # e.g. "TP004—a01提丰-足心软肉"
        prefix = f"{out_subdir}/{stem}"
        # 每页一个种子（默认随机）—— 详见文件顶部 SEED_MODE 注释。
        # 种子打印出来且写进图元数据，要复现某一页就用 --seed <那个值>。
        SEED = next_seed(stem)
        print(f"\n[{idx:02d}/{len(pages)}] {stem}   (seed={SEED})")

        try:
            positive = parse_txt(page)
            # 逐页选预设 —— 逻辑在 resolve_preset()，**与 dry-run 共用同一份**，
            # 避免两边各写一遍然后各自漂移（这正是历史上 80/100 页跑错的原因）。
            preset_id, psrc, rules = resolve_preset(positive, base_preset_id, last_preset)
            if preset_id:
                last_preset = preset_id
                apply_preset(preset_id, quiet=True)
            if psrc == "rule":
                names = " + ".join(r.get("name", "") for r in rules)
                print(f"      ⚙️  [{names}] → {preset_id} "
                      f"({STEPS}步 CFG{CFG} {SAMPLER}/{SCHEDULER} Turbo={TURBO_ENABLED})")
            elif psrc == "inherit":
                print(f"      ⚠️  预设沿用上一页（{preset_id}）—— 既没命中规则也没基线，请查配置")

            # ── 采样验证闸：踩脚页禁止双彩 ────────────────────────
            foot_hits = check_foot_preset(positive, preset_id)
            if foot_hits:
                print("      " + "━" * 60)
                print("      ⛔ 采样告警：踩脚页跑到了双层采样（双彩）预设！")
                print(f"         预设：{preset_id}   mode={SAMPLING_MODE}"
                      f"   {STEPS}步 CFG{CFG} {SAMPLER}/{SCHEDULER}")
                print(f"         命中踩脚关键词：{', '.join(foot_hits[:8])}"
                      f"{' …' if len(foot_hits) > 8 else ''}")
                print("         镫袜/踩脚 LoRA 在少步数下吃不满必烂 —— 应该走全扩散")
                print("         修法：给该页的 [[page_rule]] 加 preset = \"anima-native-30\"")
                print("         或把触发词补进 when_triggers，然后在 [validation] 里")
                print("         foot_allow_presets 放行 native 类预设。")
                if FOOT_GATE_MODE == "block":
                    print(f"         已拦下本页（未出图）：{stem}")
                    print("      " + "━" * 60)
                    results.append({"page": stem, "ok": False, "gate": True,
                                    "file": f"采样告警：踩脚页跑双彩（{preset_id}）"})
                    gate_skips.append(f"{stem}  ← {preset_id}")
                    continue
                print("         [validation].foot_gate_mode = \"warn\" —— 本次仍然出图")
                print("      " + "━" * 60)
            else:
                # 只命中取景/摆姿词的页面：提一句就行，不当门禁
                frame_hits = foot_frame_hits(positive)
                if frame_hits and SAMPLING_MODE == "double":
                    print(f"      ℹ️  足部取景页（{'/'.join(frame_hits[:3])}）走双彩"
                          f" —— 若脚部结构崩坏，可考虑改 native-30")

            # ── 逐页画布与 end_percent 覆盖 ────────────────────────
            page_w, page_h = WIDTH, HEIGHT
            page_ep = INCONTEXT.get("end_percent", 0.90) if INCONTEXT else None
            canvas = resolve_page_canvas(page.stem)
            if canvas:
                if canvas.get("width"):
                    page_w = canvas["width"]
                if canvas.get("height"):
                    page_h = canvas["height"]
                if canvas.get("end_percent") is not None:
                    page_ep = canvas["end_percent"]
                print(f"      📐 画布覆盖：{page_w}x{page_h}" +
                      (f" | end_percent={page_ep}" if ARCH == "anima-incontext" else ""))

            workflow = build_workflow(positive, prefix, width=page_w, height=page_h, end_percent=page_ep)
            pid      = queue_prompt(workflow)   # 内部已顺手挂上「下一页前清显存」的标记
            print(f"      → 已投递 prompt_id={pid[:8]}…")
            imgs     = wait_done(pid, timeout=WAIT_TIMEOUT)
            if imgs:
                print(f"      ✅ 完成：{imgs[0]['filename']}")
                if MAC_OUT_DIR:
                    got = fetch_images(imgs, MAC_OUT_DIR)
                    for p in got:
                        print(f"      ⬇️  已回传 Mac：{p}")
                    if len(got) != len(imgs):
                        print(f"      ⚠️  回传 {len(got)}/{len(imgs)} 张，其余仍在 ComfyUI 端")
                results.append({"page": stem, "ok": True,  "file": imgs[0]["filename"]})
            else:
                print(f"      ❌ 超时/失败")
                results.append({"page": stem, "ok": False, "file": None})
        except Exception as e:
            print(f"      ❌ 异常：{e}")
            results.append({"page": stem, "ok": False, "file": str(e)})

        # 连续失败 = 后端未在执行（服务可能在监听但采样线程已死），立即中止而非空等
        # 采样闸跳过的页不算 —— 那是配置问题，不是后端死了。
        consec = 0
        for r in reversed(results):
            if r.get("gate"):
                continue
            if r["ok"]:
                break
            consec += 1
        if consec >= 3:
            nxt = start_from + idx
            me = Path(sys.argv[0]).name or "run_typhon_batch.py"
            print(f"\n🛑 连续 {consec} 张失败，判定后端未执行提示词（HTTP 正常但不再出图）。")
            print("   请检查 ComfyUI 日志后重跑：")
            print(f"   python {me} {nxt} --preset {preset_id or 'anima-single-turbo'}")
            break

    # 汇总
    gate_count = sum(1 for r in results if r.get("gate"))
    ok_count   = sum(1 for r in results if r["ok"])
    fail_count = len(results) - ok_count - gate_count
    print(f"\n{'='*60}")
    print(f"✅ 成功：{ok_count}  ❌ 失败：{fail_count}  ⛔ 采样闸拦截：{gate_count}")
    if gate_count:
        print("\n⛔ 以下页面因踩脚页跑「双彩」被采样闸拦下（未出图）：")
        for g in gate_skips:
            print(f"   GATE  {g}")
        print("   修法：给对应 [[page_rule]] 补 preset = \"anima-native-30\"，")
        print("   或把漏掉的触发词补进 when_triggers。")
    if fail_count:
        for r in results:
            if not r["ok"] and not r.get("gate"):
                print(f"   FAIL  {r['page']}  →  {r['file']}")
    if fail_count or gate_count:
        print("⚠️  本次未跑完，请修复配置后按上面的命令续跑。\n")
    elif ok_count:
        print("🎉 全部完成！\n")
    else:
        print("⚠️  没有任何页面被处理。\n")

if __name__ == "__main__":
    main()
