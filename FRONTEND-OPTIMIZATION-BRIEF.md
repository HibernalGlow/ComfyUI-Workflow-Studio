# 任务：ComfyUI-Workflow-Studio — core + newui 架构重构（最终版）

## 已定决策（不要再改）

| # | 决策 | 内容 |
|---|---|---|
| 1 | **桥接方案 A** | `static/newui.html`，通过已有静态路由访问 `/wfm_static/newui.html`。**`py/` 后端零改动** |
| 2 | **不做动态取色** | 不引 `@material/material-color-utilities` 运行时。`theme-m3.css` 全部为离线生成的静态值 |
| 3 | **models 子系统要在 newui 重建** | 分组 / 标签 / 徽章 / 详情 / 批量 / 收藏 / 启用禁用 / Civitai / 元数据 / 分页 / 缩略图+表格双视图 |
| 4 | **i18n 沿用上游 `t()`** | 不新建独立字典，直接 re-export 上游 `static/js/i18n.js` |

**架构方针**：`core`（保留上游无 DOM 的部分）+ `newui`（全新 M3 UI）。`newui` 只依赖 `core/index.js`，**DOM-ID 契约 = 0**。

**禁止引入 React / Svelte / Vue / Tailwind / 任何组件库 / 任何打包器。**

---

## 0. 上游合并约束（硬性）

上游 = `ketle-man/ComfyUI-Workflow-Studio`，近 100 commit 覆盖 2026-08 ~ 2026-09，平均每 1–6 天一个 release。

| 约束 | 说明 |
|---|---|
| 上游属有文件**不得重构** | 不重排、不重命名、不抽取函数、不改 import 结构 |
| **P5 之前禁止删除任何上游文件** | 旧 UI 必须可完整回退 |
| **禁止修改 `py/`** | 方案 A 下后端零改动 |
| 新增代码一律放新文件 | `static/js/core/**`、`static/js/newui/**`、`static/css/newui/**`、`static/newui.html` |
| 禁止 `!important` 叠加 | 旧 `static/css/main.css` 已有 30 个 |

### 上游改动面实测（近 100 commit）

| 上游改动的对象 | 频率 | 你的成本 |
|---|---|---|
| 后端 `py/` | 25% | **0** |
| `static/js/comfyui-workflow.js` | 13% | **0** |
| `static/js/comfyui-client.js` | 2% | **0** |
| `static/js/util.js` | 4% | **0** |
| `static/js/i18n.js` | 48% | **0**（`t()` 词典自动继承） |
| `templates/index.html` | 49% | **0**（你用新建的 `newui.html`） |
| 只动已弃用 tab（Video/Image Edit/Tagger/Nodes/Metadata/AI/Feeder） | 11% | **0** |
| **动了保留 tab 的 UI**（generate / gallery / workflow / settings / prompt / models） | **38%** | ⚠️ **手工 port 到 newui —— 本架构唯一永久税** |

**合并冲突 = 0**，代价是 38% 的上游 commit 需人工把 UI 侧修复搬进 `newui/`。必须接受。

---

## 1. 现有代码实测（直接采信）

### 1.1 架构
- 后端：`aiohttp`（ComfyUI `PromptServer`）插件。`__init__.py` → `py/wfm.py` → `py/routes/*.py` / `py/services/*.py`
- 前端：vanilla ESM，**无构建步骤**。`templates/index.html`（3482 行）+ `static/js/*.js`（60 文件 / 42999 行）+ `static/css/*.css`（6 文件 / 9208 行）
- 静态路由：`py/wfm.py:87` → `app.router.add_static("/wfm_static", str(STATIC_DIR))`。**`static/` 下任何新文件自动可访问**
- 旧入口：`templates/index.html:3475` → `<script type="module" src="/wfm_static/js/app.js">`，页面 URL 为 `/wfm`

### 1.2 新 UI 的启动前提（必读，否则连不上 ComfyUI）

