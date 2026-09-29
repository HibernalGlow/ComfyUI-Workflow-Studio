# 需求：让批量引擎支持 Anima in-context 参考图出图

> 状态：**待实现**。提出日期 2026-09-27。提出人：Toki 中秋故事板那次会话。
> 目标读者：接手改 `tools/run_typhon_batch.py` + `tools/story_config.py` 的模型/人。

---

## 0. 一句话

给共享批量引擎加**第三种 `arch`**（`anima-incontext`），让它能把作品 `batch.toml` 里的
参考图支路、逐页画布、追加自然语言段三样东西组进工作流 —— 使得「用 in-context 参考图出图」
这件事和现有的 11 个作品一样，只需要一个 **3 行 runner**。

---

## 1. 为什么现在不行（都是实测，不是推测）

机制本身**已经验证可用**：不给角色训 LoRA，用 2 张参考图 + 画师 LoRA，能稳定还原
角色的服装结构。`飞鸟马时` 中秋故事板 12 页已写完，单页实测 200–230 秒/张。

**但共享引擎完全够不到它**：

| 检查 | 结果 |
|---|---|
| `grep -ri "AnimaRef\|InContext"` 全仓 | **0 命中** |
| `grep -n "LoadImage\|VHS_\|ImageBatch"` in `run_typhon_batch.py` | **0 命中**（引擎里没有任何图像输入节点） |
| `grep -rn "page_canvas"` 全仓 | **0 命中**（分辨率是 `WIDTH`/`HEIGHT` 模块全局量，逐页无法改） |
| `story_config.load_story(toki batch.toml)` | `KeyError: 'pages_dir'`（schema 不兼容） |

于是当前这次只能靠在 `/tmp/toki_run/submit_page.py`（153 行手写脚本）里**重新实现一遍**：
组图、投递、轮询、取图。它不在仓库里、不在 git 里，`/tmp` 一清就没。
而它复制的正是引擎里已经有的 `queue_prompt` / `fetch_images` / `wait_done` / `parse_txt`。

**这就是本次改动的全部理由：不要再手写第 N 个 /tmp 脚本。**

---

## 2. 三个需求

### R1 — `[incontext]` 段 + 第三种 arch

**要什么**：作品 `batch.toml` 里能这样写，引擎据此组出参考图支路。

```toml
[base]
arch  = "anima-incontext"
unet  = 'kirazuriAnima_v40\anima-kirazuri-v4-int8-convrot.safetensors'

  # 顺序 = 入栈顺序。in-context 机制 LoRA 也是普通 LoRA，放这里。
  [[base.loras]]
  name         = "Anima in-context"
  path         = 'anima\anima-incontext-character.safetensors'
  model_weight = 1.0

  [[base.loras]]
  name         = "modare"
  path         = 'anima\artist\260613\modare\anime_modare.safetensors'
  model_weight = 1.0

[incontext]
strength      = 1.0
start_percent = 0.0
end_percent   = 0.90      # 姿势旋钮，见 §4
cond_only     = true
ref_timestep  = 0.0

  [[incontext.refs]]      # 第 1 张：fit_mode 仅在单参考时生效
  image    = "toki_ref_face.png"
  fit_mode = "pad"

  [[incontext.refs]]      # 第 2 张起用 pad
  image    = "toki_ref_sit.png"
  fit_mode = "pad"
```

**怎么改**

1. `tools/story_config.py`：读 `cfg["incontext"]` → `rtb.INCONTEXT`（dict，缺省 `{}`），
   `refs` 保持列表顺序。路径**不做**相对解析（参考图是 ComfyUI `input/` 下的文件名，
   不是文件路径）。`base.get("arch")` 已存在，直接能传 `"anima-incontext"`。
2. `tools/run_typhon_batch.py` 的 `build_workflow()`：加 `elif ARCH == "anima-incontext":` 分支。

**⚠️ 硬约束：新增分支，不许改现有的 `anima` 分支。**
现有 `anima` 分支被 11 个作品依赖（提丰 60 / 洛茜 190 / 念念 100 / 琴柳 100 …）。
参考图这条链是一次性跑通的，**逐字照抄 §5 的 proven graph** 比「改 anima 分支让它兼容更好」。

