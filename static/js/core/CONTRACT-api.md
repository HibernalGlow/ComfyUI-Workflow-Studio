# CONTRACT — `core/api.js`

Reference for every export of `static/js/core/api.js` (the project's only network
layer for Workflow-Studio backend routes). 104 exports covering 100 of the 151
documented endpoints.

This table is machine-checked: `tools/core-tests/core.test.mjs` parses `request()` call
sites out of `api.js` and the `add_get/add_post/add_put/add_delete` registrations out of
`py/routes/*.py`, and fails when a path or method does not line up segment for segment
(`93/93` call sites currently resolve, `0` computed paths). `py/` is frozen for the
refactor, so a drift here would otherwise surface only as a runtime throw that the
calling view swallows — a feature going quietly dead, not a red gate.

## 1. Transport contract (applies to every JSON export unless stated otherwise)

| Aspect | Behaviour |
|---|---|
| URL | Path is used verbatim (absolute, always starts with `/`). `query` values are `encodeURIComponent`-ed; `null`/`undefined` entries are dropped; arrays expand to repeated keys. |
| Request body | Plain object/array → `Content-Type: application/json` + `JSON.stringify`. `FormData` → passed through, no `Content-Type` header (browser sets the boundary). |
| Response | `res.text()` parsed as JSON. A 200 with an empty body or `204` → `null`. A 200 body that is not JSON is returned as a raw string (lenient fallback). |
| Non-OK response | Throws `Error(message)` with extra props `err.status` (HTTP code; `0` = transport failure) and `err.data` (parsed body or `null`). `message` = server `data.error` ‖ `data.message` ‖ trimmed body text ‖ `HTTP <status> <statusText>`. Plain-text error bodies (models preview, civitai batch) are surfaced verbatim. |
| Abort | The caller's `AbortSignal` is forwarded to `fetch`; abort rejects with an `Error` whose `name === "AbortError"` (never swallowed, never re-wrapped). |
| Progress | Delivered through callbacks only. Nothing in this module touches the page, storage, or any notification UI. |
| Binary | Never through the JSON helper. GET-consumable binaries are exposed as pure `*Url()` string builders; POST-only binaries resolve to a `Blob`. |

Prefix rule (verified): all modules use `/api/wfm/...` **except** `gallery_routes.py`
(`/wfm/gallery/...`, no `/api`) and `tagger_routes.py` (not implemented here).
ComfyUI-core routes (`/object_info`, `/prompt`, `/history/…`, `/view`,
`/upload/image`, `/system_stats`, `/ws`) belong to `core/client.js`, not here.

## 2. Settings — `py/routes/settings_routes.py`

| Export | Backend | Returns | Errors / caveats |
|---|---|---|---|
| `getSettingsFromServer()` | GET `/api/wfm/settings` | settings dict (`default_checkpoint_*`, `ollama_*`, `civitai_*`, `gmic_qt_path`, `gallery_output_dir`, `workflows_dir`, …) | 500 `{error}` |
| `saveSettingsToServer(patch)` | POST `/api/wfm/settings` | `{status, settings}` | Body is merged server-side; 500 `{error}` |
| `getWorkflowsDir()` | GET `/api/wfm/settings/workflows-dir` | `{current, default}` | — |
| `setWorkflowsDir(dir)` | POST `/api/wfm/settings/workflows-dir` | `{status, workflows_dir}` | `""` resets to default; 400/500 `{error}` |
| `getOutputDir()` | GET `/api/wfm/settings/output-dir` | `{current, default, saved}` | — |
| `setOutputDir(dir)` | POST `/api/wfm/settings/output-dir` | `{status, current, default, saved}` | **Side effect:** also configures the gallery allowed root; `saveImageToGallery` fails (500) until it is set. `""` resets. |
| `settingsExportUrl()` | GET `/api/wfm/settings/export` | URL string | Binary JSON attachment (`wfm-data-export.json`). Put it on an anchor; it is a GET, so no Blob helper exists. |
| `importSettingsBundle(bundle)` | POST `/api/wfm/settings/import` | `{status, imported, skipped}` | Whole bundle is the body; 400 `{error:"Invalid bundle format"}` |
| `settingsExportFullUrl(opts)` | GET `/api/wfm/settings/export-full` | URL string | `opts = {includeWorkflows?, includeWildcard?}` (truthy → `=1`). Binary zip `wfm-full-backup.zip`, GET download. |
| `importFullBackup(file)` | POST `/api/wfm/settings/import-full` | `{status, extracted, skipped}` | **Multipart** field `file` (zip); 400 `{error}` |
| `listStyles()` | GET `/api/wfm/styles` | `[{name, prompt, negative_prompt, file}]` | — |
| `createStyle(style)` | POST `/api/wfm/styles` | `{ok:true}` | `style = {name, prompt, negative_prompt, file?}`; 400 on duplicate / unknown file |
| `updateStyle(originalName, style)` | PUT `/api/wfm/styles/{name}` | `{ok:true}` | `style = {name, prompt, negative_prompt}`; 404 `{error:"Style not found"}` |
| `deleteStyle(name)` | DELETE `/api/wfm/styles/{name}` | `{ok:true}` | 404 `{error}` |