```js
import { getSettings } from "./core/settings.js";   // → static/js/util.js
import { comfyUI }     from "./core/client.js";      // → static/js/comfyui-client.js

// 1) 设置来自 localStorage 的 "wfm_settings"（与旧 UI 共用，可自动继承用户已保存的 URL）
const s = getSettings();
comfyUI.updateUrl(s.comfyuiUrl || window.location.origin);

// 2) 旧 UI 在 generate-tab.js:2117 与 settings-tab.js:1205/1349/1357 做同样的事
```

`comfyUI.baseUrl` 默认 `""`（同源即可）；`comfyUI.wsUrl` 由 `updateUrl()` 从 `http` 换成 `ws`。
`newui.html` 与 `/wfm` **同源**，因此 localStorage 共享、WS 无跨域问题。

### 1.3 现有技术债（newui 不得重犯）

- 19 个 token（`static/css/main.css:6-24`）被 1108 处引用；其中 **5 个变量未定义且无 fallback**，导致 **29 处声明静默失效**：
  `--wfm-text-primary`（24 处）、`--wfm-hover`（2）、`--wfm-bg-hover`（1）、`--wfm-surface-2`（1）、`--wfm-text-muted`（1）
- 51 处 `var()` 内硬编码 hex 兜底（gallery-tab 29 / main 18 / video-tab 4）
- 256 处 JS 内联硬编码颜色
- `main.css` 30 个 `!important`
- 13 个主题靠 `settings-tab.js:57-72` 的 `THEMES` + `[data-theme]` 切换

### 1.4 DOM 耦合度实测（决定 core/newui 的 seam）

计数口径：`getElementById` / `querySelector` / `innerHTML` / `createElement` / `appendChild`

| 模块 | 行数 | DOM 触点 | 判定 |
|---|---|---|---|
| `py/**`（全部后端） | **10230** | **0** | ★ CORE |
| `static/js/comfyui-workflow.js` | 1704 | **0** | ★ CORE |
| `static/js/i18n.js` | 4471 | **0** | ★ CORE |
| `static/js/comfyui-client.js` | 378 | 3 | ★ CORE |
| `static/js/util.js` | 227 | 4 | ★ CORE |
| `static/js/json-highlight.js` | 73 | 1 | ★ CORE |
| `static/js/generate-tab.js` | 2460 | 281 | 重写 |
| `static/js/comfyui-editor.js` | 2363 | 295 | 重写 |
| `static/js/gallery-tab.js` | 2362 | 325 | 重写 |
| `static/js/settings-tab.js` | 1559 | 186 | 重写 |
| `static/js/workflow-tab.js` | 1495 | 164 | 重写 |
| `static/js/app.js` | 895 | 165 | 重写 |
| `static/js/models-tab.js` + `models/*`（7 文件） | 1930 | ~230 | 重写 |
| `static/js/prompt-*.js` | 1800 | ~250 | 重写 |

**CORE 小计 ≈ 17230 行。结论：业务逻辑已在后端，前端大部分是 DOM 操作。**

### 1.5 需从 UI 模块抢救的纯逻辑（约 800 行）

`static/js/generate-tab.js` 里 DOM 触点 ≤2 的函数：

```
批次选择状态机（约 30 个 helper）                  约 350 行   DOM=0
_applyNamedStyle + _applyStyleToWorkflow              56 行    DOM=2
_expandWildcardsInWorkflow + _expandWildcardText      75 行    DOM=0
_runBatchGenerate                                     195 行   DOM=2
_runBatchLoop                                          72 行   DOM=10
_loadStyles + _loadBatch*Groups                       120 行   DOM=0
_fetchOutputDir / saveGeneratedImagesMeta / _applyDefaultCheckpointIfEnabled   53 行  DOM=0
```

**做法：抄逻辑，不抄 DOM。** 可参考上游实现，但 `core/` 内不得出现任何 DOM API。

---

## 2. core/ 设计

### 2.1 目录

