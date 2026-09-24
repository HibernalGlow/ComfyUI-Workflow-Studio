"""
Batch Typhon Storyboard Runner
用 v2.3 底模 + 原版提丰 LoRA + Bubutuke 画师，
按序跑完 明日方舟_提丰/pages/ 下所有 TP*.txt 分镜页面。
"""

import json
import urllib.request
import time
import uuid
import sys
import os
import re
from pathlib import Path

COMFY_HOST = "127.0.0.1:8188"
CLIENT_ID  = str(uuid.uuid4())

PAGES_DIR = Path("/Users/glow/Base/Works/ComfyUI/Workflows/wild/storyboard/明日方舟_提丰/pages")
PAGE_GLOB = "TP*.txt"   # 页面文件名模式（各作品前缀不同：提丰=TP，洛茜=R）

# ─── 固定配置 ────────────────────────────────────────────────
UNET_NAME       = "silvermoonmixAnima_v23_INT8.safetensors"
QUALITY_PREFIX  = "masterpiece, best quality, aesthetic, highly detailed, bubutuke, uncensored, typhoeusendfield"
NEGATIVE        = "worst quality, low quality, bad anatomy, bad hands, missing fingers, extra digit, fewer digits, watermark, text"
SEED            = 88888888   # 固定种子对比

# 采样参数默认值 = Studio 预设 "anima-single-turbo"（12步 + Turbo）
STEPS           = 12
CFG             = 1.6
SAMPLER         = "euler_ancestral"
SCHEDULER       = "beta57"
TURBO_ENABLED   = True
TURBO_LORA_NAME = "Turbo-v0.2"

# 采样模式：single = 单采样器；double = Stage1 底模粗采 + Stage2 套 LoRA 精修
SAMPLING_MODE   = "single"
STAGE1          = {"steps": 5, "cfg": 4.6, "sampler_name": "er_sde", "scheduler": "simple"}

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

    # 1) 逐页规则：命中后整组注入该规则的 loras
    rule = match_page_rule(positive_text)
    if rule:
        for _sw, _nm, path, mw, cw in rule.get("loras", []):
            if path.lower() in existing_paths:
                continue
            extra.append(("On", _nm, path, float(mw), float(cw)))
            existing_paths.add(path.lower())
        if rule.get("bundle_only", False):
            return extra      # 该页只挂基线+本规则，不再叠规则库的动作 LoRA

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

def _fetch_presets():
    """返回 (presets, 来源说明)。优先运行中的 Studio，其次本地文件。"""
    try:
        with urllib.request.urlopen(STUDIO_PRESETS_API, timeout=10) as r:
            return json.loads(r.read().decode("utf-8")), "Studio 实时接口"
    except Exception as e:
        if not PRESETS_FILE.is_file():
            raise SystemExit(f"❌ 取不到 Studio 预设（{e}），本地也没有 {PRESETS_FILE}")
        return json.loads(PRESETS_FILE.read_text(encoding="utf-8")), f"本地回退文件（{e}）"


def load_preset(preset_id: str) -> dict:
    """按 id 或名称读取预设：优先运行中的 Studio，其次本地 data/gen_presets.json。"""
    presets, src = _fetch_presets()
    for p in presets:
        if p.get("id") == preset_id or p.get("name") == preset_id:
            print(f"   预设来源：{src}")
            return p
    ids = " | ".join(p.get("id", "?") for p in presets)
    raise SystemExit(f"❌ 未找到预设 '{preset_id}'（来源：{src}）。可用：{ids}")


def preset_turbo_enabled(preset: dict) -> bool:
    """预设的 LoRA 列表里含 turbo 则开启 Turbo，否则关闭（原生全扩散）。"""
    return any("turbo" in (l.get("path") or "").lower()
               for l in preset.get("loras", []) if l.get("active", True))


