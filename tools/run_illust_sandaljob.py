r"""
光辉底模 (zukiAnimeILL = Illustrious/SDXL) —— sandaljob 搭配测试

目的：找出「穿鞋足交」在光辉侧怎么搭配效果最好。
      sandaljob 不是 Danbooru tag（0 帖），是 LoRA 触发词 5anda1j0b。

事实来源（读 trigger.txt / header，非猜测）：
  illus\action\foot\sandaljob_illustr  触发词 = 5anda1j0b, footjob, sandals
  illus\action\foot\strp_illustr       触发词 = strp_fj（镫袜足交）
  illus\action\foot\reverse_footjob_ilxl_v1  触发词 = reverse footjob
  illus\action\foot\Feet XL detailed foot focus style illustriousXL v1  触发词 = detailed style
  illus\outfit\尘白_安卡希雅_东流映荷-lora-1.0il-v10-000010
       触发词 = ankaxiya(dlyh), twintails, double bun, dlyh hair ornament,
                dlyh breast curtains, dlyh china dress, dlyh puffy short sleeves,
                dlyh wrist cuffs, dlyh side-tie panties
       作者参数：CFG 5、832x1216 等；训练集 93% 是 3D 渲染 → 负面加 3d, render, cgi

Danbooru 实存 tag（已核）：footjob_through_footwear(64)、footjob_with_sandals(92)、
                           shoejob(757)、footjob_with_footwear(799)

用法：
    tools/run_batch.sh run_illust_sandaljob.py            # 跑全部
    tools/run_batch.sh run_illust_sandaljob.py S2 S6      # 只跑指定
"""

import json
import sys
import time
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

HOST = "127.0.0.1:8188"
CLIENT = str(uuid.uuid4())

CKPT       = "zukiAnimeILL_best.safetensors"
# 采样参数**照抄用户自己的光辉工作流** `illusmanga.json`：
#   25 步 / CFG 6 / euler_ancestral / normal / 960x1280
STEPS      = 25
CFG        = 6.0
SAMPLER    = "euler_ancestral"
SCHEDULER  = "normal"
WIDTH, HEIGHT = 960, 1280
SEED       = 88888888
# 插队（POST /prompt front=true）—— 正在跑的批次不会被等死
FRONT      = "--no-front" not in sys.argv

OUT_SUBDIR = "光辉_沙足测试"
MAC_OUT    = Path("/Users/glow/Base/Works/ComfyUI/Outputs")

# ─── LoRA ─────────────────────────────────────────────────────
DLYH      = (r"illus\outfit\尘白_安卡希雅_东流映荷-lora-1.0il-v10-000010.safetensors", 0.7)
SANDALJOB = (r"illus\action\foot\sandaljob_illustr.safetensors", 1.0)
FEETXL    = (r"illus\action\foot\Feet XL detailed foot focus style illustriousXL v1.safetensors", 0.5)
STRP      = (r"illus\action\foot\strp_illustr.safetensors", 1.0)
NOCHE     = (r"concept\footjob-v2-illustriousxl-lora-nochekaiser.safetensors", 0.8)
REVERSE   = (r"illus\action\foot\reverse_footjob_ilxl_v1.safetensors", 1.0)

# ─── 提示词骨架 ────────────────────────────────────────────────
# 品质前缀取自用户 illusp.json（Illustrious 惯例那套）
QUALITY = "masterpiece, best quality, amazing quality, very aesthetic, absurdres, newest"

# 角色（东流映荷皮肤）+ 鞋 + 男主。足交类 tag 由各变体自己加。
SUBJECT = ("1girl, solo, ankaxiya(dlyh), twintails, double bun, dlyh hair ornament, "
           "dlyh china dress, dlyh puffy short sleeves, dlyh wrist cuffs, "
           "silver hair, long hair, golden eyes, high heel sandals, "
           "1boy, faceless male, penis, hetero")
FRAMING = "sitting, foot focus, close-up"