```
static/js/core/
  index.js          统一出口 —— newui 只允许 import 这个文件
  client.js         re-export comfyUI          ← ../comfyui-client.js
  workflow.js       re-export comfyWorkflow    ← ../comfyui-workflow.js
  i18n.js           re-export t / initI18n     ← ../i18n.js        （决策 4）
  settings.js       re-export getSettings / readJsonStorage / escapeHtml  ← ../util.js
  json.js           re-export json-highlight   ← ../json-highlight.js
  model-constants.js  静态映射表（从 models/state.js 抄：FETCH_MAP / TYPE_LABELS / GENUI_TYPE_MAP
                      / RESERVED_GROUPS / BATCH_MODEL_TYPES / STACK_MODEL_TYPES，约 60 行）
  api.js            所有 /api/wfm/* 端点封装 —— 唯一的网络层
  pipeline.js       生成编排（原 _coreGenerate 去掉 DOM 后约 120 行）
  style.js          _applyNamedStyle / _applyStyleToWorkflow
  wildcard.js       _expandWildcardsInWorkflow / _expandWildcardText
  lora.js           故事分镜解析 → LoRA 匹配 → POST /api/wfm/lora/apply
  batch.js          批次选择状态机 + 分组加载
  models.js         模型元数据 / 分组 / 徽章 / 禁用 / 收藏 / Civitai 的读写封装
  image.js          blob→dataUrl / 输出目录 / 结果元数据
```

### 2.2 硬性规则

1. **`core/` 内零 DOM**。允许 `fetch` / `WebSocket`（`comfyui-client.js` 内部已有，re-export 即可）。
   验收：`grep -rnE '\bdocument\.|\bwindow\.|getElementById|querySelector|innerHTML' static/js/core/` → **0 命中**
2. **`core/` 的上游依赖白名单**（只有这 6 个）：
   ```
   ../comfyui-client.js   ../comfyui-workflow.js   ../i18n.js
   ../util.js             ../json-highlight.js
   ```
   注意：**不要 import `../models/state.js`**——它含可变 `state` 且会读 `localStorage.getItem("wfm_models_view")`，与旧 UI 抢同一个 key。静态映射表请抄进 `core/model-constants.js`。
3. **`core/` 不抛 UI 概念**。进度用回调，成败用返回值/Promise reject。不 toast、不弹窗、不操作 DOM。
4. **所有后端交互只走 `core/api.js`**。newui 里出现裸 `fetch("/api/wfm/...")` 视为违规。
5. `core/pipeline.js` 建议签名：
   ```js
   /**
    * @param {{workflow:object, prompt?:string, negative?:string,
    *          seedMode?:'random'|'fixed', seedValue?:number,
    *          styleName?:string, storyLoras?:Array, autoInjectLoras?:boolean,
    *          onProgress?:(pct:number,msg:string)=>void,
    *          signal?:AbortSignal}} opts
    * @returns {Promise<{images:Array, seed:number, svgOutputs:Array, workflow:object}>}
    */
   export async function runGeneration(opts)
   ```
   `workflow` 由调用方传入、结果回传实际使用的 workflow —— newui 掌握状态，core 保持无状态。
6. **`core/CONTRACT.md`** 是 P0 交付物：每个导出函数的签名 / 输入 / 输出 / 错误 / 后端依赖。

---

## 3. newui/ 设计

### 3.1 目录

```
static/js/newui/
  main.js                     挂载入口（只 import core/index.js）
  router.js                   tab 路由
  store.js                    UI 状态（订阅式，不引第三方状态库）
  a11y.js                     焦点陷阱 / roving tabindex / 键盘导航工具
  ripple.js                   M3 Ripple（pointerdown + element.animate）
  snackbar.js                 M3 Snackbar 宿主
  dialog.js                   M3 Dialog 宿主
  components/                 （22 个）
    Button.js  IconButton.js  Fab.js
    TextField.js  Select.js  Slider.js  Switch.js  Checkbox.js  Radio.js
    Chip.js  Card.js  Dialog.js  Menu.js  Tooltip.js  Snackbar.js
    Tabs.js  NavigationRail.js  List.js  DataTable.js  Progress.js
    SegmentedButtons.js
  views/
    workflow.js
    generate.js               含 Batch 面板（消费 core/batch.js）
    prompt.js
    gallery.js
    settings.js               含 Gen Presets + 主题选择
    models/                   ★ 决策 3：在 newui 重建
      index.js
      state.js                自己的状态（不与 models/state.js 共用 key）
      filters.js  sort.js  tags.js  badges.js  groups.js
      grid-view.js  table-view.js  detail-panel.js  civitai.js
      bulk-actions.js  preview.js

static/css/newui/
  m3-tokens.css               M3 三阶 token
  theme-m3.css                M3 配色（离线生成；dark + light + prefers-color-scheme）
  m3-layout.css               Navigation Rail + Top App Bar + 响应式
  m3-components.css           组件样式
  newui.css                   @import 汇总 —— HTML 只引这一个

static/newui.html             新 shell（DOM-ID 契约 = 0）
```