**N 张参考**：`AnimaRefLatentBatch` 只有 `ref_latent_1` / `ref_latent_2` **两个**输入。
1 张 → `AnimaRefEncode` 直连 `AnimaInContextApply.ref_latent`；
≥2 张 → 先过 `AnimaRefLatentBatch`；>2 张 → **串联多个 batch 节点**
（前一个的输出接后一个的 `ref_latent_1`）。实测标准配置是 2 张，>2 张时显存要留意（8GB）。

---

### R2 — 逐页画布 + 逐页 `end_percent`

**要什么**：

```toml
[[page_canvas]]
page = "001"
width = 832
height = 1216
end_percent = 0.95

[[page_canvas]]
page = "008"
width = 1216
height = 832
end_percent = 0.80
```

按页前缀码（`page.stem.split("—")[0]`）覆盖 `WIDTH` / `HEIGHT` / `[incontext] end_percent`。
没写的页回落到 `[base] width/height` + `[incontext] end_percent`。

**为什么不能省**

- `飞鸟马时` 12 页用了 **3 种画幅**：832×1216（立绘）、1024×1024（半身）、1216×832（足交横构图）。
  全局一个分辨率 = 3 页构图全错。
- **机制上强制**：`AnimaRefEncode.target_width/height` **必须等于**该页生成分辨率，
  否则参考 latent 与目标 latent 尺寸不匹配。所以逐页画布不是便利功能，是这条链的前提。
- `end_percent` 是逐页的（001 用 0.95，008 用 0.80），见 §4。

**怎么改**：在 `main()` 的页循环里，`parse_txt()` 之前解析本页 canvas，覆盖全局量，
并让 `build_workflow()` 把本页 W/H 传给 `AnimaRefEncode` 与 `EmptyLatentImage`。
**注意顺序**：`resolve_preset()` / `apply_preset()` 会重写 `STEPS/CFG/SAMPLER/...`，
但**不碰** `WIDTH/HEIGHT` —— 逐页 canvas 必须在那之后应用，否则会被预设覆盖掉。

---

### R3 — `[prompt] nl_append`：每页追加一段自然语言

**要什么**：

```toml
[prompt]
nl_append = "Toki's mid-autumn outfit is white with very pale ice-blue panels and thin gold trim: ..."
```

在 `parse_txt()` 拼完 `quality_prefix + tags + caption` 之后，把这段追加到正向提示词末尾。

**为什么必需（这是本管线与 storyboard 技能的**结构性冲突**，务必照做）**

两条规则同时成立时会把服装要求**清空**：

- storyboard 技能 §13.4：caption **不要复述** `[tags]` 里已有的服装锚点。
- in-context 交接文档：**颜色只写自然语言、不写进 `[tags]`**（`blue thighhighs` 会被画成深蓝，
  跟参考图打架）。

→ `[tags]` 里既没有颜色也没有材质，caption 又按规矩不复述服装，
结果整条 prompt 里**没有任何一处要求「宽大分离广袖 / 腰带蓝花金流苏 / 大腿袜」**，
模型只能照参考图脑补，参考强度一降就散架。

**证据（同 seed、同 end_percent、同底模，唯一变量就是这句话）**：

| 010 页两发 | 广袖 | 腰带花+流苏 | 大腿根金环 | 金四瓣花头饰 |
|---|---|---|---|---|
| `end_percent` 0.75 vs 0.90（都不带追加句） | ❌ 退成细袖套 | ❌ 丢 | ❌ 退成小腿套 | ❌ 丢 |
| 同页 + 追加句 | ✅ | ✅ | ✅ | ✅ |

**顺带推翻一个错误结论**：本来以为「服装丢」是 `end_percent` 太低造成的，
用 0.75 和 0.90 各跑一发，服装损坏**完全一样** → 不是参考强度问题，
是 prompt 从没要求过那几件东西。所以 R3 是必需的，不能靠调 R1 的参数绕过。