## 3. Generation presets — `py/routes/gen_presets_routes.py`

| Export | Backend | Returns | Errors / caveats |
|---|---|---|---|
| `listGenPresets()` | GET `/api/wfm/gen_presets` | array of `{id, name, description, sampling_mode, sampler_settings:{steps,cfg,sampler_name,scheduler,denoise}, loras, quality_prefix, default_negative}` | 500 `{error}` |
| `saveGenPreset(preset)` | POST `/api/wfm/gen_presets` | `{status, preset}` | Preset object forwarded verbatim (server upserts by `id`) |
| `applyGenPreset({workflow, preset}` ‖ `{workflow, preset_id})` | POST `/api/wfm/gen_presets/apply` | `{status, preset, workflow}` | Exactly one of `preset`/`preset_id` must be present; 400 `{error:"Preset not found or provided"}` |
| `deleteGenPreset(id)` | DELETE `/api/wfm/gen_presets/{id}` | `{status, deleted}` | `id` is URL-encoded; 400 `{error:"Missing preset id"}` |

## 4. Workflows — `py/routes/workflow_routes.py`

| Export | Backend | Returns | Errors / caveats |
|---|---|---|---|
| `listWorkflows()` | GET `/api/wfm/workflows` | `[{filename, analysis, metadata:{tags,memo,summary,modelTypesOverride,favorite,badges}, mtime, thumbnail}]` | `thumbnail` is already a usable `/wfm_data/workflows/…` URL. Analysis is recomputed per call. |
| `loadWorkflow(name)` | GET `/api/wfm/workflows/raw?filename=` | parsed workflow JSON (UI or API format) | 400 `{error:"invalid filename"}`, 404 `{error:"not found"}`. Server also accepts `?file=`. |
| `saveWorkflow(name, workflow)` | POST `/api/wfm/workflows/import` | `{status:"ok", filename, results}` | **Caveat:** no dedicated write endpoint exists; this posts a multipart `.json` part, which the service writes verbatim to `<workflows_dir>/<filename>` (overwrite allowed). `.json` is appended when missing. Throws when the result entry is not `success`. Analysis appears on the next `listWorkflows()`. |
| `saveWorkflowMetadata(filename, updates)` | POST `/api/wfm/workflows/metadata` | `{status:"ok"}` | 400 `{error}` |
| `importWorkflows(files)` | POST `/api/wfm/workflows/import` | `{results:[{name,status,message?}]}` | **Multipart**, repeated part name `files`; accepts a single item or an array |
| `renameWorkflow(filename, newStem)` | POST `/api/wfm/workflows/rename` | service result dict | HTTP status comes from the service; 400 `{error}` |
| `deleteWorkflow(filename)` | POST `/api/wfm/workflows/delete` | `{status:"ok"}` | 400 `{error}` |
| `analyzeWorkflow(filename)` | POST `/api/wfm/workflows/analyze` | `{analysis}` | 400 / 404 `{error}` |
| `reanalyzeAllWorkflows()` | POST `/api/wfm/workflows/reanalyze-all` | service result dict | No body |
| `changeWorkflowThumbnail(filename, file)` | POST `/api/wfm/workflows/change-thumbnail` | `{status:"ok", thumbnail}` | **Multipart** fields `filename`, `file`; 400 `{error}` |
| `saveCanvasImage(filename, image)` | POST `/api/wfm/workflows/save-canvas-image` | `{status:"ok", filename}` | **Multipart** fields `filename`, `image` (PNG bytes). The PNG's embedded workflow becomes the workflow JSON. |

