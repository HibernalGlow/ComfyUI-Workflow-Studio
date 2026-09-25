# 分镜批量出图 —— 派发与监控交接文档

> 适用：`Workflows/wild/storyboard/<作品>/pages/` 下的分镜页批量出图
> 已跑通实例：`明日方舟_提丰`(60)、`明日方舟终末地_洛茜`(190)、`念念`(100)
> 待派发实例：`琴柳`(100，页面尚未生成)

---

## 0. 一句话流程

**在作品目录写一个 `batch.toml` → 建一个 3 行的 runner → 用 `run_batch.sh` 起 → 挂守望作业。**

---

## 1. 谁在哪（先搞清拓扑，排错全靠它）

| 位置 | 角色 | 跑什么 |
|---|---|---|
| **Mac**（本机） | 开发/派发端 | Studio 源码、前端 dev-server、**派发脚本**。**不跑图** |
| **Windows**（`win30902` / hostname `Pterosaur`） | 算力端 | ComfyUI + GPU + 模型库 + **出图落盘** |
| SSH 隧道 | 桥梁 | Mac `127.0.0.1:8188` ← `ssh -L` → Windows `127.0.0.1:8188` |

**关键认知：图是在 Windows 上生成的，所以文件天然落在 Windows 磁盘。**
Mac 永远不自动收到图，除非用下面的「回传」机制。

隧道由自愈守护维持（断了 5 秒自动重连），所以 Windows 重启后通常**不用手动重连**，
但 **ComfyUI 本身需要重新起来**（Comfy Desktop 不会自动重生，要手点重启）。

---

## 2. 一个作品需要准备什么

```
Workflows/wild/storyboard/<作品>/
├── pages/              ← 分镜 txt，命名必须有统一前缀
│   ├── NN001—a01念念-退朝卸衮.txt
│   └── NN002—…
├── batch.toml          ← 【你要建的】出图配置
├── PROMPT.md           ← 规格书（人看，脚本不读）
└── character_map.md    ← 角色/LoRA 登记（人看）
```

分镜 txt 格式（脚本用正则取 `[tags]` 和 `[caption]`）：

```text
[tags]
1girl, saileach \(arknights\), …, (white stirrup legwear:1.3), …

[caption]
自然语言场景描述…
```

**前缀必须统一且唯一**（`NN` / `TP` / `RB…RZ`），因为 `page_glob` 靠它匹配：
```toml
page_glob = "NN*.txt"
```

---

## 3. 派发三步

### 第 1 步：确认 LoRA 齐备（最容易翻车的一步）

去 Windows 上查三样东西：

```bash
# ① 已注册的 LoRA 列表（ComfyUI 认得的才算数）
curl -s "http://127.0.0.1:8188/object_info/CR%20LoRA%20Stack" \
  | python3 -c "import sys,json;n=json.loads(sys.stdin.read(),strict=False)['CR LoRA Stack']['input']['required']['lora_name_1'][0];print(len(n));[print(x) for x in n if 'saileach' in x.lower()]"

# ② 磁盘上找文件（可能没注册、或路径和文档写的不一样）
ssh win30902 'dir /B /S "D:\1Repo\Github\ComfyUI\Library\models\loras\*saileach*"'

# ③ 拿触发词（**必做**，触发词常常和文件名不一致）
ssh win30902 'type "D:\1Repo\Github\ComfyUI\Library\models\loras\anima\chara\oc\Niannian.trigger.txt"'
```

**血泪教训**：
- `healthyman` 的触发词是 `@hea1thy`、`smilejiaozi` 是 `@smilej1aozi`、
  `YD-dacner-outfit`（文件名拼错成 **dacner**）——**永远读 trigger.txt，别猜**。
- 文档里写的路径**可能是错的**。`琴柳`/`念念` 的 character_map 就把
  `anima\outfit\…` 写成了 `anima\clothes\…`（该目录不存在）。
- 触发词文件里**可能塞的是别的信息**（如 `illus` 这种 base 名），不是真触发词。
- safetensors 元数据里常常**没有** trainedWords，得去 Civitai 查。

### 第 2 步：写 `batch.toml`

照抄 `念念/batch.toml` 改。核心字段：