> 这一条**不限于 in-context**：任何「caption 不复述标签 + 颜色只进 caption」的作品都适用。
> 建议放在 `parse_txt()` 里，与 `PROMPT_REPLACE` 同级，所有作品可用。

---

## 3. 非目标（明确不要做）

| 不做 | 理由 |
|---|---|
| **不要做前端/UI**（GenUI 预设里选参考图、可视化 in-context 面板） | 实际工作流是「agent 读 batch.toml → 命令行跑批」。加 UI = 前端 + 预设 schema + 路由三处改动，收益为零。 |
| 不要改 `anima` / `illus` 两个现有分支 | 11 个作品在跑。新 arch 独立。 |
| 不要动 `gen_presets.json` 的 schema | 预设只承载采样/LoRA/质量词；参考图属于作品级配置，放 `batch.toml`。 |
| 不要试图用引擎解决「两人重叠插入糊成一团」 | 那是**分辨率+显存的上限**，不是组图问题。见 §4。 |

---

## 4. 已知机制上限（写进文档，别让后来者重复踩）

1. **`end_percent` 是姿势旋钮**：1.0 = 把参考姿势整套复印（提示词里的新姿势失效）；
   0.7 = 听话但衣服细节丢；参考姿势与目标一致时用 0.95。
   实测 0.75 与 0.90 在「坐姿 → 骑乘」（同属坐姿族）下姿势都能过，0.90 服装更完整。
   真正需要 0.75 的是**跨族**（坐姿 → 仰躺折腿压腹）。
2. **两人身体大面积重叠时，男方必糊成一块无面肉块** —— 接合处阴茎与阴部接不上。
   对比：骑乘（男方只在后方、不压在她身上）→ 男方渲染完全正常。
   三种姿势（mating press / cowboy shot / missionary）× 两种景别都试过，修不好。
   **这是 8GB + 2 参考 + ~1.0MP 的上限。** 正确修法是改设计（`pov`，或改成单人页），
   不是加旋钮。
3. **构图陷阱**：`cowboy shot` 用在两人重叠页上**比 `full body` 更差** ——
   收紧画幅把没解决的解剖放大到满屏。别想当然地"切近点遮丑"。
4. **每件要还原的衣服/颜色必须至少出现在一张参考图里。** 只喂半身图 → 裙子袜子颜色没人提供，
   模型照标签瞎编（实测把袜子画成深蓝）。
5. **两张参考别来自同一张图的两次裁切** —— 会变成复印机。

---

## 5. 参考实现（proven graph，照抄）

来自已跑通 200–230 秒/张的 `/tmp/toki_run/submit_page.py`。
节点 ID 可以按引擎惯例重排，但**连接关系与参数必须一致**。

```
 1 UNETLoader            unet_name=UNET, weight_dtype="default"
 2 LoraLoaderModelOnly   model=[1,0], lora_name=<base.loras[0]>, strength_model=1.0
 3 LoraLoaderModelOnly   model=[2,0], lora_name=<base.loras[1]>, strength_model=1.0
   ...（[[base.loras]] 逐个串下去，保持顺序）
 4 CLIPLoader            clip_name="qwen_3_06b_base.safetensors", type="stable_diffusion"
 5 VAELoader             vae_name="qwen_image_vae.safetensors"
20 CLIPTextEncode        clip=[4,0], text=<quality_prefix + tags + caption + nl_append>
21 CLIPTextEncode        clip=[4,0], text=<negative>
30 EmptyLatentImage      width=W, height=H, batch_size=1
40 KSampler              model=[15,0], positive=[20,0], negative=[21,0],
                         latent_image=[30,0], seed=SEED,
                         steps/cfg/sampler_name/scheduler/denoise=<[sampling]>,
                         denoise=1.0
50 VAEDecode            samples=[40,0], vae=[5,0]
60 SaveImage            images=[50,0], filename_prefix=<output_subdir>/<stem>

# ── 参考支路（每张参考一组）──
10 LoadImage            image=<refs[0].image>
12 AnimaRefEncode       vae=[5,0], image=[10,0], target_width=W, target_height=H
11 LoadImage            image=<refs[1].image>
13 AnimaRefEncode       vae=[5,0], image=[11,0], target_width=W, target_height=H
14 AnimaRefLatentBatch  ref_latent_1=[12,0], ref_latent_2=[13,0], fit_mode="pad"

15 AnimaInContextApply  model=[<最后一个 LoRA 节点>,0], ref_latent=[14,0],
                        strength=1.0, start_percent=0.0, end_percent=<本页>,
                        cond_only=True, fit_mode="pad", ref_timestep=0.0
```