## 5. Wildcards — `py/routes/wildcard_routes.py`

| Export | Backend | Returns | Errors / caveats |
|---|---|---|---|
| `getWildcards()` | GET `/api/wfm/wildcards` | `[{name, filename, ext, size, dir, wc_name}]` | — |
| `getWildcardContent(filename)` | GET `/api/wfm/wildcards/content?filename=` | content string, or `null` | `null` on 404; other errors rethrow. `filename` includes the extension. |
| `saveWildcard(filename, content)` | POST `/api/wfm/wildcards/save` | `{status:"ok", file}` | — |
| `deleteWildcard(filename)` | POST `/api/wfm/wildcards/delete` | `{status:"ok"}` | — |
| `getWildcardLinkStatus()` | GET `/api/wfm/wildcards/link-status` | `{impact_pack_installed, impact_pack_wildcards_dir, wfs_wildcard_dir, is_linked, link_target}` | 500 `{error}` |
| `createWildcardLink()` | POST `/api/wfm/wildcards/create-link` | `{status:"ok", migrated_files, …}` | No body; 400 `{error}` |
| `removeWildcardLink()` | POST `/api/wfm/wildcards/remove-link` | `{status:"ok"}` | No body; 400 `{error}` |
| `expandWildcards(text, opts)` | GET `/api/wfm/wildcards/content` (client-side expansion) | expanded string | **No server-side expansion endpoint exists**, so this expands `__name__` locally from `<name><ext>` files: random non-empty, non-`#` line; unknown names untouched; nested rounds capped by `opts.maxPasses` (default 5). `opts = {ext=".txt", maxPasses=5, random=Math.random, signal}`. Returns the input unchanged when it contains no `__`. |

## 6. LoRA — `py/routes/lora_trigger_routes.py`

| Export | Backend | Returns | Errors / caveats |
|---|---|---|---|
| `getLoraRules()` | GET `/api/wfm/lora/rules` | array of rule objects | 500 `{error}` |
| `saveLoraRules(rules)` | POST `/api/wfm/lora/rules` | saved array (echo) | Body must be a JSON **array**; 400 `{error:"Rules must be a list"}` |
| `rescanLoraRules()` | POST `/api/wfm/lora/rules/rescan` | `{message, count, triggers}` | No body |
| `matchLoras(prompt, opts)` | POST `/api/wfm/lora/match` | `{matched_loras:[{name,path,model_weight,clip_weight,trigger,category,active}], parsed_prompt:{tags,caption,positive_prompt,raw}}` | `opts = {autoTurbo?, qualityPrefix?, signal?}`. Server default `auto_turbo` is `true` and then prepends a hard-coded Turbo entry — pass `false` to opt out. `quality_prefix` is only sent when the caller supplies it. |
| `applyLoras(workflow, opts)` | POST `/api/wfm/lora/apply` | `{success:true, applied_count, workflow}` | Accepts `opts.loras` ‖ `opts.activeLoras` ‖ a bare array. The request always sends the `loras` key. **Caveat:** `applied_count` is the sent list length *before* the service drops entries whose `active !== true`. |

## 7. Prompt presets — `py/routes/prompts_routes.py`

| Export | Backend | Returns | Errors / caveats |
|---|---|---|---|
| `listPrompts()` | GET `/api/wfm/prompts` | array (`p.id` used as the key) | — |
| `createPrompt(prompt)` | POST `/api/wfm/prompts` | `{status:"ok", prompt}` | Body forwarded verbatim |
| `updatePrompt(id, updates)` | POST `/api/wfm/prompts/update` | `{status:"ok", prompt}` | 400 `{error:"id is required"}`, 404 `{error:"prompt not found"}` |
| `deletePrompt(id)` | POST `/api/wfm/prompts/delete` | `{status:"ok"}` | 400 `{error:"id is required"}` |

## 8. Models — `py/routes/models_routes.py`

