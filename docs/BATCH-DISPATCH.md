# 分镜批量出图 —— 派发与监控交接文档

> 适用：`Workflows/wild/storyboard/<作品>/pages/` 下的分镜页批量出图
> 已跑通实例：`明日方舟_提丰`(60)、`明日方舟终末地_洛茜`(190)、`念念`(100)
> 待派发实例：`琴柳`(100，页面尚未生成)

---

## 0. 一句话流程

**在作品目录写一个 `batch.toml` → 建一个 3 行的 runner → 干跑校验 → 用 `wait_and_run.sh` 起 → 挂守望作业 + 回传。**

> ⛔ **执行权：出图只有这一个入口。** 不要手搭 ComfyUI 图 JSON 去 `POST /prompt` 出正式页。
> 手搓会绕过本文件里 §6.10（预设泄漏防护）、§6.12（踩脚页采样闸）、回传、失败保护、
> `wait_and_run.sh` 探针 —— 每一条都是踩出来的。特殊参数的正确落点是 `batch.toml`
> （`[[page_rule]]` / `[[page_canvas]]` / `[incontext]` / `[validation]` / `[runtime]`），引擎都已支持。
> 唯一例外：用户显式要求「单张打样 / A-B 对照 / 只测一个变量」时可手搓一次性探测，
> 但探测脚本要落在 `tools/probe_*.py` / `tools/run_*_artists.py`，**结论回灌 `batch.toml` 再走正式批次**。
>
> 技能侧的同一约束：`anima-storyboard` 规则 0f + `references/16-studio-execution.md`（本文档的提炼镜像）。

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
preset = "anima-single-17"             # 默认采样预设（Studio gen_presets.json）
                                       # 2026-09-28 起默认从 two-stage-standard 改为 single-17
                                       # （3-seed 对照唯一 0 坏格）；要稳定出 6 格/掷版式再换回
                                       # anima-two-stage-standard（已是 5 + 17@dn0.7）

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

### 6.12 踩脚页采样闸：双彩会把镫袜 LoRA 跑成烂图（已加自动告警）

**症状**：踩脚 / 足交页本体形成崩坏，足心横带、足弓、脚趾结构糊成一团，
镫袜 LoRA 像根本没挂上。

**根因**：这些页跑的是双层预设（`anima-two-stage-standard`，5 步粗采 + 精修）。
双层采样（**双彩**）是画质向、步数极少；镫袜类 LoRA 的细节根本吃不满，
必须走**全扩散**（`anima-native-30`：30 步 / CFG4.0 / er_sde / 无 Turbo）。

**修法**：给踩脚类的 `[[page_rule]]` 加 `preset = "anima-native-30"`，
并确保 `when_triggers` 覆盖**踩踏类**词 —— 只写 `footjob` 会让
`stepping on another` / `foot on penis` / `foot worship` 这类点漏网掉回双彩。

**三层防线（现已内置，不需要你记得）**：

| 层 | 位置 | 行为 |
|---|---|---|
| 干跑 | `tools/dryrun_batch.py` | 打印采样告警，**退出码 1**（可 `--warn-only` 降级） |
| 跑批 | `run_typhon_batch.py` | 投递前拦下该页，横幅报错并列出修法 |
| 审计 | `tools/audit_foot_presets.py` | 扫**所有**作品，一次列出全部隐坑 |

闸门语义（写进作品 `batch.toml`）：

```toml
[validation]
# 踩脚页允许用的预设（列进来的不告警）
foot_allow_presets = ["anima-native-30"]
# "block"（默认，拦下不出图）/ "warn"（只告警照跑）
foot_gate_mode = "block"
# 可选：覆盖默认词表
# foot_keywords       = [...]   # 硬门槛：足交/踩踏/膜拜等真·手法词
# foot_frame_keywords = [...]   # 软提醒：foot focus 等取景词，不当门禁
# double_presets      = [...]   # 手动点名哪些预设算「双彩」
```

**关键设计：两层词表，别混**

- **硬门槛**（`foot_keywords`）：`footjob` / `stepping on another` / `foot worship`
  / `foot on penis` / `toe scrunch` … —— 真把足部当主体来玩。命中且跑双彩 → 拦。
- **软提醒**（`foot_frame_keywords`）：`foot focus` / `sole focus` —— 这只是**镜头语言**，
  不代表足部是性行为主体。命中只打印 `ℹ️`。