def apply_preset(preset_id: str, quiet: bool = False) -> dict:
    """把 Studio 预设写进模块级采样参数。供 main() 与各预览脚本共用。"""
    global STEPS, CFG, SAMPLER, SCHEDULER, TURBO_ENABLED, SAMPLING_MODE, STAGE1

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
        }
        s = preset.get("sampler_stage2") or {}
    else:
        s = preset.get("sampler_settings") or {}

    STEPS         = int(s.get("steps", STEPS))
    CFG           = float(s.get("cfg", CFG))
    SAMPLER       = s.get("sampler_name", SAMPLER)
    SCHEDULER     = s.get("scheduler", SCHEDULER)
    TURBO_ENABLED = preset_turbo_enabled(preset)

    if not quiet:
        print(f"📌 应用 Studio 预设：{preset.get('name')}  [{preset.get('id')}]  mode={SAMPLING_MODE}")
        if SAMPLING_MODE == "double":
            print(f"   Stage1(底模): {STAGE1['steps']}步 CFG{STAGE1['cfg']} "
                  f"{STAGE1['sampler_name']}/{STAGE1['scheduler']}")
            print(f"   Stage2(LoRA): {STEPS}步 CFG{CFG} {SAMPLER}/{SCHEDULER}")
        else:
            print(f"   单采样: {STEPS}步 CFG{CFG} {SAMPLER}/{SCHEDULER}")
        print(f"   Turbo={'On' if TURBO_ENABLED else 'Off'}")
    return preset


# ─── 工具函数 ─────────────────────────────────────────────────

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
    return f"{QUALITY_PREFIX}\n\n{body}".strip()

def build_workflow(positive_text: str, filename_prefix: str) -> dict:
    """构造纯净 API 格式工作流。"""
    prompt = {}

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
    prompt["4"] = {"class_type": "EmptyLatentImage", "inputs": {"width": 832, "height": 1216, "batch_size": 1}}

    # --- CR LoRA Stack（最多 3 个槽 per 节点，自动扩展）---
    # 基线 LoRA + 本页按文本匹配到的动作 LoRA（镫袜/子宫口/降龄/发交…）
    base_paths = {l[2].lower() for l in LORAS}
    page_loras = list(LORAS) + auto_action_loras(positive_text, base_paths)
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
                if not TURBO_ENABLED and nm == TURBO_LORA_NAME:
                    sw = "Off"
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
        "model":      ["1",  0],
        "clip":       ["2",  0],
        "lora_stack": [last_stack_id, 0]
    }}
    prompt["30"] = {"class_type": "CLIPTextEncode", "inputs": {"text": positive_text, "clip": ["20", 1]}}
    prompt["31"] = {"class_type": "CLIPTextEncode", "inputs": {"text": NEGATIVE,      "clip": ["20", 1]}}
    def _sampler(model_ref, latent_ref, steps, cfg, sampler, scheduler):
        return {"class_type": "FLS_SamplerV4", "inputs": {
            "model": model_ref, "positive": ["30", 0], "negative": ["31", 0],
            "latent_image": latent_ref,
            "seed": SEED, "steps": int(steps), "cfg": float(cfg),
            "sampler_name": sampler, "scheduler": scheduler, "denoise": 1.0,
            "fovea_strength": 3.0, "sharpness": 0.5, "mask_inertia": 0.85
        }}

    if SAMPLING_MODE == "double":
        # Stage 1：底模裸跑（不带 LoRA）粗采定骨架
        prompt["40"] = _sampler(["1", 0], ["4", 0],
                                STAGE1["steps"], STAGE1["cfg"],
                                STAGE1["sampler_name"], STAGE1["scheduler"])
        # Stage 2：套 LoRA 精修，latent 接 Stage 1 输出
        prompt["41"] = _sampler(["20", 0], ["40", 0], STEPS, CFG, SAMPLER, SCHEDULER)
        last_latent = ["41", 0]
    else:
        prompt["40"] = _sampler(["20", 0], ["4", 0], STEPS, CFG, SAMPLER, SCHEDULER)
        last_latent = ["40", 0]

    prompt["50"] = {"class_type": "VAEDecode",  "inputs": {"samples": last_latent, "vae": ["3", 0]}}
    prompt["60"] = {"class_type": "SaveImage",  "inputs": {"images": ["50", 0], "filename_prefix": filename_prefix}}
    return prompt