**关键点**

- `AnimaInContextApply` 必须**接在 LoRA 链之后**、进 `KSampler` 之前。
- 单参考时 `ref_latent = AnimaRefEncode` 直接输出，不过 batch 节点。
- 引擎现有 `anima` 分支用 `CR LoRA Stack` + `FLS_SamplerV4`，
  **这条新链用 `LoraLoaderModelOnly` 链 + `KSampler`**（上面这份是实测跑通的组合）。
  不要为了复用而换成 `CR Apply LoRA Stack` —— 那需要重新验证，收益为零。
- `AnimaRefEncode` 有个 optional `mask` 输入，不用管。

---

## 6. 验收闸

**必须全绿才算完成。**

1. **零回归**：`tools/dryrun_batch.py` 对现有 11 个作品的输出与改动前**逐字节相同**。
   （`batch.toml` 没有 `[incontext]` / 没写 `arch = "anima-incontext"` → 走的还是原分支。）
2. **干跑能看见参考图**：对 toki 作品跑 `--dry-run`，输出里能列出
   每页画幅、`end_percent`、参考图文件名、以及 `nl_append` 是否生效。
3. **dryrun 新闸（建议一并加）**：`ARCH == "anima-incontext"` 时校验
   `[incontext].refs[].image` 都出现在 `GET /object_info/LoadImage` 的 `image` 列表里；
   缺图**退出码 1**（`--warn-only` 可降级）。再加两条软提醒：
   只有 1 张参考（有衣服看不到 → 模型会编）、两张参考来自同一张源图（复印机风险）。
   > 这一条精准拦住已经踩过的「袜子被画成深蓝」那一类 —— 只喂半身图。
4. **实跑一页可复现**：`飞鸟马时` 010 页（832×1216 / end 0.90 / 带 nl_append / anime_modare @1.0 /
   seed 424242）通过引擎跑出来的图，与手写脚本的产物**同量级**（服装锚定件齐全：
   宽大分离广袖、腰带金花+流苏、大腿根金环、金四瓣花头饰）。
5. **toki runner 缩到 3 行**：照 `tools/run_niannian_batch.py` 的样子，
   只改 `TOML = Path(...)` 一行。

---

## 7. 提需求方同时要做的两件事（不用他人代劳）

1. **修 `飞鸟马时/batch.toml`**：现在它**不是合法 TOML** ——
   `[[page_canvas]]` 那几行用了 `page = "001"; width = 832; ...` 的分号写法，
   TOML 要求换行分隔（`tomllib` 报 `line 112, column 13`）。
   刚写的时候它只是「给人看的配置」，任何脚本都读不了。
   同时 schema 要改成引擎的 `[paths]` / `[base]` / `[incontext]` / `[page_canvas]`。
2. **`/tmp/toki_run/submit_page.py` 入库**（或按 §6.5 直接删除，改用 3 行 runner）。

---

## 8. 相关文件

| 文件 | 作用 |
|---|---|
| `tools/run_typhon_batch.py` | 共享引擎。**加 `elif ARCH == "anima-incontext":` 分支**（§2 R1） |
| `tools/story_config.py` | TOML 装载器。**加 `[incontext]` / `[page_canvas]` / `[prompt] nl_append` 读取** |
| `tools/dryrun_batch.py` | 干跑校验。**加参考图存在性闸**（§6.3） |
| `tools/run_niannian_batch.py` | 3 行 runner 模板（toki 照抄） |
| `docs/BATCH-DISPATCH.md` | 派发主文档。完成后**加一节 §6.13 in-context 出图**，把 §4 的上限写进去 |
| `../ComfyUI/anima-incontext-handoff.md` | in-context 机制本身的交接文档（在 Studio 仓库外） |