> ⚠️ **血泪教训**：早期把 `foot focus` 塞进硬门槛，全仓 204 个页面里
> 82 个无辜页被喊狼来了；把 `stirrup legwear`（每页都有的**服饰**标签）
> 收进来后连发交页都被误报。词表分层后降到 41 个真·隐坑。
> **别把服饰标签和取景标签塞进硬门槛。**

**验证闸门本身还能用**：

```bash
python3 tools/test_foot_preset_gate.py     # 18 个纯函数用例，不需 GPU
python3 tools/audit_foot_presets.py -v     # 逐页打印所有作品的踩脚页路由
```

### 6.13 Anima In-Context 参考图出图（`arch = "anima-incontext"`）

适用于不单独训角色 LoRA，依靠 1~2 张参考图 + 画师 LoRA 还原角色的工作流（如飞鸟马时中秋故事板）。

**配置要点**：
1. **架构声明**：`batch.toml` 的 `[base]` 中设置 `arch = "anima-incontext"`。引擎自动挂接独立的 `UNETLoader` + `LoraLoaderModelOnly` 链 + `AnimaRefEncode` + `AnimaRefLatentBatch` + `AnimaInContextApply` + `KSampler` 拓扑（不影响原 `anima` / `illus` 分支）。
2. **参考支路 `[incontext]`**：
   - `[[incontext.refs]]`: 必须在 ComfyUI 的 `input/` 目录下（通常为 1 张脸部特写 + 1 张全身图）。
   - `end_percent`: 姿势旋钮。1.0 为强复印参考图姿势；0.7 易出脸手变形/细节丢失；参考姿势与分镜姿势一致时用 0.95，跨姿势族（如坐姿到仰躺）用 0.75。
3. **逐页画幅 `[[page_canvas]]`**：
   - 机制强制要求：`AnimaRefEncode.target_width/height` **必须等于**该页生成分辨率，否则 latent 尺寸错位。支持逐页设置 `width`、`height` 与该页专属的 `end_percent`。
4. **服装锚定句 `[prompt].nl_append`**：
   - 当分镜 tags 缺省颜色且 caption 遵守 §13.4 不复述服装标签时，正向提示词会丢失全部服装细节。通过 `nl_append` 在每页末尾统一追回自然语言修饰，确保广袖、流苏、腰花、袜圈稳定还原。

**已知机制上限与避坑指南（实测血泪）**：
1. **两人身体大面积重叠时，男方必糊成肉块**：接合处与男方易崩坏（三种姿势 mating press / cowboy shot / missionary × 两种景别均无法根治）。这是 8GB 显存 + 2 张参考 + ~1.0MP 的硬件与算法上限。正确解法是改分镜设计（`pov` 镜头避开男方入画，或改为女方单人特写页）。
2. **构图陷阱**：`cowboy shot` 用在两人重叠页上比 `full body` 更差，因为裁近镜头会把未收敛的解剖缺陷放大满屏。
3. **衣服颜色必须在参考图中出现**：若只给半身参考图，裙子/袜子无颜色参考，模型会照标签瞎编（如把淡冰蓝画成深蓝）。
4. **两张参考图切忌来自同一张图的裁切**：会导致严重的“复印机”效应。

---

### 6.14 足部页的 `preset` 不许动，触发词抄最新的项目（2026-09-28）

**⛔ 踩脚 / 足交 / 足部当主体的页，`preset` 必须是 `anima-native-30`。**

- 9 个已跑通作品的足部规则**逐字节相同**：
  `preset = "anima-native-30"` + `Ustirrup 2000 w=0.88` + `Stirrup 3-1 w=0.63`
- `native-30` = 30步 / CFG 4.0 / `er_sde` / **Turbo Off**。
  预设的 LoRA 表里没有 turbo ⇒ `preset_turbo_enabled` 为假 ⇒ 引擎**摘掉基线 Turbo**。
  **这是它的一半作用，不是副作用。**
- **反例（真实发生）**：把这条 `preset` 删掉，让足部页继承基线的 `anima-single-17`
  （Turbo On / CFG 1.6 / 17 步）→ 足交页当场烂。

**触发词表和规则结构，抄最新的项目：**