### 3.2 硬性规则

1. **禁止 import 上游 UI 模块**：
   ```bash
   grep -rE 'from "\.\.?/(generate-tab|gallery-tab|workflow-tab|settings-tab|comfyui-editor|prompt-|models-tab|models/|app)' static/js/newui/
   # 必须 0 命中
   ```
2. **禁止复用旧 CSS 类名**（`.wfm-*` 一律不用），新建命名空间 `.m3-*` / `.nu-*`。这样与 `main.css` 完全隔离，新旧 UI 可并存。
3. **不引第三方运行时依赖**（决策 2）。
4. **禁止内联硬编码颜色**：`grep -rnE '#[0-9a-fA-F]{3,8}\b|rgba?\(' static/js/newui/` → **0**。颜色一律走 `var(--md-sys-color-*)`。
5. **禁止 `!important`**。
6. **i18n 一律用 `import { t } from "../core/i18n.js"`**（决策 4）。新增文案时，若上游 `i18n.js` 已有对应 key 就直接用；没有则用 `t("key", "fallback")` 形式，不修改 `i18n.js`。
7. `static/newui.html` 内所有资源路径用绝对路径 `/wfm_static/...`。

### 3.3 M3 token（必须三阶，且维度完整）

```css
/* 1) Reference —— 原始调色板，只被 system 层引用 */
:root { --md-ref-palette-primary-40: oklch(...); /* ... */ }

/* 2) System —— 语义色，newui 只允许用这一层 */
:root {
  --md-sys-color-primary / on-primary / primary-container / on-primary-container
  --md-sys-color-secondary* / tertiary* / error*
  --md-sys-color-surface / on-surface / surface-variant / on-surface-variant
  --md-sys-color-surface-container-{lowest,low,high,highest}
  --md-sys-color-outline / outline-variant / scrim / inverse-surface / inverse-on-surface
}

/* 3) Component —— 组件专属，组件 CSS 只允许用这一层 */
:root { --md-comp-filled-button-container-color: var(--md-sys-color-primary); /* ... */ }
```

必须补齐旧 UI 完全缺失的维度：

```css
:root {
  /* Shape 7 档 */
  --md-sys-shape-corner-none: 0;
  --md-sys-shape-corner-xs: 4px;   --md-sys-shape-corner-sm: 8px;
  --md-sys-shape-corner-md: 12px;  --md-sys-shape-corner-lg: 16px;
  --md-sys-shape-corner-xl: 28px;  --md-sys-shape-corner-full: 9999px;

  /* Elevation 6 档 */
  --md-sys-elevation-level0: none;
  --md-sys-elevation-level1: 0 1px 2px rgba(0,0,0,.30), 0 1px 3px 1px rgba(0,0,0,.15);
  /* level2..level5 */

  /* Typescale 15 role */
  --md-sys-typescale-display-large / headline-{large,medium,small}
  --md-sys-typescale-title-{large,medium,small}
  --md-sys-typescale-body-{large,medium,small}
  --md-sys-typescale-label-{large,medium,small}
  /* 每项形如: 400 57px/64px system-ui */

  /* Motion */
  --md-sys-motion-duration-short1: 50ms;  --md-sys-motion-duration-short4: 200ms;
  --md-sys-motion-duration-medium2: 300ms; --md-sys-motion-duration-long2: 500ms;
  --md-sys-motion-easing-standard: cubic-bezier(0.2, 0, 0, 1);
  --md-sys-motion-easing-emphasized: cubic-bezier(0.2, 0, 0, 1);

  /* State layer 不透明度 */
  --md-sys-state-hover-opacity: .08;
  --md-sys-state-focus-opacity: .12;
  --md-sys-state-pressed-opacity: .12;
  --md-sys-state-dragged-opacity: .16;
}
```