# 负面**原样取自用户 animanga-ill.json 的足部专用负面**（他们自己的配方），
# 只额外追加 3d/render/cgi —— 东流映荷训练集 93% 是 3D 渲染，不加会出手办质感。
NEGATIVE = ("low quality, worst quality, bad anatomy, deformed anatomy, mutated anatomy, "
            "extra limbs, extra feet, third foot, multiple feet, fused feet, feet merged, "
            "overlapping feet, second foot visible, more than one foot, extra toes, missing toes, "
            "fused toes, deformed toes, twisted feet, bad foot structure, "
            "(stirrup covering sole:1.5), (stirrup wrapping foot:1.5), closed toed stirrup, "
            "stirrup covering toes, stirrup covering heel, foot fully enclosed, shoe, "
            "socks on soles, sole covered, (stirrup strap passing between toes:1.5), "
            "(strap wrapping around toes:1.5), (strap on toes:1.4), (toes clamping penis:1.5), "
            "(toes gripping shaft:1.5), (toes touching penis:1.5), toes entangled with strap, "
            "penis between toes, foot merged with another foot, (two feet occupying same space:1.5), "
            "3d, render, cgi, watermark, text")

# ─── 变体：(标签, 足交 tag 串, LoRA 栈) ─────────────────────────
STACK_BASE = [DLYH, SANDALJOB, FEETXL]

VARIANTS = [
    ("S1-trigger-only",   "5anda1j0b",                                        STACK_BASE),
    ("S2-full-trigger",   "5anda1j0b, footjob, sandals",                      STACK_BASE),
    ("S3-with-sandals",   "5anda1j0b, footjob with sandals",                  STACK_BASE),
    ("S4-shoejob",        "5anda1j0b, shoejob",                               STACK_BASE),
    ("S5-through-fw",     "5anda1j0b, footjob through footwear, sandals",     STACK_BASE),
    ("S6-control-notrig", "footjob with sandals",                             STACK_BASE),

    # 第二轴：LoRA 栈（prompt 用 S2 的满触发）
    ("H1-sandal-alone",   "5anda1j0b, footjob, sandals",                      [DLYH, SANDALJOB]),
    ("H2-plus-feetxl",    "5anda1j0b, footjob, sandals",                      [DLYH, SANDALJOB, FEETXL]),
    ("H3-plus-noche",     "5anda1j0b, footjob, sandals",                      [DLYH, SANDALJOB, NOCHE]),
    ("H4-plus-strp",      "5anda1j0b, footjob, sandals",                      [DLYH, SANDALJOB, STRP]),
    ("H5-sandal-w08",     "5anda1j0b, footjob, sandals",                      [DLYH, (SANDALJOB[0], 0.8), FEETXL]),
    ("H6-sandal-w12",     "5anda1j0b, footjob, sandals",                      [DLYH, (SANDALJOB[0], 1.2), FEETXL]),
]

_want = [a for a in sys.argv[1:] if a.startswith(("S", "H"))]
if _want:
    VARIANTS = [v for v in VARIANTS if v[0].split("-")[0] in _want]


def build_workflow(positive: str, loras, prefix: str) -> dict:
    p = {}
    p["1"] = {"class_type": "CheckpointLoaderSimple",
              "inputs": {"ckpt_name": CKPT}}
    model, clip = ["1", 0], ["1", 1]
    for i, (path, wt) in enumerate(loras):
        nid = str(10 + i)
        p[nid] = {"class_type": "LoraLoader", "inputs": {
            "model": model, "clip": clip,
            "lora_name": path, "strength_model": float(wt), "strength_clip": float(wt),
        }}
        model, clip = [nid, 0], [nid, 1]
    p["30"] = {"class_type": "CLIPTextEncode", "inputs": {"text": positive, "clip": clip}}
    p["31"] = {"class_type": "CLIPTextEncode", "inputs": {"text": NEGATIVE, "clip": clip}}
    p["4"]  = {"class_type": "EmptyLatentImage",
               "inputs": {"width": WIDTH, "height": HEIGHT, "batch_size": 1}}
    p["40"] = {"class_type": "KSampler", "inputs": {
        "model": model, "positive": ["30", 0], "negative": ["31", 0],
        "latent_image": ["4", 0], "seed": SEED, "steps": STEPS, "cfg": CFG,
        "sampler_name": SAMPLER, "scheduler": SCHEDULER, "denoise": 1.0,
    }}
    p["50"] = {"class_type": "VAEDecode", "inputs": {"samples": ["40", 0], "vae": ["1", 2]}}
    p["60"] = {"class_type": "SaveImage", "inputs": {"images": ["50", 0], "filename_prefix": prefix}}
    return p