| 抄什么 | 从哪抄 | 为什么 |
|---|---|---|
| `when_triggers` | `星穹铁道_爻光_火花_花火`（09-27 19:58，**16 词**） | 琴柳（09-25）只 4 词，`foot worship` / `stepping on another` / `two-footed footjob` 会漏到基线预设 |
| 规则结构 | `原神_至冬`（09-27 18:22） | 足部分三条：`踩脚袜足交`（native-30 + 那对 LoRA）／`穿鞋足交`／`足部玩法`（native-30，**不挂**镫袜 LoRA —— 踩踏膜拜不是足交） |

```bash
# 看全部项目的足部规则（按修改时间倒序）
python3 - <<'PY'
import os, tomllib, time
from pathlib import Path
R = Path("/Users/glow/Base/Works/ComfyUI/Workflows/wild/storyboard")
for p in sorted(R.glob("*/batch.toml"), key=os.path.getmtime, reverse=True):
    d = tomllib.load(open(p, "rb"))
    ts = time.strftime("%m-%d %H:%M", time.localtime(os.path.getmtime(p)))
    print("%s  [%s]  base=%s" % (p.parent.name, ts, (d.get("base") or {}).get("preset")))
    for r in d.get("page_rule") or []:
        trig = " ".join(r.get("when_triggers") or []).lower()
        if any(k in trig for k in ("foot", "stirrup", "toe", "trampl", "sole")):
            print("   * %-16s preset=%-16s %s" % (r.get("name"), r.get("preset"),
                  [l["model_weight"] for l in (r.get("loras") or [])]))
PY
```

**改任何已在成功项目里存在的键之前，先 `--only <一页足部页>,<一页普通页>` 出 2 张对照。**
新默认（如 `anima-single-17`）适用于**新作品**；老项目按原配方跑。

### 6.15 ⚠️ 同名文件缓存：会把好图当成烂图（2026-09-28 真实事故）

**症状**：改了配置重跑，看着 UI 里的图「还是烂的」；实际上新图是好的。

**机理**：ComfyUI 的 `/view?filename=...` **按文件名服务**，响应头带 `Etag` / `Last-Modified`，
浏览器/前端拿缓存。而清空 output 后重跑，`get_save_image_path` 又从 `_00001_` 开始 ⇒
**文件名与上次完全相同** ⇒ `/view` URL 相同 ⇒ 显示旧图。

**排查（照做）**：

1. 看**文件 mtime**，不要只看 UI 缩略图：
   `ls -l --time-style=full-iso <dir>` / Windows `Get-ChildItem | Select Name,LastWriteTime`
2. 换新名字再看：`--tag _v2`（输出 subdir 变 → URL 变 → 不撞缓存）
3. 硬刷新（⌘/Ctrl+Shift+R），或直接看 Mac 回传目录里的实体文件
4. 拿不准就把图读出来目视 —— **「图烂」这个结论本身也要先取证**

**根治：让出图名天然唯一 → 页面按命名规范带梗概。**
引擎把 **page stem 原样当成出图名前缀**：

| 页面名 | 出图名 | 后果 |
|---|---|---|
| `P001.txt` | `P001_00001_.png` | 每轮同名 → **必撞缓存** |
| `P001—a01篠泽广-后台沙发.txt` | `P001—a01篠泽广-后台沙发_00001_.png` | 梗概一改就换名 → 不撞，且能按文件名翻图 |

所以**页面必须按 `anima-storyboard` §9.2 命名**：`<缩写><NNN>—<am编号><角色中文名>-<梗概>.txt`。
只写 `P001.txt` 的项目属**不规范**，补齐它对出图、排错、人工翻图三件事都直接有益。
（`--only` 与 `resolve_page_canvas` 都取 `stem.split("—")[0]`，所以页码段不变即可。）

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
| `tools/dryrun_batch.py` | **干跑校验**：验证页规则命中、LoRA 注册状态、预设切换与**踩脚页采样闸** |
| `tools/audit_foot_presets.py` | **踩脚页采样审计**：扫所有作品，找「踩脚页跑双彩」的坑 |
| `tools/test_foot_preset_gate.py` | 采样闸门回归测试（纯函数，不需 GPU / ComfyUI） |
| `tools/run_insert.py` | **插队工具**：利用 `front: true` 插入高优先级任务且不破坏主干批次 |
| `tools/run_niannian_batch.py` | runner 模板（3 行） |
| `tools/run_toki_batch.py` | 飞鸟马时 in-context 批处理 runner（3 行） |
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