### 3.4 State layer（M3 手感核心，必须实现）

```css
.m3-btn { position: relative; overflow: hidden; isolation: isolate; }
.m3-btn::before {
  content: ""; position: absolute; inset: 0; z-index: -1;
  background: currentColor; opacity: 0; pointer-events: none;
  transition: opacity var(--md-sys-motion-duration-short2) var(--md-sys-motion-easing-standard);
}
.m3-btn:hover::before         { opacity: var(--md-sys-state-hover-opacity); }
.m3-btn:focus-visible::before { opacity: var(--md-sys-state-focus-opacity); }
.m3-btn:active::before        { opacity: var(--md-sys-state-pressed-opacity); }
```

同样覆盖：navigation rail item / list item / menu item / tab / icon button / chip / segmented button。

### 3.5 布局

```html
<body class="nu-body">
  <header class="m3-top-app-bar">…</header>
  <nav class="m3-navigation-rail">…</nav>
  <main class="nu-main" id="nu-view-root"></main>
  <div class="m3-snackbar-host"></div>
  <div class="m3-dialog-host"></div>
</body>
```

Navigation Rail 在窄视口（<840px）折叠为仅图标；Top App Bar 在小屏显示当前视图标题。

### 3.6 Select（渐进增强）

先保证原生 `<select>` 可用（键盘、屏幕阅读器、`change` 事件），再叠加 M3 menu。可用 `appearance: base-select`（Chrome 135+）作为纯 CSS 方案，降级到原生控件。选中后必须派发 `change`。

### 3.7 可访问性

- 所有交互组件键盘可达（Tab / Enter / Space / Esc / 方向键 / Home / End）
- Dialog：焦点陷阱 + `aria-modal="true"` + 关闭后恢复焦点
- Navigation Rail：`<nav>` + `aria-current="page"`
- 状态类组件：`aria-pressed` / `aria-checked` / `role="switch"`
- 焦点环用 `:focus-visible`，不得 `outline: none` 了事

---

## 4. models 子系统规格（决策 3，必须在 newui 完整重建）

上游实现：`static/js/models-tab.js`（593 行）+ `models/{state,filters,grid-view,badges,detail-panel,selection-bulk,helpers}.js`（1337 行）。**newui 重写，不得 import 它们。**