Model types (`type`/`model_type`) are validated server-side: checkpoint, lora,
vae, controlnet, unet, textencoder, hypernetwork, embedding (see
`core/model-constants.js`).

| Export | Backend | Returns | Errors / caveats |
|---|---|---|---|
| `getModelMetadata()` | GET `/api/wfm/models/metadata` | `{"<modelName>": {tags, favorite, memo, sha256?, …}}` | Whole metadata map |
| `saveModelMetadata(modelName, updates)` | POST `/api/wfm/models/metadata` | `{status:"ok", metadata}` | 400 without `modelName` |
| `getModelGroups(type)` | GET `/api/wfm/models/groups?type=` | `{"<groupName>": ["a.safetensors", …]}` | Omit `type` (pass `undefined`) for all types at once |
| `saveModelGroups(modelType, groups)` | POST `/api/wfm/models/groups` | `{status:"ok", groups}` | 400 `{error:"model_type required"}` |
| `modelPreviewUrl(type, name)` | GET `/api/wfm/models/preview` | URL string | **Binary** image, `Cache-Control: no-cache`; 400/404 with plain text or an empty body, so probe via the image error event — HEAD is not handled by `add_get`. Append your own `&t=` cache-buster after a change. |
| `fetchCivitai(type, name)` | POST `/api/wfm/models/civitai/fetch` | `{status:"ok", sha256, civitai, preview_saved}` ‖ `{status:"not_found", sha256, message}` | 400/404/500 `{error}` |
| `getCivitaiCache()` | GET `/api/wfm/models/civitai/cache` | cache map keyed by sha256 ‖ model name | — |
| `batchCivitai(type, models, onProgress, signal)` | POST `/api/wfm/models/civitai/batch` | `done` payload `{total, found, not_found, errors, hashes, preview_saved}` ‖ `null` | **SSE** (`text/event-stream`). `onProgress({current,total,model,status})` per `progress` frame; status ∈ hashing/fetching/cached/found/not_found. Non-OK responses throw with the plain-text body as `message`. The reader is always cancelled; abort rejects with `AbortError`. |
| `changeModelPreview(type, name, file)` | POST `/api/wfm/models/change-preview` | `{status:"ok"}` | **Multipart** fields `type`, `name`, `file`; 400/404 `{error}` |
| `getModelFilePath(type, name)` | GET `/api/wfm/models/filepath?type=&name=` | `{path}` | 400/404/500 `{error}` |
| `getDisabledModels(type)` | GET `/api/wfm/models/disabled?type=` | `["modelA.safetensors", …]` (`.disabled` stripped) | — |
| `toggleModelEnabled(modelType, modelName, enabled)` | POST `/api/wfm/models/toggle` | `{status:"ok", enabled}` | 400/404/500 `{error}` |
| `toggleGroupEnabled(modelType, groupName, enabled)` | POST `/api/wfm/models/group-toggle` | `{status, enabled, ok:[names], errors:[{model,error}]}` | — |
| `listModelFiles(type)` | GET `/api/wfm/models/files?type=` | sorted relative paths (`/`-separated) | 400 `{error:"invalid type"}`; also the fallback source for `embedding` |
| `getSubdirs(type)` | GET `/api/wfm/models/subdirs?type=` | sorted subdirectory list | 400 `{error:"Invalid model type"}` |
| `moveModels(modelType, modelNames, dest)` | POST `/api/wfm/models/move` | `{moved:[{from,to}], errors:[{model,error}]}` | `dest:""` = root |
| `deleteModels(modelType, modelNames)` | POST `/api/wfm/models/delete` | `{status:"ok", ok:[{model,deleted:[files]}], errors:[{model,error}]}` | Partial success is normal — inspect both arrays |

## 9. Gallery — `py/routes/gallery_routes.py` (paths have **no** `/api` prefix)

