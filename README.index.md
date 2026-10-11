# README Index — ComfyUI-Workflow-Studio (fork)

Condensed index of README.md: the fork's intro summary verbatim, then one line per section (the full prose, tables, code blocks and SVG embeds live in the excluded README.md). Exists so graphify can extract this without feeding the homepage markup to the local Ollama model. Regenerate with `python tools/generate_doc_index.py readme` whenever README.md changes.

<p align="center">
  <img src="./assets/readme/hero.svg" width="100%" alt="Workflow Studio fork build: a storyboard page of score tags is parsed, matched against 34 self-trained LoRA rules, injected through a CR LoRA Stack cascade, and rendered by a remote RTX 3090 running an Anima W8A8 INT8 UNet. 把分镜页文本直接变成成图。">
</p>

<p align="center">
  <a href="https://github.com/comfyanonymous/ComfyUI"><img src="https://img.shields.io/badge/ComfyUI-custom_node-blue" alt="ComfyUI custom node"></a>
  <a href="https://github.com/ketle-man/ComfyUI-Workflow-Studio"><img src="https://img.shields.io/badge/upstream-v0.7.11-informational" alt="Synced with upstream v0.7.11"></a>
  <img src="https://img.shields.io/badge/Node-%E2%89%A520.19%20%C2%B7%20Py%203.11%2B%20batch-green" alt="Node 20.19 or newer; Python 3.11 or newer for the batch engine">
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-lightgrey" alt="MIT license"></a>
</p>

A **fork** of [ketle-man/ComfyUI-Workflow-Studio](https://github.com/ketle-man/ComfyUI-Workflow-Studio) — the ComfyUI workflow / asset / generation studio, plus the pipeline this fork exists for: **storyboard page in → matched self-trained LoRAs at measured weights → rendered on a remote GPU → images back on the local disk.**

本仓库是 [ketle-man/ComfyUI-Workflow-Studio](https://github.com/ketle-man/ComfyUI-Workflow-Studio) 的 **fork**。上游那套 Studio 全部保留；这个 fork 存在的理由是上面那条链路：分镜页文本进 → 自动匹配自训 LoRA 的实测权重 → 远程算力机出图 → 图回传本机。

---

## Sections

- What this fork adds · 本 fork 加了什么
- Quick start · 快速上手
- The pipeline · 出图链路
- Storyboard → LoRA · 分镜解析与智能触发
- Cascade · 多 LoRA 精确权重级联
- Generation presets · 生成预设
- Batch engine · `batch.toml` 批量出图
- Development · 开发与上游同步
- What you inherit · 你继承了什么
- Requirements · 环境
- Repo layout · 目录（fork 视角）
- Notes & limits · 说明与限制
- License
- Acknowledgements
