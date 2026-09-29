"""
作品级批量配置装载器。

从 storyboard 目录旁的 `batch.toml` 读取全部配置，写进引擎模块
(`run_typhon_batch.py`) 的对应全局量 —— 引擎本身不再写死任何作品常量。

路径约定：TOML 里所有相对路径都相对 **TOML 文件所在目录** 解析，
所以整个作品目录搬到哪都能直接用。
"""

import importlib.util
from pathlib import Path

try:
    import tomllib as _toml            # Python 3.11+ 标准库
except ModuleNotFoundError:            # pragma: no cover
    try:
        import tomli as _toml          # pip install tomli（3.9/3.10）
    except ModuleNotFoundError:
        raise SystemExit(
            "❌ 需要 TOML 解析器：请用 Python 3.11+ 运行，"
            "或先 `python3 -m pip install --user tomli`"
        )

HERE = Path(__file__).resolve().parent


def engine():
    """加载共享引擎模块 run_typhon_batch.py。"""
    spec = importlib.util.spec_from_file_location("rtb", HERE / "run_typhon_batch.py")
    rtb = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(rtb)
    return rtb


def _resolve(p: str, base_dir: Path) -> Path:
    q = Path(p).expanduser()
    return q if q.is_absolute() else (base_dir / q).resolve()


def _loras(entries, base_dir: Path):
    """TOML 的 [[...loras]] 数组 → 引擎用的 (switch, name, path, mw, cw) 元组。"""
    out = []
    for e in entries or []:
        path = e["path"]
        out.append((
            "On",
            e.get("name") or Path(path.replace("\\", "/")).stem,
            path,
            float(e.get("model_weight", 1.0)),
            float(e.get("clip_weight", 1.0)),
        ))
    return out