| # | 功能 | 上游来源 | newui 落点 |
|---|---|---|---|
| 1 | **8 种模型类型**：checkpoint / lora / vae / controlnet / unet / textencoder / hypernetwork / embedding | `models/state.js` `FETCH_MAP` / `TYPE_LABELS` | `core/model-constants.js` + `views/models/index.js` |
| 2 | **缩略图网格视图** + **表格视图**（双视图切换，记忆到 newui 自己的 localStorage key） | `models/grid-view.js` `renderThumbView` / `renderTableView` | `views/models/grid-view.js` / `table-view.js` |
| 3 | **9 列排序**：fav / filename / subdir / civtype / basemodel / ext / tags / memo / enabled | `models/filters.js` `sortKeyOf` / `sortModels`、`grid-view.js` `thSortHtml` | `views/models/sort.js` |
| 4 | **筛选**：搜索 / tag / badge / dir / group / status(all\|enabled\|disabled) / 仅收藏 / 仅 Batch | `models/filters.js` `filterModels` / `render*Filter` | `views/models/filters.js` |
| 5 | **分组**：保留组 `["Batch","Stack"]` + 自定义组，按类型隔离（`allModelGroups`） | `models-tab.js` `fetchModelGroups` / `saveModelGroups` / `toggleGroupEnable` | `views/models/groups.js` |
| 6 | **标签**：从 metadata 聚合全部 tag，作为筛选与编辑项 | `models/filters.js` `getAllTags` | `views/models/tags.js` |
| 7 | **徽章**：可编辑调色板、徽章渲染、徽章筛选、批量加/去徽章 | `models/badges.js` `getBadgePalette` / `saveBadgePalette` / `badgeHtml` / `openBadgeEditModal` / `renderBadgeFilter` | `views/models/badges.js` |
| 8 | **详情面板**：侧栏信息（路径/尺寸/扩展名/子目录/标签/备忘）+ 分组编辑 | `models/detail-panel.js` `showSidePanel` / `renderSideInfo` / `renderSideGroup` | `views/models/detail-panel.js` |
| 9 | **Civitai 集成**：单模型拉取、缓存、批量拉取、信息展示 | `models/detail-panel.js` `fetchCivitaiForModel` / `fetchCivitaiCache` / `batchFetchCivitai`、后端 `civitai_service.py` | `views/models/civitai.js` |
| 10 | **启用/禁用**：单模型与整组切换、`disabledModels` 集合、status 筛选联动 | `models-tab.js` `toggleModelEnable` / `toggleGroupEnable` / `fetchDisabledModels` | `views/models/state.js` |
| 11 | **批量操作**：多选模式 / 全选 / 清空 / 加入组 / 移出组 / 批量收藏 / 批量加去徽章 / 批量删除 / 批量移动到子目录 | `models/selection-bulk.js`（12 个导出） | `views/models/bulk-actions.js` |
| 12 | **收藏**：单模型与批量收藏 | `models/grid-view.js` `toggleFavorite` | `views/models/grid-view.js` |
| 13 | **Batch / Stack 分组开关**：`toggleBatch` / `clearBatchGroup` / `toggleStack` / `clearStackGroup`（被 GenerateUI 的 Batch 面板消费） | `models/grid-view.js` | `views/models/groups.js` + `core/batch.js` |
| 14 | **应用到 GenerateUI**：`applyToGenUI(modelName, modelType)` / `applyEmbeddingToPrompt` | `models-tab.js:20,132` | `core/api.js` 暴露，由 `views/generate.js` 消费 |
| 15 | **元数据读写**：tags / memo / favorite / badges 持久化 | `models-tab.js` `fetchModelMetadata` / `saveModelMetadata` | `core/models.js` |
| 16 | **分页** | `models/state.js` `currentPage` | `views/models/index.js` |
| 17 | **预览图懒加载** | `models/helpers.js` `previewUrl` / `loadPreview` | `views/models/preview.js` |
| 18 | **子目录**：列出 + 批量移动 | `models/selection-bulk.js` `fetchSubdirs` / `bulkMoveModels` | `views/models/bulk-actions.js` |

**注意 1**：`views/models/state.js` 必须用 **newui 自己的 localStorage key**（例如 `nu_models_view`），不要读写上游的 `wfm_models_view`，否则新旧 UI 会互相覆盖视图模式。
**注意 2**：`applyToGenUI` 是 models ↔ generate 的桥。在 newui 里它应该是 `core/` 暴露的一个纯函数调用 + `store` 更新，不要做成跨视图直接 DOM 操作。
**注意 3**：`previewUrl` 用后端 `/api/wfm/models/preview?type=…&name=…`；上游注释说明用 `img.onload/onerror` 而非 HEAD 请求（aiohttp 的 `add_get` 不自动处理 HEAD），**newui 必须沿用这个做法**。

---

## 5. 保留的 tab 范围

**在 newui 实现（6 个导航项）**：`Workflow`、`Generate`、`Models`、`Prompt`、`Gallery`、`Settings`

**不在 newui 出现（旧 UI 保留，P5 之前不删）**：
`Nodes`、`Image Edit`、`Video`、`Tagger`、`Metadata`、`AI TOOL`、`Feeder`、`Help`
以及 GenerateUI 内部的 `Lab` 子标签、`Prompt` 的 `Table` 视图。

---

## 6. 功能不变 — 12 项对照表（P0 冻结，P5 前必须全绿）