| Export | Backend | Returns | Errors / caveats |
|---|---|---|---|
| `galleryServeUrl(path)` | GET `/wfm/gallery/image/serve?path=` | URL string | **Binary**; `Cache-Control: max-age=3600`; 400/404 empty body. Usable on `img`/`video` sources. |
| `galleryThumbUrl(path, w=256)` | GET `/wfm/gallery/image/thumb?path=&w=` | URL string | **Binary** JPEG/GIF, `max-age=86400`; `w` clamped 32…512 |
| `listGalleryFolders(root)` | GET `/wfm/gallery/folders?root=` | `{name, path, abs_path, image_count, image_count_total, children:[…]}` | 400 `{error}`. **Side effect:** configures the gallery allowed root server-side. |
| `listGalleryImages(params)` | GET `/wfm/gallery/images` | `{images:[{filename,path,size,mtime,ext,favorite,tags,memo,groups}], total}` | `params = {folder(required), search?, sort?, favorite?, tag?, group?, recursive?, signal?}` (`signal` is not sent as a query key); 400 `{error:"folder parameter required"}` |
| `getGalleryImageMeta(path)` | GET `/wfm/gallery/image/meta?path=` | gallery metadata object | 400 `{error:"path required"}` |
| `getGalleryImageWorkflow(path)` | GET `/wfm/gallery/image/workflow?path=` | `{workflow, has_workflow, prompt_workflow}` | `prompt_workflow` (API format) is the preferred prompt source |
| `saveGalleryImageMeta(path, meta)` | POST `/wfm/gallery/image/meta` | `{ok:boolean}` | **HTTP 200 even when the save is rejected** — check `ok` / `error` yourself. Body is `{path, ...meta}`. |
| `getImagePromptRoot()` | GET `/wfm/gallery/image-prompt/root` | `{root}` | 500 `{error}` when the output dir is unresolved |
| `saveImagePrompt(path, prompt)` | POST `/wfm/gallery/image/image-prompt` | `{ok}` | 400 `{error:"path required"}` |
| `getStyleCatalogRoot()` | GET `/wfm/gallery/style-catalog/root` | `{root}` | 500 `{error}` |
| `saveImageToGallery(payload)` | POST `/wfm/gallery/image/save` | `{ok:true, path}` | `payload = {filename, imageData}` (`imageData` = data URL); **500 until the gallery root is configured**; 400 `{error}` |
| `saveImageToFolder(payload)` | POST `/wfm/gallery/image/save-to-folder` | `{ok:true, path}` | `payload = {folder, filename, imageData}`; overwrites on name clash |
| `deleteOutputImage(payload)` | POST `/wfm/gallery/output-image/delete` | `{ok:true}` | `payload = {filename, subfolder, type}`; `type` must be `"output"`; 400/404/500 `{error}` |
| `toggleGalleryFavorite(path)` | POST `/wfm/gallery/image/favorite` | `{favorite:boolean}` | 400 `{error}` |
| `listGalleryGroups()` | GET `/wfm/gallery/groups` | `{groups:[…]}` | — |
| `createGalleryGroup(name)` | POST `/wfm/gallery/groups` | `{ok:true}` | 409 `{error:"Group already exists"}` |
| `renameGalleryGroup(name, newName)` | PUT `/wfm/gallery/groups/{name}` | `{ok:true}` | 403 reserved group; 400 on rename failure |
| `deleteGalleryGroup(name)` | DELETE `/wfm/gallery/groups/{name}` | `{ok}` | 403 reserved group |
| `ensureGalleryGroup(name)` | POST `/wfm/gallery/groups/ensure` | `{ok:true}` | Idempotent create; 400 `{error}` |
| `addToGalleryGroup(name, path)` | POST `/wfm/gallery/groups/{name}/add` | `{ok}` | The server does not verify that the group exists |
| `removeFromGalleryGroup(name, path)` | POST `/wfm/gallery/groups/{name}/remove` | `{ok}` | — |
| `clearGalleryGroup(name)` | POST `/wfm/gallery/groups/{name}/clear` | `{ok}` | No body; 400 `{error}` |
| `listGalleryGroupImages(name)` | GET `/wfm/gallery/groups/{name}/images` | `{images:[…]}` | — |
| `bulkGalleryFavorite(paths, value)` | POST `/wfm/gallery/bulk/favorite` | service result; the count is the **number** `data.ok` | 400 `{error}` |
| `bulkGalleryGroup(paths, group, action)` | POST `/wfm/gallery/bulk/group` | service result; `data.ok` count + `data.errors` | `action` ∈ `"add"` ‖ `"remove"`; 400 `{error}` |
| `createGalleryFolder(parent, name)` | POST `/wfm/gallery/folder` | `{ok, …}` | 400 `{ok:false, error}` |
| `deleteGalleryFolder(path)` | DELETE `/wfm/gallery/folder` | `{ok, …}` | JSON body on DELETE; 400 `{ok:false, error}` |
| `deleteGalleryImages(paths)` | POST `/wfm/gallery/images/delete` | `{deleted:[…], errors:[…]}` | 400 returns the same shape |
| `moveGalleryImages(paths, dest)` | POST `/wfm/gallery/images/move` | `{moved:[{from,to}], errors:[…]}` | 400 returns the same shape |
| `galleryExportZipUrl()` | POST `/wfm/gallery/images/export-zip` | URL string | **POST-only** — a URL alone cannot download it; kept for logging/tests only, use `exportGalleryZip` |
| `galleryExportPsdUrl()` | POST `/wfm/gallery/images/export-psd` | URL string | Same as above; use `exportGalleryPsd` |
| `exportGalleryZip(paths, opts)` | POST `/wfm/gallery/images/export-zip` | `Blob` (`gallery_export.zip`) | **Binary POST**; `opts = {signal?}`; 400 `{error}`. Wrap the Blob in an object URL for the anchor. |
| `exportGalleryPsd(paths, opts)` | POST `/wfm/gallery/images/export-psd` | `Blob` (`image/vnd.adobe.photoshop`) | **Binary POST**; 400/500 `{error}` |
| `exportPsdLayers(payload, opts)` | POST `/wfm/gallery/image/export-psd-layers` | `Blob` (PSD) | **Binary POST**; `payload = {width, height, layers}`; 400/500 `{error}` |
| `importPsdLayers(file)` | POST `/wfm/gallery/image/import-psd-layers` | layers JSON from the service | **Multipart** field `file` (PSD bytes); 400/500 `{error}` |
| `getPsdLayers(path)` | GET `/wfm/gallery/image/psd-layers?path=` | layers JSON from the service | 400/500 `{error}` |