```toml
[story]
id   = "qinliu"
name = "琴柳"

[paths]
pages_dir     = "pages"
page_glob     = "NN*.txt"          # ← 按实际前缀改
output_subdir = "琴柳"              # ComfyUI output 下的子目录名

[output]
mac_dir = "../../../../Outputs"    # 根目录；出图后按 subfolder 结构回传 Mac
                                   # 留空 = 不回传，图只留 Windows

[prompt]
quality_prefix = "masterpiece, best quality, aesthetic, highly detailed, <画师触发词>, uncensored"
negative       = "worst quality, low quality, bad anatomy, bad hands, missing fingers, extra digit, fewer digits, watermark, text"

[base]
preset = "anima-two-stage-standard"     # 默认采样预设（Studio gen_presets.json）

  # 基线 LoRA：每页都挂。顺序 = 入栈顺序（加速 → 品质 → 画师 → 角色）
  [[base.loras]]
  name = "Turbo-v0.2"
  path = 'anima\turbo\anima-turbo-lora-v0.2.safetensors'
  model_weight = 0.8
  clip_weight  = 1.0
  # …Aesthetic Boost 0.48 / 画师 / 角色

# 逐页规则：**所有命中的规则都会生效**（一页可命中多条）
[[page_rule]]
name           = "镫袜足交"
when_triggers  = ["ustirrup", "stirrupjob", "footjob", "under-stirrup footjob"]
preset         = "anima-native-30"     # 命中后换预设
bundle_only    = true                  # 只挂基线+本规则，不再叠规则库
exclude_family = ["ustirrup", "stirrupjob", "throughfoot", "stirrup3"]

  [[page_rule.loras]]
  name = "Ustirrup 2000"
  path = 'anima\action\footjob\ustirrup\ustirrup-step00002000.safetensors'
  model_weight = 0.88
  clip_weight  = 1.0

[auto_rules]
enabled          = true
rules_file       = "../../../../ComfyUI-Workflow-Studio/data/lora_rules.json"
categories       = ["action", "repair"]
exclude_keywords = ["hairop", "footrepair"]
```

**写法注意**：
- Windows 路径用**单引号**（TOML 字面串），反斜杠不转义
- `pages_dir` / `rules_file` / `mac_dir` 都**相对 batch.toml 自身**解析，
  所以整个作品目录搬到哪都能用（`../../../../` = `Works/ComfyUI`）

### 第 3 步：建 runner（3 行）

复制 `tools/run_niannian_batch.py`，只改 `TOML` 那一行：

```python
TOML = Path("/Users/glow/Base/Works/ComfyUI/Workflows/wild/storyboard/琴柳/batch.toml")
```

---

## 4. 跑

```bash
cd /Users/glow/Base/Works/ComfyUI/ComfyUI-Workflow-Studio
nohup tools/wait_and_run.sh run_qinliu_batch.py 1 > /tmp/qinliu.log 2>&1 &
```

- `wait_and_run.sh` 会**先等后端就绪**（探针 200）再开跑，避免模型路径异常时空烧
- 第二个参数是**起始序号**（1 基）；续跑就填下一个未完成序号
- 只跑指定页：`--only NN022,NN023`
- 加输出后缀：`--tag _v2`

> 必须用 `run_batch.sh` / `wait_and_run.sh` 包装，因为 **TOML 需要 Python 3.11+**
> （标准库 `tomllib`）。wrapper 会自动挑解释器；机器上只有 3.9/3.10 时
> 可 `python3 -m pip install --user tomli`。

---

## 5. 监控

```bash
# 进度
grep -oE "^\[[0-9]+/[0-9]+\]" /tmp/qinliu.log | tail -1

# 成功/失败/回传计数
grep -cE "✅ 完成" /tmp/qinliu.log          # 出图成功
grep -c  "已回传 Mac" /tmp/qinliu.log       # 回传成功
grep -c  "回传失败" /tmp/qinliu.log         # 回传失败

# 逐页挂了什么（每页都会打印命中规则和预设）
grep -E "⚙️|✅ 完成" /tmp/qinliu.log | tail -20

# 挂一个完成守望（进程退出就通知/打印汇总）
while pgrep -f "run_qinliu_batch.py" >/dev/null; do sleep 30; done
tail -16 /tmp/qinliu.log
```

**后端健康探针**（唯一判据，无副作用）：

```bash
curl -s -o /dev/null -w '%{http_code}\n' \
  http://127.0.0.1:8188/object_info/OTUNetLoaderW8A8
# 200 = 模型路径全通   500 = 有模型根目录不存在
```

---

## 6. ⚠️ 注意事项（都是真踩过的）

### 6.1 模型根目录不存在 → **所有投递 400**（最坑的一个）