def load_story(toml_path) -> tuple:
    """读取作品配置并写入引擎模块。返回 (rtb, cfg, base_preset)。"""
    toml_path = Path(toml_path).expanduser().resolve()
    if not toml_path.is_file():
        raise SystemExit(f"❌ 找不到配置文件：{toml_path}")
    cfg = _toml.loads(toml_path.read_text(encoding="utf-8"))
    base_dir = toml_path.parent

    rtb = engine()

    # --- paths ---
    paths = cfg.get("paths", {})
    rtb.PAGES_DIR  = _resolve(paths["pages_dir"], base_dir)
    rtb.PAGE_GLOB  = paths.get("page_glob", "*.txt")
    rtb.OUTPUT_SUBDIR = paths.get("output_subdir", "batch")

    # --- prompt ---
    prompt = cfg.get("prompt", {})
    if prompt.get("quality_prefix"):
        rtb.QUALITY_PREFIX = prompt["quality_prefix"]
    if prompt.get("negative"):
        rtb.NEGATIVE = prompt["negative"]
    nl_app = prompt.get("nl_append") or prompt.get("nl_costume_anchor")
    rtb.NL_APPEND = nl_app.strip() if nl_app else ""

    # --- 出图回传 Mac ---
    out = cfg.get("output", {}) or {}
    mac_dir = out.get("mac_dir", "") or ""
    rtb.MAC_OUT_DIR = _resolve(mac_dir, base_dir) if mac_dir.strip() else None
    if out.get("wait_timeout"):
        rtb.WAIT_TIMEOUT = int(out["wait_timeout"])

    # --- base LoRA 栈 + 默认预设 + 底模 / 架构 ---
    base = cfg.get("base", {})
    rtb.LORAS = _loras(base.get("loras", []), base_dir)
    base_preset = base.get("preset")
    if base.get("unet"):
        rtb.UNET_NAME = base["unet"]
    if base.get("arch"):
        rtb.ARCH = base["arch"]
    if base.get("ckpt"):
        rtb.CKPT_NAME = base["ckpt"]
    if base.get("width"):
        rtb.WIDTH = int(base["width"])
    if base.get("height"):
        rtb.HEIGHT = int(base["height"])

    # --- in-context 参考图配置 ---
    incontext = cfg.get("incontext", {})
    if incontext:
        rtb.INCONTEXT = {
            "strength": float(incontext.get("strength", 1.0)),
            "start_percent": float(incontext.get("start_percent", 0.0)),
            "end_percent": float(incontext.get("end_percent", 0.90)),
            "cond_only": bool(incontext.get("cond_only", True)),
            "fit_mode": str(incontext.get("fit_mode", "pad")),
            "ref_timestep": float(incontext.get("ref_timestep", 0.0)),
            "refs": list(incontext.get("refs", [])),
        }
    else:
        rtb.INCONTEXT = {}

    # --- 逐页画布配置 ---
    rtb.PAGE_CANVAS = []
    for pc in cfg.get("page_canvas", []):
        entry = {
            "page": str(pc.get("page", "")).strip(),
            "width": int(pc["width"]) if "width" in pc else None,
            "height": int(pc["height"]) if "height" in pc else None,
            "end_percent": float(pc["end_percent"]) if "end_percent" in pc else None,
        }
        rtb.PAGE_CANVAS.append(entry)

    # --- 采样参数强制覆盖（illus 线没有对应 Studio 预设，直接在这里给）---
    if cfg.get("sampling"):
        rtb.SAMPLING_OVERRIDE = dict(cfg["sampling"])

    # --- 运行期开关 ---
    # [runtime] free_vram = false → 本作品不按页清显存（比如页数很少、或想拿
    # 连续页的手感）。不写则沿用引擎默认值（默认开）。
    runtime = cfg.get("runtime", {})
    if "free_vram" in runtime:
        rtb.FREE_VRAM_BEFORE_PAGE = bool(runtime["free_vram"])
    # [runtime] seed_mode = "random"（默认，每页随机）| "hash"（按页名派生，可复现）| "fixed"
    if runtime.get("seed_mode"):
        rtb.SEED_MODE = str(runtime["seed_mode"]).strip().lower()

    # --- 提示词替换（分镜标签 → LoRA 实际训练触发词）---
    rtb.PROMPT_REPLACE = [(r["from"], r["to"])
                          for r in (prompt.get("replace") or [])]

    # 立即应用一次架构强制 + [sampling] 覆盖。
    # 必须在这里（而不是只在 apply_preset 里）—— 否则「没写 preset」的作品配上
    # 那些「只在有 preset 时才调 apply_preset」的脚本（run_insert / run_*_artists /
    # run_recognition_test）时，[sampling] 会被静默忽略，跑出引擎模块默认值
    # （12步 CFG1.6 beta57）而不报错。
    rtb._apply_sampling_overrides()

    # --- 逐页规则 ---
    rtb.PAGE_RULES = []
    for r in cfg.get("page_rule", []):
        rtb.PAGE_RULES.append({
            "name":           r.get("name", "rule"),
            "when_triggers":  list(r.get("when_triggers", [])),
            "preset":         r.get("preset"),
            "bundle_only":    bool(r.get("bundle_only", False)),
            "exclude_family": list(r.get("exclude_family", [])),
            "loras":          _loras(r.get("loras", []), base_dir),
        })

    # --- 自动补挂 ---
    auto = cfg.get("auto_rules", {})
    rtb.AUTO_ACTION_LORAS = bool(auto.get("enabled", True))
    if auto.get("rules_file"):
        rtb.LORA_RULES_FILE = _resolve(auto["rules_file"], base_dir)
    if auto.get("categories"):
        rtb.AUTO_LORA_CATEGORIES = set(auto["categories"])
    rtb.AUTO_EXCLUDE_KEYWORDS = set(auto.get("exclude_keywords", []))

    # --- 采样验证闸（[validation]）---
    # 踩脚页禁止双彩：foot_keywords 覆盖默认踩脚词表，foot_allow_presets 放行
    # 全扩散类预设，double_presets 可手动点名「双彩」预设。
    val = cfg.get("validation", {}) or {}
    rtb.FOOT_PLAY_KEYWORDS  = set(val.get("foot_keywords", []))
    rtb.FOOT_FRAME_KEYWORDS = set(val.get("foot_frame_keywords", []))
    rtb.FOOT_ALLOW_PRESETS  = set(val.get("foot_allow_presets", []))
    rtb.DOUBLE_PRESETS      = set(val.get("double_presets", []))
    if val.get("foot_gate_mode"):
        rtb.FOOT_GATE_MODE = str(val["foot_gate_mode"])

    return rtb, cfg, base_preset