## 10. Eagle — `py/routes/eagle_routes.py`

| Export | Backend | Returns | Errors / caveats |
|---|---|---|---|
| `eagleAdd(payload)` | POST `/api/wfm/eagle/add` | Eagle API response passed through | `payload = {eagleUrl, url, name, tags, filename?, subfolder?, type?, localPath?}`; 400/502 `{status:"error", message}` (`localPath` is needed for server-side local-path resolution of SVG) |
| `testEagle(eagleUrl)` | POST `/api/wfm/eagle/test` | `{status, connected, version?‖message?}` | — |

## 11. Ollama proxy — `py/routes/ollama_routes.py`

| Export | Backend | Returns | Errors / caveats |
|---|---|---|---|
| `ollamaChat(messages, opts)` | POST `/api/wfm/ollama/chat` | `{status:"success", message}` | `opts = {url?, model?, signal?}`; URL/model default to the server settings. 500 `{error}`. Non-streaming. |
| `ollamaModels()` | GET `/api/wfm/ollama/models` | `{status:"success", models:[…]}` | URL comes from the settings; 500 `{status:"error", message}` |
| `testOllama()` | POST `/api/wfm/ollama/test` | `{connected, message}` | URL comes from the settings; no body |

## 12. Deliberately not implemented (51 endpoints)

Tabs the new UI does not include: **nodes** (9), **tagger** (17, `/wfm/tagger/...`),
**lab** (5), **video** (12), **image-edit / gmic** (3), **ai / unsloth** (1),
**ai / skill** (4). Add them here (same transport helpers) if such a view is ever
built; do not add ad-hoc `fetch` calls elsewhere.

## 13. Invariants / verification

```
# module loads, 104 exports
node --input-type=module -e "import('<repo>/static/js/core/api.js').then(m=>console.log(Object.keys(m).length))"
```

Run the project-wide zero-DOM grep from §2.2 of the brief against
`static/js/core/api.js` (and the rest of `core/`) — it must produce no output.
(The literal pattern is intentionally not repeated here so this reference file
itself stays clean for that same check.)

Rules kept by this module: no third-party imports (it imports nothing at all),
no UI concepts, no notification helpers, no page storage. Every export is a plain
function; nothing is stateful, so repeated calls are always fresh network calls.