| # | 功能 | 上游实现位置 | newui 实现位置 | 验证方式 |
|---|---|---|---|---|
| 1 | 加载 workflow JSON 并生成参数表单 | `generate-tab.js:223` + `comfyui-editor.js` | `core/workflow.js` + `views/generate.js` | 选 3 个 workflow，比对生成的字段数与名称 |
| 2 | UI↔API 格式互转 | `comfyui-workflow.js` | **原样复用** | 同一 JSON 转两次结果一致 |
| 3 | 提交 `/prompt` + WS 进度 | `comfyui-client.js` | **原样复用** | 出图并观察进度 0→100% |
| 4 | 故事分镜 LoRA 自动注入 | `generate-tab.js:1502` + `prompt-story-lora.js` | `core/lora.js` | 加载 `LN*.txt`，比对注入后的 workflow JSON fragment |
| 5 | Style 应用 | `_applyStyleToWorkflow` | `core/style.js` | 选 style，比对 prompt 字符串 |
| 6 | Wildcard 展开 | `_expandWildcardsInWorkflow` | `core/wildcard.js` | 含 `__name__` 的 prompt，比对展开结果 |
| 7 | Gen Presets 存取 / apply | `gen-presets.js` + 后端 | `core/api.js` + `views/settings.js` | 保存 → 载入 → 比对采样参数 |
| 8 | Batch 遍历 | `_runBatchGenerate`（195 行） | `core/batch.js` + `core/pipeline.js` | 3 个 lora 跑批次，比对输出数量 |
| 9 | 结果落库 + Gallery 浏览 | `gallery-tab.js` + `gallery_service.py` | `views/gallery.js` | 生成后能在 Gallery 看到、能回填 workflow |
| 10 | 设置持久化 | `settings-tab.js` + 后端 | `views/settings.js` | 改 URL / 输出目录，重启后仍生效 |
| 11 | **models 子系统 18 项**（见 §4） | `models-tab.js` + `models/*` | `views/models/*` | 逐项对照上游行为 |
| 12 | 脚本出图 | `tools/run_typhon_test.py` | **完全不动** | 跑一遍，正常出图 |

---

## 7. 交付物清单（全新建）

| # | 交付物 | 规模 |
|---|---|---|
| 1 | `static/js/core/**`（13 文件） | ~1050 行 |
| 2 | `static/js/core/CONTRACT.md` | P0 契约文档 |
| 3 | `static/js/newui/**`（约 45 文件） | ~10800 行 JS |
| 4 | `static/css/newui/**`（5 文件） | ~2900 行 CSS |
| 5 | `static/newui.html` | ~850 行 |
| 6 | `MIGRATION-NOTES.md` | 阶段记录 + 38% port 税的实际处理记录 |

**总计新增约 15600 行。`py/` 零改动，上游属有文件零改动。**

---

## 8. 验收标准（逐项实测，给出命令与输出）

```
1. 后端与上游属有文件零改动
   git diff --numstat upstream/main...main
   → 与开工前完全一致（仍为 312 行），不得新增任何上游文件改动

2. 合并干跑
   git fetch upstream && git merge --no-commit upstream/main
   → 冲突块数 = 0

3. core 零 DOM
   grep -rnE '\bdocument\.|\bwindow\.|getElementById|querySelector|innerHTML' static/js/core/
   → 0 命中

4. newui 不依赖上游 UI
   grep -rE 'from "\.\.?/(generate-tab|gallery-tab|workflow-tab|settings-tab|comfyui-editor|prompt-|models-tab|models/|app)' static/js/newui/
   → 0 命中

5. newui 无技术债
   grep -rnE '#[0-9a-fA-F]{3,8}\b|rgba?\(' static/js/newui/   → 0
   grep -rn  'fetch("/api/wfm'  static/js/newui/               → 0
   grep -rn  '!important'       static/css/newui/              → 0

6. newui 可用性
   /wfm_static/newui.html 打开后：
   - 自动从 localStorage 的 wfm_settings 读取 comfyuiUrl 并连上
   - 6 个导航项全部切换正常，无 404、Console 无 Error
   - 缩放到 800px 宽，导航栏正确折叠为图标态

7. 旧 UI 可回退
   /wfm 功能完好；12 项对照表在旧 UI 下依然全绿

8. 12 项功能对照表全绿（含 models 的 18 个子项）

9. 无障碍
   - newui 全部视图仅用键盘可完整操作（Tab / Enter / Space / Esc / 方向键）
   - Dialog 焦点陷阱有效，关闭后焦点回到触发元素
   - 全部交互组件有可见 `:focus-visible` 焦点环
   - 用 axe DevTools 扫描 6 个视图，0 个 critical 问题

10. 主题
    m3-dark / m3-light 两种模式下所有视图无不可读文字（对比度 ≥ 4.5:1）
```