ComfyUI 实例配置 `%APPDATA%\Comfy Desktop\instance-model-paths\inst-*.yaml`
里列了多个模型根目录。**只要其中任何一个不存在**（例如外接 `E:` 盘掉线），
`int8-fast` 节点在 `INPUT_TYPES()` 里扫目录就抛 `FileNotFoundError`，
**每一次 `/prompt` 都返回 400**，全批卡死。

- 症状：连续 3 张 `HTTP Error 400: Bad Request` → 触发保护中止
- 排查：跑那个探针；500 就是这个原因
- 已处理：`E:\1Hub\Gen\ComfyUI\Library\models` 这条已从配置删除
  （原件备份 `inst-…yaml.bak-20260925-042043`）
- **预防**：跑批前先跑探针；`wait_and_run.sh` 已内置这个等待

### 6.2 连续 3 张失败会自动中止 —— 这是**保护，不是 bug**

引擎判定「HTTP 正常但不再出图」就停，并打印续跑命令。看到 `🛑 连续 N 张失败`
不要以为是崩溃，先按 6.1 查后端。

### 6.3 不要边跑边改代码

Python **只在 import 时读一次**代码和配置。跑批中途改 `run_*.py` / `batch.toml`
**对已在运行的进程无效**（而且会造成前后两段配置不一致）。
要改就：停 → 改 → 用正确序号续跑。

### 6.4 一页可能同时命中多条页规则

例：念念 `NN022/NN023` 既是「YD 舞娘服饰」又是「镫袜足交」。
引擎会**取全部命中规则的 LoRA 并集**，预设取第一条带 `preset` 的。
写规则时注意顺序和 `bundle_only`：

- `bundle_only = true` = 该页只挂「基线 + 命中的页规则」，**不再叠规则库**
  （用于镫袜页，避免 `age_slider` 等额外干扰）

### 6.5 LoRA 权重压不住就会污染画风

分工况实测结论：**正权重一律 ≤ 1**。

- 动作 LoRA 权重顶着（如 `ustirrup1500 1.2`）会把画师风格带脏
- 参考工作室既有配方里权重天然 ≤1 的那两个（`ustirrup2000 0.88` + `stirrup3-1 0.63`）
  是验证过不脏的
- 唯一允许 >1 的是**负权重** `age_slider -1.35`（降龄，故意为负）

### 6.6 镫袜页要换 30 步预设

镫袜动作 LoRA 在 turbo 少步数下"吃不够"，画面发糊。
所以命中镫袜的页自动切到 `anima-native-30`（30 步 / CFG 4.0 / 无 Turbo）。
这一条已写进 `page_rule`，不用手动管。

### 6.7 出图回传 vs 归档（容易搞混）

