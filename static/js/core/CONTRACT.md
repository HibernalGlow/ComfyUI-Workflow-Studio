# core/ CONTRACT

Frozen interface between `static/js/core/**` (framework-free logic) and the UI
layer that consumes it: **React + @material/web, in TypeScript under
`frontend/src/`**, built by Vite into `static/`.
Authority: `FRONTEND-OPTIMIZATION-BRIEF.md`, **as amended by the route change
recorded in `MIGRATION-NOTES.md` §1**. That amendment reversed the brief's original
"vanilla ESM, no framework, no bundler" plan; the `core/` boundary described here
survived the change unchanged, which is the point of having it.

Last froze: 2026-09-25.

---

## 0. The boundary

| Rule | Statement | How it is checked |
|---|---|---|
| B1 | `core/` contains **zero DOM**: no element lookup, no markup injection, no access to the browser globals (`document`, `window`, `navigator`), and no storage reads outside `settings.js`. | `bash tools/check-newui.sh` gate **A3** and `node tools/core-tests/import-check.mjs` (rule 1) |
| B2 | `core/` imports **only** the five whitelisted upstream modules, and only via its own facades. | `grep -rn "^import" static/js/core/` |
| B3 | `core/` never throws UI concepts. Progress = callback, outcome = return value / rejected `Promise`. No toast, no dialog, no `alert`. | review |
| B4 | Every backend call goes through `core/api.js`. A raw `/api/wfm/...` request issued from the UI layer is a violation. | gate **A5b** |
| B5 | `frontend/src/**` reaches logic **only** through the `core` alias (= `core/index.js`), plus its own files and approved packages. | gates **A4a–A4d**, `import-check.mjs` rules 5–6 |
| B6 | The UI layer never reads or writes an old-UI storage key. `wfm_settings` is the one shared key (so the user's saved `comfyuiUrl` is inherited); UI preferences live under the `nu_` prefix. | gate **A5d** + `settings.readPref/writePref` |
| B7 | No upstream-owned file is modified. `py/**`, the pre-existing `static/js/*.js`, the pre-existing `static/css/*.css` and `templates/index.html` are read-only. | gate **A1** — the diff count must equal the P0 baseline |
| B8 | The built UI is generated, never committed: `static/newui/` and `static/newui.html` are gitignored. | gates **T2b/T2c** |

`core/` may use `fetch`/`WebSocket` only because `comfyui-client.js` already does and is
re-exported, not re-implemented.

---

## 1. Upstream facades (re-exports; no new behaviour)

| File | Re-exports from | Notes |
|---|---|---|
| `client.js` | `../comfyui-client.js` → `comfyUI` | Holds `baseUrl`, `wsUrl`, `clientId`, `socket`. Callers must run `comfyUI.updateUrl(getSettings().comfyuiUrl \|\| window.location.origin)` at boot — see §1.2 of the brief. |
| `workflow.js` | `../comfyui-workflow.js` → `comfyWorkflow` | The single source of truth for UI↔API graph conversion. Item 2 of the parity table is "reuse unchanged". |
| `i18n.js` | `../i18n.js` → `t`, `initI18n`, `getLang`, `setLang`, `getLanguageOptions`, `getSummaryPrompt`, `getSummaryLang`, `setSummaryLang`, `getSummaryLanguageOptions` | Decision 4: no new dictionary. `t(key, fallback)` degrades to the fallback for keys upstream lacks. |
| `settings.js` | `../util.js` → `getSettings`, `readJsonStorage`, `escapeHtml` | Plus new exports below. |
| `json.js` | `../json-highlight.js` → `highlightJSON`, `syncJsonHighlight`, `syncScroll` | These already take the target element as an argument, so they are DOM-free from core's perspective. |

### `settings.js` additions (new code, new file — not an upstream edit)

| Export | Signature | Returns |
|---|---|---|
| `SETTINGS_KEY` | `"wfm_settings"` | The one shared key. |
| `updateSettings(patch)` | shallow-merge into the stored object and persist | the merged settings; on a storage failure the returned object carries `__error` |
| `readSettingsRaw()` | — | parsed settings, `{}` on missing/corrupt |
| `readPref(name, fallback)` | reads `nu_<name>` | parsed value or `fallback` |
| `writePref(name, value)` | writes `nu_<name>` | `true` / `false` |

`localStorage` access is allowed here and **only** here; it is not a DOM API and the
boundary rule in §1.2 of the brief is about element access.

---

## 2. `model-constants.js` — static tables (no state)

Copied as data from upstream `models/state.js`, which core must NOT import (it owns mutable
state and reads the old UI's `wfm_models_view` key).

| Export | Shape |
|---|---|
| `RESERVED_GROUPS` | `["Batch","Stack"]` |
| `BATCH_MODEL_TYPES` | `["checkpoint","lora"]` |
| `STACK_MODEL_TYPES` | `["lora"]` |
| `MODEL_TYPES` | the 8 types in nav order |
| `TYPE_LABELS` | type → display label |
| `FETCH_MAP` | type → `{ client, inputKey }`; `client` is a `comfyUI` method name, `inputKey` is the ComfyUI node input (**`embedding` → `inputKey: null`**, it is applied to the prompt) |
| `GENUI_TYPE_MAP` | type → `{ key, inputKey }` for the Generate view's model slots (no `embedding`) |
| `SORT_COLUMNS` | `fav, filename, subdir, civtype, basemodel, ext, tags, memo, enabled` |
| `STATUS_FILTERS` / `VIEW_MODES` | `all\|enabled\|disabled` / `thumb\|table` |
| `typeLabel(t)` `subdirOf(f)` `baseNameOf(f)` `extOf(f)` | pure string helpers |
| `isSlotType(t)` `isBatchType(t)` `isStackType(t)` | predicates |

---

## 3. `api.js` — the only network layer

See **`CONTRACT-api.md`** for the per-function table (signature, params, response, errors).
Summary of the contract:

- one private `request()` helper: builds URL + query, JSON body, JSON parse, throws
  `Error` carrying `.status` and the server message on `!res.ok`.
- one private SSE reader for `POST /api/wfm/models/civitai/batch`
  (`event: progress {...}` / `event: done {...}`), abortable, cancels the reader on error.
- **binary endpoints are exposed as URL builders**, not as fetches, because the DOM layer
  assigns them to `img.src` / `<a href>`: model preview, gallery serve/thumb, exports.
- Path caveat: `gallery_routes.py` registers `/wfm/gallery/...` **without** the `/api`
  prefix; every other module uses `/api/wfm/...`.

---

## 4. `pipeline.js` — generation orchestration

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

- `workflow` is passed in by the caller and the **actually used** workflow is returned:
  newui owns state, core stays stateless.
- `onProgress(pct, msg)` receives `0..1`.
- On `signal` abort: `comfyUI.interrupt()` is called and the promise rejects with an
  `AbortError` (`err.name === "AbortError"`).
- Transport is upstream `comfyUI.generate()` (parity item 3, reused unchanged); the extra
  `svgOutputs` it already computes are wired through, which the upstream `_coreGenerate`
  dropped.

## 5. `style.js`, `wildcard.js`, `lora.js`

- `style.js` — `applyNamedStyle(...)` / `applyStyleToWorkflow(...)`: upstream
  `_applyNamedStyle` + `_applyStyleToWorkflow` minus DOM. Parity item 5 (compare the prompt
  string for a chosen style).
- `wildcard.js` — `expandWildcardsInWorkflow(workflow, ...)` / `expandWildcardText(text, ...)`:
  upstream `_expandWildcardsInWorkflow` + `_expandWildcardText` unchanged in semantics
  (`__name__`, recursive expansion, unknown-name behaviour). Parity item 6.
- `lora.js` — story-storyboard path: parse `LN*.txt` → match LoRAs → build the workflow
  fragment → `api.applyLoras`. Parity item 4 (compare the injected workflow fragment).

## 6. `batch.js` — batch selection state machine

- Pure operations over an explicit state object passed by the caller; **no module-level
  singleton**, no storage access.
- `loadBatchGroups` / `loadStackGroups` fetch groups for `BATCH_MODEL_TYPES` /
  `STACK_MODEL_TYPES` through `api.getModelGroups(type)`.
- Batch/Stack toggles (`toggleBatch`, `clearBatchGroup`, `toggleStack`, `clearStackGroup`
  semantics) live here so the Models view and the Generate view share one implementation
  (parity item 13 of §4).
- `runBatchGenerate(...)` iterates the selection calling `pipeline.runGeneration` per item
  (upstream `_runBatchGenerate` + `_runBatchLoop` semantics, 195 + 72 lines) with DOM writes
  replaced by callbacks. Parity item 8.

## 7. `models.js`, `image.js`

- `models.js` — metadata / groups / badges / disabled / favourites / Civitai read-write
  wrappers over `api`. Parity items 7, 10, 15 of §4. Backed by `nu_models_view`, never
  `wfm_models_view`.
- `image.js` — `blob → dataURL`, output-directory discovery, result-metadata persistence.
  Must run in Node without a DOM global: no `FileReader`, no `canvas`. Parity item 9.
  The parts callers may not rediscover by accident:
  - `saveGeneratedImagesMeta(images, workflow, {outputDir})` writes metadata for **`type === "output"`
    entries only** (`temp` previews are not artifacts), posts `{path, workflow}` to
    `/wfm/gallery/image/meta` (note: no `/api` prefix), builds `path` as
    `<normalized dir>/<subfolder>/<filename>`, counts a failing write into `{saved, failed}`
    instead of throwing, and issues **zero** requests when no directory can be resolved.
  - `normalizeOutputDir` converts `\` to `/` and strips one trailing slash — the view must apply
    the same function to its live `wfm-output-dir-changed` value, or the two paths diverge.
  - `applyDefaultCheckpointIfEnabled(workflow)` mutates **in place** and must run before
    `comfyWorkflow.analyzeWorkflow()`; it rewrites `ckpt_name` on `*CheckpointLoader*`,
    `"Checkpoint Loader"` and `"ImageMetadataPromptLoader"`, returns the applied name or `null`,
    and swallows a settings-fetch failure.

---

## 7.5 `widgets.js` — `/object_info` widget metadata (pure)

| Export | Signature | Returns |
|---|---|---|
| `widgetKindOf(declared)` | a raw `/object_info` type declaration | `"INT"｜"FLOAT"｜"STRING"｜"BOOLEAN"｜"COMBO"｜"COMFY_DYNAMICCOMBO_V3"｜null` |
| `widgetNames(objectInfo, classType)` | — | ordered widget input names (required, then optional) |
| `inputSpec(objectInfo, classType, name)` | — | `{kind, min, max, step, default, options, multiline, label}` or `null` |

Pure functions over a snapshot: the **caller** fetches it through
`comfyUI.fetchAllObjectInfo()` (the network belongs to `client.js`, not to this module) and
keeps it in view state, which is what §0's "core stays stateless" rule requires.

The type-resolution rules deliberately mirror upstream `comfyui-workflow.js`
(`_resolveWidgetType`, `_getWidgetInputNames`), which are module-private and therefore not
callable. Two behaviours are load-bearing there and covered by tests: a MultiType declaration
like `"FLOAT,INT"` occupies exactly **one** widget slot (an exact-match test drops it and shifts
every later widget out of schema order), and `forceInput: true` marks a link-only socket that
must never become a field. If upstream changes those rules, diff this file against it.

---

## 8. `index.js`

The only entry point for `newui/`. Namespaced re-exports (`client`, `workflow`, `i18n`,
`settings`, `json`, `api`, `modelConstants`, `pipeline`, `style`, `wildcard`, `lora`,
`batch`, `models`, `image`) plus a flattened set of the helpers every view needs
(`comfyUI`, `comfyWorkflow`, `t`, `initI18n`, `getSettings`, `escapeHtml`, `readPref`,
`writePref`, `highlightJSON`, the model tables, `runGeneration`).

Import from a view as `../../core/index.js`; from a top-level newui file as `../core/index.js`.

---

## 9. Verification

One command runs every mechanical gate (checks A1–A5 and the structure/syntax gates):

```bash
bash tools/check-newui.sh                 # brief §8 items 1, 3, 4, 5
RUN_MERGE_DRY=1 bash tools/check-newui.sh # additionally item 2 (upstream merge dry run)
node tools/core-tests/import-check.mjs    # B1/B2/B4/B5 as a runtime check
node --test tools/core-tests/             # core unit tests
```

`import-check.mjs` is the authoritative version of rules B1, B2, B4 and B5: it imports every
core module in Node, asserts each `api.<name>` a core module calls is actually exported by
`api.js`, resolves `index.js`, and verifies that no newui module imports anything except
`core/index.js` and its own tree. `check-newui.sh` performs the literal-text gates the brief
specifies, so the two overlap on purpose — a rule that only one of them catches is still caught.

Two harness pieces in `core.test.mjs` are worth reusing rather than reinventing:

- **`FakeSocket` + `withComfy(null, fn)` + `awaitTracker()`** — the way to test anything that goes
  through `comfyUI.generate()`. Passing `null` lets upstream's `connectWebSocket()` build the
  socket, so its `onopen`/`onclose` wiring is real; `awaitTracker()` waits for
  `_pendingTrackers` to gain the prompt before a message is emitted, which is what keeps the test
  from racing the `POST /prompt` round trip. Emit `executing` with `node: null` to finish a run.
- **`routes.set(path, handler)` + `callsTo(path)`** — the fetch stub matches exact pathnames and
  answers 404 for anything unregistered, so an unstubbed route surfaces as a thrown request rather
  than a silent pass.

`core/client.js` itself is a re-export, so its tests assert **upstream's** contract; keep them
truthful after any upstream sync instead of deleting them when a hash gate goes red.

Node unit tests for the pure modules live in `tools/core-tests/` and run with
`node --test tools/core-tests/` (no packaging step, no `package.json` change — keeping that
file byte-identical matters for B7).

B7 (upstream-owned files untouched) is checked by comparing `git diff --numstat
upstream/main...main` against the baseline recorded in the P0 commit; the check script prints
the current count for that comparison.