def queue(wf: dict) -> str:
    body = {"prompt": wf, "client_id": CLIENT}
    if FRONT:
        body["front"] = True          # 插到队首：正在跑的批次跑完当前节点即执行
    data = json.dumps(body).encode()
    req = urllib.request.Request(f"http://{HOST}/prompt", data=data,
                                 headers={"Content-Type": "application/json"})
    return json.loads(urllib.request.urlopen(req, timeout=60).read())["prompt_id"]


def wait(pid: str, timeout: int = 600) -> list:
    start = time.time()
    while time.time() - start < timeout:
        try:
            with urllib.request.urlopen(f"http://{HOST}/history/{pid}", timeout=30) as r:
                data = json.loads(r.read())
            if pid in data:
                imgs = []
                for out in data[pid].get("outputs", {}).values():
                    imgs.extend(out.get("images", []))
                return imgs
        except Exception:
            pass
        time.sleep(2)
    return []


def fetch(images: list, dest_root: Path) -> list:
    got = []
    for im in images:
        q = urllib.parse.urlencode({"filename": im["filename"],
                                    "subfolder": im.get("subfolder", ""),
                                    "type": im.get("type", "output")})
        try:
            with urllib.request.urlopen(f"http://{HOST}/view?{q}", timeout=120) as r:
                blob = r.read()
        except Exception as e:
            print(f"      ⚠️ 回传失败：{e}")
            continue
        d = dest_root / im.get("subfolder", "")
        d.mkdir(parents=True, exist_ok=True)
        fp = d / im["filename"]
        fp.write_bytes(blob)
        got.append(fp)
    return got


def main() -> None:
    print(f"🎨 底模：{CKPT}  ({STEPS}步 CFG{CFG} {SAMPLER}/{SCHEDULER} {WIDTH}x{HEIGHT})")
    print(f"🎯 投递：{'队首（插队）' if FRONT else '队尾'}")
    print(f"🧪 {len(VARIANTS)} 个变体，seed={SEED} 固定")
    print("=" * 70)

    results = []
    for tag, foot_tags, loras in VARIANTS:
        pos = f"{QUALITY}\n\n{SUBJECT}, {foot_tags}, {FRAMING}"
        print(f"\n[{tag}]")
        print(f"      LoRA：{' + '.join(f'{Path(p).stem}@{w}' for p, w in loras)}")
        print(f"      足交 tag：{foot_tags}")
        try:
            pid = queue(build_workflow(pos, loras, f"{OUT_SUBDIR}/{tag}"))
            print(f"      → {pid[:8]}…")
            imgs = wait(pid)
            if imgs:
                print(f"      ✅ {imgs[0]['filename']}")
                for f in fetch(imgs, MAC_OUT):
                    print(f"      ⬇️  {f}")
                results.append((tag, True))
            else:
                print("      ❌ 超时/失败")
                results.append((tag, False))
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", "ignore")[:300]
            print(f"      ❌ HTTP {e.code}: {body}")
            results.append((tag, False))
        except Exception as e:
            print(f"      ❌ {e}")
            results.append((tag, False))

    ok = sum(1 for _, o in results if o)
    print(f"\n{'=' * 70}\n✅ 成功 {ok} / {len(results)}")
    print(f"输出：{MAC_OUT}/{OUT_SUBDIR}/")


if __name__ == "__main__":
    main()