> ⚠️ **这份记录是历史事实，不是当今推荐**：当时预设库的默认还是 `anima-two-stage-standard`（而且 Stage 1 还是死代码，见 `../../stage1_fix_report.md`）。
> **2026-09-28 起默认改为 `anima-single-17`**，新作品请照 §3 的新写法。
| 历史插曲 | SL005~SL019 因预设泄漏跑了单采 30 步，按方案 C 保留既有产物，已从 SL020 修正为双采续跑至 100 |


---

## 10. 单页式改版工作流与两个新坑（2026-09-28，洛茜 270 页）

### 10.1 为什么必须单页式：Anima 不会画分镜

洛茜第一版 190 页里有 `4koma` 52 页、`2koma` 52 页、`sound effects` 84 页、
`motion lines` 53 页、`inset`/`cross-section` 48 页，caption 也写成
`Panel A: … Panel B: …`。结果就是多格拼贴、小人脸、比例崩 —— **这是画质崩的头号原因**。

改版规则：

| 做法 | 说明 |
|---|---|
| 一页 = 一帧 | 删掉 `4koma` / `2koma` / `Panel A-D` / `motion lines` / `sound effects` / `speed lines` / `split screen` / `before and after` / `inset` / `cross-section` / `zoom layer` |
| 开宫怎么表达 | 单帧语言是 `(cervical penetration:1.3)` + `(deep penetration:1.2)` + `(uterus:1.2)` + `(stomach bulge:1.2)` + `hand on stomach` + `ahegao` + `rolling eyes` —— **不要再用 inset/x-ray 切面** |
| 负面兜底 | negative 里加 `frame, panel, speech bubble, comic, 4koma, multiple views, split screen, character sheet` |
| 构图词只留单帧安全的 | `full body` / `close-up` / `from behind` / `from below` / `foot focus` / `dutch angle` 等 |

### 10.2 大页面集（>100 页）用 `spec/*.tsv` + 生成器，不要手写 200 个 txt

洛茜的落地形态：

```
<作品>/spec/*.tsv          ← 一页一行，10 列（code/title/wardrobe/body/foot/pose/interact/ejac/scene/caption）
<作品>/build_pages.py      ← 读 spec → 写 pages/*.txt + 反向生成 outline.md
<作品>/batch.toml
```

- 恒定块（角色本体标签 / 手套 / 男方）写在**生成器**里，逐页只写增量 → 270 页的 TSV 可读可审
- 生成器内置**校验**：页码格式、标题唯一、列数、**禁用词**（`child` / `flat chest` / `narrow waist` /
  `toned stomach` / `4koma` / `inset` …）、caption 必须出现角色名
- `outline.md` 由 TSV 反向生成 ⇒ **大纲与页面永不脱节**（手写大纲是上一个版本最大的漂移源）
- 改一页 → 改 TSV 一行 → `python3 build_pages.py`，比在 200 个 txt 里 grep 安全得多

### 10.3 ⛔ `bundle_only` 是个陷阱（本次真实踩到）

`[[page_rule]]` 的 `bundle_only = true` 会让**整块规则库被跳过**（`auto_action_loras()` 直接 return）。
后果不是"少挂一个脚部 LoRA"，而是：

```
洛茜第一批干跑：94 个足部/玩法页全部丢掉 Age Slider Old (w=-1.35) 与 Cervical Penetration
                → 降到 176 页命中；降龄锁是项目的承重结构，等于 94 页年龄失控
```

**正确做法**：只想挡同族脚部 LoRA，用 `exclude_family` ——
它在 `_load_action_rules()` 里是**全局池过滤**（并且页规则显式注入的路径会被
`_rule_lora_basenames()` 一并从池里摘掉），根本不需要 `bundle_only`。

干跑自检口径：**基线的降龄/深入类 LoRA 命中页数必须等于总页数**。数字对不上就是有规则把池子挡了。

### 10.4 双重画师混合（JIMA12 + Jima）

《偶像大师》用的 `260924/JIMA12`（触发词 `jimafg`）之外，库里还有一支独立的
`260613/Jima`（触发词 `jima`）。同 seed 四变体横比（`tools/probe_rossi_jima.py`）：