---

## 9. 执行阶段

```
P0  冻结契约
    - core/CONTRACT.md
    - 12 项功能对照表（含 models 18 子项）
    - 确认 newui 只依赖 core/index.js
    验收：验收项 3、4 通过

P1  core 层（~1050 行）
    - 门面 re-export + 从 generate-tab.js 抄约 800 行逻辑（不抄 DOM）
    - core/api.js 覆盖全部 /api/wfm/* 端点
    - core/model-constants.js（静态映射表）
    - 用 Node 单测覆盖 pipeline / style / wildcard / batch / models 读写
    验收：core 单测全绿；对照表第 2/3/4/5/6 项通过

P2  M3 基础层
    - m3-tokens.css + theme-m3.css（静态值，无运行时依赖）+ m3-layout.css
    - ripple.js / a11y.js / snackbar.js / dialog.js
    - 前 11 个组件：Button / IconButton / Fab / TextField / Select / Slider
      / Switch / Checkbox / Radio / Chip / Card
    验收：组件 demo 页在 m3-dark / m3-light 下零错；键盘全可达

P3  newui shell + 3 视图（generate / settings / workflow）
    - newui.html + main.js + router.js + store.js
    - 剩余 11 个组件（Dialog / Menu / Tooltip / Snackbar / Tabs / NavigationRail
      / List / DataTable / Progress / SegmentedButtons）
    验收：对照表 1/7/10 项通过；能真实出图；验收项 1/2/5/6/7 通过

P4  models 视图（决策 3，18 项）
    验收：对照表第 11 项全部 18 子项通过

P5  prompt + gallery 视图
    验收：对照表 8/9 项通过；12 项全绿

P6  切换使用 + 观察
    - newui 成为日常入口（书签 /wfm_static/newui.html）
    - /wfm 旧 UI 至少保留 2 周
    - 完成 MIGRATION-NOTES.md
    验收：全部 10 项通过

P7  清理（可选，等于宣告放弃上游 UI 侧合并）
    - 删已弃用 tab 的 JS / CSS / 后端路由 / nav 项
    ⚠️ 到这一步才真正放弃上游合并
```

**每个 Phase 结束都跑一次验收 1–10，不要一次性做完再验。**
**P7 之前禁止删除任何上游文件。**

---

## 10. 明确禁止

| 禁止项 | 原因 |
|---|---|
| 引入 React / Svelte / Vue / Tailwind / 组件库 / 打包器 | 上游无构建步骤 |
| 引入 `@material/web` 或任何 M3 组件库 | 维护模式 / 单人项目 / 会引入第二套 token 体系 |
| 引入 `@material/material-color-utilities` 运行时 | 决策 2：不动态取色，只离线生成静态 CSS |
| 在 newui 里复用 `.wfm-*` 类名或旧 DOM 结构 | 会重新引入 1319 个 ID 的耦合 |
| 让 newui 直接依赖上游 UI 模块（含 `models/state.js`） | 等于换汤不换药，DOM 契约依旧存在 |
| 修改 `py/` 或任何上游文件 | 决策 1：后端零改动；破坏可回退性与合并 |
| 新建独立 i18n 字典 | 决策 4：沿用上游 `t()`，以自动继承新词条 |
| `!important`、内联硬编码颜色 | 重犯现有技术债 |
| 在 `core/` 里写 DOM 或 UI 概念 | 破坏 core/newui 边界 |
| 读写旧 UI 的 localStorage key（`wfm_models_view` 等） | 会造成新旧 UI 互相覆盖 |