| 机制 | 落点 | 说明 |
|---|---|---|
| ComfyUI 原生 | **Windows** `D:\…\output\<output_subdir>\` | 一定会有，无法避免 |
| 回传（`[output] mac_dir`） | **Mac** `Outputs/<output_subdir>/` | 每张生成完立刻下载，失败只记日志 |
| 归档到 E: | 需要另做 | 目前**没有**自动归档 |

**重要**：回传是"复制"，不是"移动"。Windows 上的原图**始终保留**——
这是好事，因为**只要 Windows 上还在，就能随时重新取回**：

```bash
# 追补/重取（可对正在跑的批次持续追补）
python3.11 tools/mirror_output.py <output_subdir> /Users/glow/Base/Works/ComfyUI/Outputs
```

反过来，**一旦把图移出 Windows 就再也取不回来了**（`/view` 会 404）。
洛茜那批有 130 张就是这样被移到 E: 归档区的，只能从 E: 找，脚本无能为力。

### 6.8 别用 ssh 列中文文件名

中文文件名经 ssh 回传会被 GBK 编码破坏。列举一律走 ComfyUI 的 `/history`
（`mirror_output.py` 就是这么做的），不要 `dir` 拿名字。

### 6.9 Windows 重启后

- 隧道：**不用管**，守护会自动重连
- ComfyUI：**要手动重启**（Comfy Desktop 弹「进程已退出」，点重启）
- 起来后探针应恢复 200

### 6.10 预设泄漏 Bug（已根治，切勿重犯）

- **症状**：明明默认是双采，但只要某一页命中了单采预设（如镫袜页 native-30），后面无规则的页面全都会被带偏成单采 30 步。
- **根因**：旧代码判断回退基线时写了 `elif base_preset_id and rules:`。导致普通页（`rules` 为空）根本不触发重置，状态直接沿用上一页。
- **解决**：统一由 `resolve_preset()` 纯函数控制，未命中规则强制 fallback 到 `base_preset_id`，并且 `dryrun_batch.py` 严格复用该函数，杜绝干跑与实际执行漂移。

### 6.11 插队机制与单页超时预算（`run_insert.py`）

- **机制**：ComfyUI 原生支持 `POST /prompt` 携带 `front: true`，服务端将任务权重置负排至队首，可在**不中断既有批次**的前提下，让高优先级任务插在正在执行的页面之后立刻跑。
- **超时陷阱**：批次 runner 投递后会等待 `wait_done(pid, timeout=WAIT_TIMEOUT)`。插队任务执行时间 $T$ 会直接蚕食批次下一页的等待额度。如果 $T > 240s$（默认超时 300s 减去正常出图 60s），批次下一页就会被误判超时（连续 3 次触发保护停机）。
- **解法**：在作品 `batch.toml` 的 `[output]` 配置 `wait_timeout = 1800`。单次插队建议控制在少量页（1~3 页），或通过 `tools/run_insert.py` 传入 `--no-front` 走普通队尾排队。

---

## 7. 排错速查

| 症状 | 先查 | 处置 |
|---|---|---|
| 全批 `HTTP Error 400` | 探针是否 500 | 6.1，删掉不存在的模型根目录 + 重启 ComfyUI |
| `🛑 连续 3 张失败` | 后端探针 | 同上；修好后按打印的序号续跑 |
| `Empty reply from server` | Windows 是否在监听 8188 | ComfyUI 没起 → 重启它 |
| 报错找不到类名，但探针 200 | 挂载的 LoRA 路径 | 路径写错（如 `clothes` vs `outfit`） |
| 图片没到 Mac | `grep -c 回传失败` | 0 失败 = 已到过 Mac，是被移走了 |
| `/view` 404 | 图是否还在 Windows | 已移出 Windows → 取不回来 |
| 画风不对/发糊 | 权重是否 >1、镫袜页是否换了 30 步 | 6.5 / 6.6 |
| 改了配置没生效 | 是否重启了进程 | 6.3 |

---

## 8. 相关文件索引

| 文件 | 作用 |
|---|---|
| `tools/run_typhon_batch.py` | **共享引擎**：组图 / 投递 / 逐页规则 / 回传 / 续跑 / 失败保护 |
| `tools/story_config.py` | TOML 装载器（`tomllib`，路径相对 TOML 解析） |
| `tools/run_batch.sh` | 挑 Python 3.11+ 再 exec |
| `tools/wait_and_run.sh` | 等后端就绪再开跑 |
| `tools/mirror_output.py` | 追补回传（可 `--watch-pid` 边跑边补） |
| `tools/dryrun_batch.py` | **干跑校验**：验证页规则命中、LoRA 注册状态与预设切换 |
| `tools/run_insert.py` | **插队工具**：利用 `front: true` 插入高优先级任务且不破坏主干批次 |
| `tools/run_niannian_batch.py` | runner 模板（3 行） |
| `tools/run_qinliu_batch.py` | 琴柳专用 runner |
| `tools/run_qinliu_artists.py` | 琴柳画师评测脚本（已测 SANTA, mgk000, Oyari 自练/Ashito） |
| `tools/run_rossi_batch.py` | 另一 runner 示例 |
| `data/gen_presets.json` | 采样预设（Studio UI 也读这份） |
| `data/lora_rules.json` | 动作/修复类 LoRA 规则库 |
| `<作品>/batch.toml` | 作品配置（**跟作品走、可入库**） |

---

## 9. 附：琴柳现状与执行记录

已于 2026-09-25 跑通派发：

| 项 | 值 |
|---|---|
| 页面 | **100 页，前缀 `SL`**（`SL001—a01琴柳-退朝卸甲` … `SL100—a01琴柳-圣旗永固`） |
| 角色 | `saileach \(arknights)`（琴柳，底模原生识别，免 LoRA） |
| 画师 | **Oyari Ashito**（`anima\artist\260924\style-Oyari_Ashito-Anima-v01.safetensors`，w=1.0，无触发词，负面加压 `speech bubble, frame, censored` 等） |
| 规则分流 | 92 页走双采 (`anima-two-stage-standard`)；8 页镫袜足交切单采 30 步 (`anima-native-30`)；10 页挂载 YD舞娘 |
| 历史插曲 | SL005~SL019 因预设泄漏跑了单采 30 步，按方案 C 保留既有产物，已从 SL020 修正为双采续跑至 100 |

