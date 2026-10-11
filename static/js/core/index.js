/**
 * core/index.js — the ONLY module the new UI is allowed to import.
 *
 * Boundary rules (FRONTEND-OPTIMIZATION-BRIEF.md §2.2):
 *   1. Everything under static/js/core/ is DOM-free. The DOM contract between
 *      core and newui is *zero element ids* — newui owns every node it renders.
 *   2. core/ may only depend on these upstream modules, always through the
 *      facades re-exported below:
 *          ../comfyui-client.js  ../comfyui-workflow.js  ../i18n.js
 *          ../util.js            ../json-highlight.js    ../vram-prepare.js
 *      comfyui-client.js pulls in vram-prepare.js and decision-client.js on its own; check 7 of
 *      tools/core-tests/import-check.mjs walks the whole transitive graph and keeps the old UI's
 *      entry module (app.js and every *-tab.js) out of it.
 *   3. Callers keep state; core stays stateless. Functions take what they need
 *      and return what happened — no module-level mutable singletons.
 *   4. Every backend call goes through `api`. New code must never write a bare
 *      `fetch("/api/wfm/...")`.
 *
 * Namespaced re-exports (`import { api, batch } from "../core/index.js"`) keep
 * call sites explicit about which layer they are talking to.
 */

// --- upstream facades -------------------------------------------------------
export * as client from "./client.js";
export * as workflow from "./workflow.js";
export * as i18n from "./i18n.js";
export * as settings from "./settings.js";
export * as json from "./json.js";

// --- new core modules -------------------------------------------------------
export * as api from "./api.js";
export * as modelConstants from "./model-constants.js";
export * as pipeline from "./pipeline.js";
export * as style from "./style.js";
export * as wildcard from "./wildcard.js";
export * as lora from "./lora.js";
export * as batch from "./batch.js";
export * as models from "./models.js";
export * as image from "./image.js";
export * as presets from "./presets.js";
export * as widgets from "./widgets.js";

// --- the few helpers every view needs, flattened for convenience ------------
export { comfyUI, setVramToastSink } from "./client.js";
// The VRAM mode/target pair is shared with the old UI on purpose (same precedent as decision D3 for
// wfm_settings): comfyUI.queuePrompt() reads it in both shells, so a newui-only key would make the
// setting silently disagree. Views reach it through these names and never touch the storage key.
export {
    getVramSettings,
    saveVramSettings,
    requestVramPrepare,
    describeVramResult,
} from "./client.js";
export { comfyWorkflow } from "./workflow.js";
export { t, tr, initI18n, getLang, setLang } from "./i18n.js";
export {
    getSettings,
    readJsonStorage,
    escapeHtml,
    updateSettings,
    readPref,
    writePref,
} from "./settings.js";
export { highlightJSON } from "./json.js";
export {
    TYPE_LABELS,
    MODEL_TYPES,
    RESERVED_GROUPS,
    BATCH_MODEL_TYPES,
    STACK_MODEL_TYPES,
    FETCH_MAP,
    GENUI_TYPE_MAP,
    SORT_COLUMNS,
    STATUS_FILTERS,
    VIEW_MODES,
    typeLabel,
    subdirOf,
    baseNameOf,
    extOf,
    isSlotType,
    isBatchType,
    isStackType,
} from "./model-constants.js";
export { runGeneration } from "./pipeline.js";