| 变体 | 结构 | 质感 | 结论 |
|---|---|---|---|
| JIMA12 @1.2 | 最稳 | 利落 | 单支基线 |
| JIMA12 0.9 + Jima 0.6 | 动作糊、姿势发僵 | 更软 | 不推荐 |
| JIMA12 0.6 + Jima 0.9 | 明显糊 | 最幼 | 不推荐 |
| **JIMA12 0.9 + Jima 0.5** | 稳 | 软糯 | ✅ 洛茜采用 |

要点：**两支触发词都要写进 `quality_prefix`**（`jimafg, jima`），少一个就等于少一支；
画师栈放在角色 LoRA **之前**（先画风后人）。

### 10.5 Windows 侧中文目录清理：用 `-EncodedCommand`

不要 `ssh win30902 'dir "D:\...\洛茜"'` —— 走 GBK 会把中文路径毁掉。可靠做法是把
PowerShell 脚本以 **UTF-16LE + base64** 打包：

```python
import base64, subprocess
ps = '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8\nRemove-Item -LiteralPath "D:\\...\\明日方舟终末地_洛茜" -Recurse -Force'
b64 = base64.b64encode(ps.encode("utf-16-le")).decode()
subprocess.run(["ssh","-o","BatchMode=yes","win30902", f"powershell -NoProfile -EncodedCommand {b64}"])
```

同一招也用于**列举**（`Get-ChildItem | Where-Object { $_.Name -like "*洛茜*" }`）。

### 10.6 别在 detached `screen` 里用裸 `python3`

macOS 上 `python3` 在那个环境里会落到 `xcrun` shim 上：
`xcrun: error: unable to load libxcrun (incompatible architecture)`。
detached 屏里一律写**绝对路径** `/opt/homebrew/bin/python3`。

### 10.7 排队预投：`presubmit_batch.py` + `collect_presubmitted.py`（2026-09-28 新增）

**默认的 `run_typhon_batch.py` 是「投一页 → 等一页 → 回传一页」。** 这有两个代价：

1. **GPU 空转** —— 每页渲染完到下一页投递之间有几秒往返；
2. **派发机一睡/一重启，队列就空了** —— 那一刻 ComfyUI 里只有一页，剩下的根本没进去。

所以长批次（>50 页）用**预投**：

```bash
# ① 一次性把未落地的页全部排队（174 页只花 ~15s）
tools/run_batch.sh presubmit_batch.py 明日方舟终末地_洛茜
tools/run_batch.sh presubmit_batch.py <作品> --dry     # 先看会投哪些
tools/run_batch.sh presubmit_batch.py <作品> --all     # 全部重投（含已落地）

# ② 守着收图（挂 detached 屏；派发机重启后重跑即可续收）
screen -dmS <名>_collect bash -lc 'cd <Studio> && exec /opt/homebrew/bin/python3 \
    tools/collect_presubmitted.py <作品> > /tmp/<名>_collect.log 2>&1'
```

要点：

| 项 | 说明 |
|---|---|
| **不是绕开引擎** | `presubmit_batch.py` import 同一个 `run_typhon_batch` 模块，逐页走 `parse_txt → resolve_preset → apply_preset → check_foot_preset → resolve_page_canvas → build_workflow → queue_prompt`；**唯一去掉的是 `wait_done()`** |
| 清单 | `<作品>/presubmit_manifest.json`（`prompt_id ↔ 页/seed/预设`），收集器靠它认领结果 |
| 幂等 | 预投默认只投 Mac 上**没有 png** 的页 ⇒ 随时可重跑 |
| 采样闸 | 预投同样过闸（踩脚页撞双彩会被拦下并记进 `gate_skipped`） |
| 队列在哪 | **在 Windows 的 ComfyUI 后端**，不依赖派发机活着 ⇒ 派发机重启不影响渲染 |
| 收图 | 收集器轮询 `/history/<pid>` → `fetch_images()` 回传；队列空但仍有缺口 ⇒ 重投 |
| 兜底 | 最后再跑一次 `mirror_output.py`，把没走 history 路径的图也拉齐 |

> 若在预投前有别的 `run_xxx_batch.py` 在跑，**先把它停掉**（否则两边同时投递，同一页渲染两次）。
> 一页一页跑的旧模式仍然可用（`run_typhon_batch.py`），它的价值是"每页立刻回传 + 失败隔离"；
> 预投模式的价值是"整批不依赖派发机 + GPU 不空转"。两者不要混跑。
