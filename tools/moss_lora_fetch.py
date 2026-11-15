#!/usr/bin/env python3
"""把 Civitai 上的 MOSS-Image LoRA 装进 Windows ComfyUI 库，并保存作者说明。

对每个 modelVersionId:
  1. 拉 /api/v1/model-versions/<vid> + /api/v1/models/<mid>
  2. 下载 safetensors（走代理，需 token）
  3. 校验字节数 vs sizeKB、读 safetensors 头（tensor 数 / dim / dtype / sha256）
  4. 生成三件套 sidecar:
       <name>.trigger.txt  (无触发词则 .notrigger.txt)
       <name>.preview.png  (Civitai 第一张示例图，按魔数定后缀)
       <name>.info.md      (作者推荐参数摘录 + 说明全文 + 元数据)
       <name>.civitai.json (裁剪后的原始元数据，便于以后重处理)
  5. scp 到 D:/1Repo/Github/ComfyUI/Library/models/loras/moss/
  6. 打印 ComfyUI LoraLoader 里是否已出现

用法:
    python3 tools/moss_lora_fetch.py 3451027 3422750 \
        --endpoint http://127.0.0.1:18188
    python3 tools/moss_lora_fetch.py 3438879 --docs-only     # 只补文档，不下载
"""
import argparse
import hashlib
import json
import os
import re
import shutil
import struct
import subprocess
import sys
import time
import urllib.parse
import urllib.request

PROXY = "http://127.0.0.1:7890"
API = "https://civitai.com"
WIN_LORA_DIR = "D:/1Repo/Github/ComfyUI/Library/models/loras/moss"
WORK = "/tmp/moss_fetch"


def token():
    with open(os.path.expanduser("~/.mcp.json")) as f:
        cfg = json.load(f)
    return cfg["mcpServers"]["civitai"]["env"]["CIVITAI_API_KEY"]


def http(url, binary=False, timeout=180):
    op = urllib.request.build_opener(
        urllib.request.ProxyHandler({"http": PROXY, "https": PROXY}))
    req = urllib.request.Request(url, headers={
        "Accept": "*/*" if binary else "application/json",
        "User-Agent": "moss-lora-fetch/1.0"})
    last = None
    for attempt in range(4):
        try:
            with op.open(req, timeout=timeout) as r:
                return r.read()
        except Exception as e:  # 代理偶发 TLS EOF / 超时
            last = e
            time.sleep(2 * (attempt + 1))
    raise last


