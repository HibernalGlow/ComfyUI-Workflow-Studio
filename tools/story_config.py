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

    # --- base LoRA 栈 + 默认预设 ---
    base = cfg.get("base", {})
    rtb.LORAS = _loras(base.get("loras", []), base_dir)
    base_preset = base.get("preset")

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

    return rtb, cfg, base_preset