def queue_prompt(prompt_workflow: dict) -> str:
    data = json.dumps({"prompt": prompt_workflow, "client_id": CLIENT_ID}).encode()
    req  = urllib.request.Request(
        f"http://{COMFY_HOST}/prompt", data=data,
        headers={"Content-Type": "application/json"}
    )
    res  = urllib.request.urlopen(req)
    return json.loads(res.read())["prompt_id"]

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
        if a.lstrip("-").isdigit():
            start_from = int(a.lstrip("-")); i += 1; continue
        print(f"⚠️  忽略未知参数：{a}")
        i += 1

    base_preset_id = preset_id
    if preset_id:
        apply_preset(preset_id)

    out_subdir = f"{OUTPUT_SUBDIR}{tag}"

    pages = sorted(PAGES_DIR.glob(PAGE_GLOB))
    total = len(pages)
    if only:
        want = set(only)
        pages = [p for p in pages if p.stem.split("—")[0].upper() in want]
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
    for idx, page in enumerate(pages, 1):
        stem   = page.stem   # e.g. "TP004—a01提丰-足心软肉"
        prefix = f"{out_subdir}/{stem}"
        print(f"\n[{idx:02d}/{len(pages)}] {stem}")

        try:
            positive = parse_txt(page)
            # 逐页选预设：命中的页规则若指定了 preset 就换过去（如 native-30），
            # 其余页回到命令行给的 base 预设。LoRA 名单由同一条规则决定。
            rule = match_page_rule(positive)
            if rule and rule.get("preset"):
                apply_preset(rule["preset"], quiet=True)
                print(f"      ⚙️  [{rule.get('name')}] → {rule['preset']} "
                      f"({STEPS}步 CFG{CFG} {SAMPLER}/{SCHEDULER} Turbo={TURBO_ENABLED})")
            elif base_preset_id and rule:
                apply_preset(base_preset_id, quiet=True)
            workflow = build_workflow(positive, prefix)
            pid      = queue_prompt(workflow)
            print(f"      → 已投递 prompt_id={pid[:8]}…")
            imgs     = wait_done(pid)
            if imgs:
                print(f"      ✅ 完成：{imgs[0]['filename']}")
                results.append({"page": stem, "ok": True,  "file": imgs[0]["filename"]})
            else:
                print(f"      ❌ 超时/失败")
                results.append({"page": stem, "ok": False, "file": None})
        except Exception as e:
            print(f"      ❌ 异常：{e}")
            results.append({"page": stem, "ok": False, "file": str(e)})

        # 连续失败 = 后端未在执行（服务可能在监听但采样线程已死），立即中止而非空等
        consec = 0
        for r in reversed(results):
            if r["ok"]:
                break
            consec += 1
        if consec >= 3:
            nxt = start_from + idx
            print(f"\n🛑 连续 {consec} 张失败，判定后端未执行提示词（HTTP 正常但不再出图）。")
            print("   请检查 Windows 上的 ComfyUI 日志后重跑：")
            print(f"   python run_typhon_batch.py {nxt} --preset {preset_id or 'anima-single-turbo'}")
            break

    # 汇总
    ok_count   = sum(1 for r in results if r["ok"])
    fail_count = len(results) - ok_count
    print(f"\n{'='*60}")
    print(f"✅ 成功：{ok_count}  ❌ 失败：{fail_count}")
    if fail_count:
        for r in results:
            if not r["ok"]:
                print(f"   FAIL  {r['page']}  →  {r['file']}")
    if fail_count:
        print("⚠️  本次未跑完，请修复后端后按上面的命令续跑。\n")
    elif ok_count:
        print("🎉 全部完成！\n")
    else:
        print("⚠️  没有任何页面被处理。\n")

if __name__ == "__main__":
    main()