def html_to_text(html):
    if not html:
        return ""
    t = re.sub(r"(?i)<br\s*/?>", "\n", html)
    t = re.sub(r"(?i)</p\s*>", "\n\n", t)
    t = re.sub(r"(?i)</li\s*>", "\n", t)
    t = re.sub(r"<[^>]+>", "", t)
    t = (t.replace("&nbsp;", " ").replace("&amp;", "&")
          .replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", '"'))
    t = re.sub(r"[ \t]+\n", "\n", t)
    return re.sub(r"\n{3,}", "\n\n", t).strip()


PARAM_KEYS = re.compile(
    r"(cfg|sampler|scheduler|steps|step|weight|权重|触发词|trigger|strength|"
    r"denoise|分辨率|resolution|lora\s*strength|推荐|recommend|clip\s*skip)", re.I)


def param_excerpt(text):
    out = []
    for line in text.splitlines():
        s = line.strip()
        if s and PARAM_KEYS.search(s) and len(s) < 300:
            out.append(s)
    seen, uniq = set(), []
    for s in out:
        if s not in seen:
            seen.add(s)
            uniq.append(s)
    return uniq[:40]


def st_header(path):
    size = os.path.getsize(path)
    with open(path, "rb") as f:
        n = struct.unpack("<Q", f.read(8))[0]
        hdr = json.loads(f.read(n))
    meta = hdr.pop("__metadata__", {}) or {}
    down = [v["shape"] for k, v in hdr.items() if k.endswith("lora_down.weight")]
    dim = down[0][0] if down else None
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for c in iter(lambda: f.read(1 << 22), b""):
            h.update(c)
    qkv = any(("qkv" in k) for k in hdr)
    return dict(size=size, tensors=len(hdr), layers=len(down), dim=dim, qkv=qkv,
                dtypes=sorted({v["dtype"] for v in hdr.values()}),
                meta=meta, sha256=h.hexdigest().upper()[:12])


def magic_ext(path):
    with open(path, "rb") as f:
        m = f.read(12)
    if m.startswith(b"\x89PNG"):
        return ".png"
    if m.startswith(b"\xff\xd8\xff"):
        return ".jpg"
    if m.startswith(b"RIFF") and m[8:12] == b"WEBP":
        return ".webp"
    if m[4:12] == b"ftypavif":
        return ".avif"
    return None


def ssh(host, cmd):
    return subprocess.run(["ssh", "-o", "HostName=" + host, "-o", "ConnectTimeout=10",
                           "win30902", cmd], capture_output=True, text=True)


def win_size(host, name, subdir=""):
    base = WIN_LORA_DIR.replace("/", "\\")
    if subdir:
        base = base + "\\" + subdir.replace("/", "\\")
    r = ssh(host, 'powershell -NoProfile -Command "(Get-Item \'%s\\%s\' -ErrorAction '
                   'SilentlyContinue).Length"' % (base, name))
    v = (r.stdout or "").strip().splitlines()[-1:] or [""]
    return int(v[0]) if v[0].isdigit() else None


def build_info_md(ver, model, f, fname, hdr):
    v = ver
    m = model
    creator = (m.get("creator") or {}).get("username", "?")
    stats = m.get("stats") or {}
    trig = ", ".join(v.get("trainedWords") or []) or "（无）"
    model_text = html_to_text(m.get("description"))
    ver_text = html_to_text(v.get("description"))
    both = model_text + "\n" + ver_text
    params = param_excerpt(both)
    base = v.get("baseModel")
    lines = [
        "# %s — %s" % (m.get("name"), v.get("name")),
        "",
        "| 项 | 值 |",
        "|---|---|",
        "| 作者 | %s |" % creator,
        "| 模型 ID / 版本 ID | %s / %s |" % (m.get("id"), v.get("id")),
        "| 版本 | %s（发布于 %s）|" % (v.get("name"), (v.get("publishedAt") or "")[:10]),
        "| baseModel | %s |" % base,
        "| 类型 | %s |" % m.get("type"),
        "| 触发词 | `%s` |" % trig,
        "| 文件 | `%s` |" % fname,
        "| 大小 | %s B |" % (hdr["size"] if hdr else "?"),
        "| 结构 | %s tensors / %s LoRA 层 / dim %s / %s |" % (
            hdr["tensors"], hdr["layers"], hdr["dim"], ",".join(hdr["dtypes"])) if hdr
        else "| 结构 | 未下载，未读取 |",
        "| sha256 | `%s` |" % ((hdr or {}).get("sha256") or (f.get("hashes") or {}).get("sha256", "?")[:12].upper()),
        "| 下载量 / 点赞 | %s / %s |" % (stats.get("downloadCount", "?"), stats.get("thumbsUpCount", "?")),
        "| 页面 | %s |" % ("https://civitai.red/models/%s/%s?modelVersionId=%s" % (
            m.get("id"), m.get("name", "").lower().replace(" ", "-"), v.get("id"))),
        "| 许可 | credit=%s, commercial=%s, derivatives=%s |" % (
            m.get("allowNoCredit"), m.get("allowCommercialUse"), m.get("allowDerivatives")),
        "",
        "## 作者推荐参数（原文摘录）",
        "",
    ]
    if params:
        lines += ["```"] + params + ["```"]
    else:
        lines.append("_作者说明里没有可自动识别的参数行，见下方全文。_")
    if hdr and hdr.get("qkv"):
        lines += ["", "## 兼容性（安装时自动检测）", "",
                  "> ⚠ 本 LoRA 含 `proj_qkv`（融合 QKV）权重。当前 `moss-image-base-dit-int8-convrot` "
                  "是分离的 q/k/v，ComfyUI 不会拆分，**注意力部分不会加载**，只剩 MLP 生效。",
                  "> 要完整使用，需要融合 qkv 的 checkpoint（Comfy-Org / SFT 系 int8）。", ""]
    lines += ["", "## 作者说明（MOSS 部分优先看原文）", "", model_text or "_(无)_", ""]
    if ver_text:
        lines += ["### 版本说明（%s）" % v.get("name"), "", ver_text, ""]
    lines += ["---", "",
              "由 `tools/moss_lora_fetch.py` 于安装时抓取，HTML 已转纯文本；",
              "参数为原文摘录，未做改写。若与作者后续更新不一致，以 Civitai 页面为准。"]
    return "\n".join(lines)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("versions", nargs="+")
    ap.add_argument("--host", default="192.168.134.79")
    ap.add_argument("--endpoint", default="http://127.0.0.1:18188")
    ap.add_argument("--docs-only", action="store_true")
    ap.add_argument("--subdir", default="", help="相对 moss/ 的子目录")
    args = ap.parse_args()

    tok = token()
    os.makedirs(WORK, exist_ok=True)
    installed = []

    for vid in args.versions:
        ver = json.loads(http("%s/api/v1/model-versions/%s" % (API, vid)))
        if "error" in ver:
            print("[%s] ERROR %s" % (vid, ver))
            continue
        mid = ver["modelId"]
        model = json.loads(http("%s/api/v1/models/%s" % (API, mid)))
        f = next(x for x in ver["files"] if x.get("type") == "Model")
        name = f["name"]
        want = round(f["sizeKB"] * 1024)
        path = os.path.join(WORK, name)
        print("\n=== %s | %s / %s" % (name, model.get("name"), ver.get("name")))
        print("    base=%s size=%s trig=%s" % (ver.get("baseModel"), want,
                                               ver.get("trainedWords")))

        have = win_size(args.host, name, args.subdir)
        if os.path.exists(path):
            have_local = os.path.getsize(path)
        else:
            have_local = None

        downloaded = False
        hdr = None
        if (args.docs_only or have == want) and os.path.exists(path) \
                and os.path.getsize(path) == want:
            hdr = st_header(path)
        if args.docs_only or have == want:
            print("    文件已在 Windows（%s B），跳过下载" % have)
        else:
            if have_local != want:
                url = "%s/api/download/models/%s?token=%s" % (API, vid, tok)
                print("    下载中…")
                data = http(url, binary=True, timeout=900)
                with open(path, "wb") as fh:
                    fh.write(data)
                downloaded = True
            print("    本地 %s B / 期望 %s B" % (os.path.getsize(path), want))
            if os.path.getsize(path) != want:
                print("    !!! 字节数不符，停止")
                continue
            hdr = st_header(path)
            print("    header: %s tensors, %s layers, dim %s, %s, sha %s" % (
                hdr["tensors"], hdr["layers"], hdr["dim"],
                ",".join(hdr["dtypes"]), hdr["sha256"]))
            if hdr["layers"] != 252:
                print("    !!! LoRA 层数 %s != 252（非 MOSS-Image DiT 结构？）" % hdr["layers"])

        # sidecars
        trigs = ver.get("trainedWords") or []
        if not trigs:
            blob = html_to_text((model.get("description") or "") +
                                (ver.get("description") or ""))
            mt = re.search(r"<\|artist\|>[^<\s][^<]*<\|/artist\|>", blob)
            if mt:
                trigs = [mt.group(0)]
            else:
                mt = re.search(r"(?i)trig[a-z]*\s*(?:word|words)?\s*[:：]\s*"
                               r"([@A-Za-z0-9_<>|./\-]+)", blob)
                if mt:
                    trigs = [mt.group(1)]
        base_info = ("# base = %s | dim %s | %s | sha256 %s\n" % (
            ver.get("baseModel"), (hdr or {}).get("dim", "?"),
            ",".join((hdr or {}).get("dtypes", [])),
            (hdr or {}).get("sha256") or (f.get("hashes") or {}).get("sha256", "?")[:12].upper()))
        head = ("# model = %s (%s) by %s\n" % (model.get("name"), ver.get("name"),
                                               (model.get("creator") or {}).get("username")))
        src = ('# source_url = "https://civitai.red/models/%s?modelVersionId=%s"\n'
               % (mid, vid))
        if trigs:
            open(os.path.join(WORK, name + ".trigger.txt"), "w").write(
                ", ".join(trigs) + "\n" + head + base_info + src)
        else:
            open(os.path.join(WORK, name + ".notrigger.txt"), "w").write(
                "# 作者未提供 trainedWords（无触发词）\n" + head + base_info + src)
        open(os.path.join(WORK, name + ".info.md"), "w").write(
            build_info_md(ver, model, f, name, hdr))
        slim = dict(model={k: model.get(k) for k in
                           ("id", "name", "type", "nsfw", "allowNoCredit",
                            "allowCommercialUse", "allowDerivatives", "stats", "creator")},
                    version={k: ver.get(k) for k in
                             ("id", "name", "baseModel", "trainedWords", "publishedAt",
                              "description", "files", "stats")})
        slim["model"]["description"] = model.get("description")
        open(os.path.join(WORK, name + ".civitai.json"), "w").write(
            json.dumps(slim, ensure_ascii=False, indent=1))

        imgs = [i for i in ver.get("images", []) if i.get("type") == "image"]
        prev = None
        if imgs:
            raw = os.path.join(WORK, name + ".rawimg")
            with open(raw, "wb") as fh:
                fh.write(http(imgs[0]["url"], binary=True, timeout=120))
            ext = magic_ext(raw)
            if ext:
                prev = name + ".preview" + ext
                shutil.move(raw, os.path.join(WORK, prev))
            else:
                os.remove(raw)
                print("    !!! 示例图格式非图片，跳过预览")
        else:
            print("    !!! 无示例图")

        send = [name] if (have != want or downloaded) else []
        for suf in (".trigger.txt", ".notrigger.txt", ".info.md", ".civitai.json"):
            p = os.path.join(WORK, name + suf)
            if os.path.exists(p):
                send.append(name + suf)
        if prev:
            send.append(prev)
        print("    scp: %s" % ", ".join(send))
        r = subprocess.run(["scp", "-o", "HostName=" + args.host,
                            "-o", "ConnectTimeout=10"] + send +
                           ["win30902:" + WIN_LORA_DIR + ("/" + args.subdir if args.subdir else "") + "/"],
                           cwd=WORK, capture_output=True, text=True)
        if r.returncode != 0:
            print("    !!! scp 失败: %s" % (r.stderr.strip().splitlines()[-1:]))
        installed.append(name)

    # 验证
    print("\n=== LoraLoader 列表")
    try:
        d = json.loads(http(args.endpoint + "/object_info/LoraLoader"))
        names = d["LoraLoader"]["input"]["required"]["lora_name"][0]
        for n in installed:
            hit = [x for x in names if x.replace("\\", "/").split("/")[-1] == n]
            print("   %-46s %s" % (n, hit[0] if hit else "!!! 未出现"))
    except Exception as e:
        print("   查询失败（ComfyUI 未起？）: %s" % e)


if __name__ == "__main__":
    sys.exit(main())
