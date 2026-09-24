/**
 * core/model-constants.js — static model-type tables
 *
 * Copied verbatim (as data) from the upstream `static/js/models/state.js`.
 * core must NOT import that module: it owns mutable state and reads the old
 * UI's `wfm_models_view` localStorage key, so importing it would make the two
 * UIs fight over the same storage. These tables are pure data with no state.
 */

/** Model types that support a "Batch" group (consumed by the Generate batch panel). */
export const RESERVED_GROUPS = ["Batch", "Stack"];

/** Model types the Batch grouping feature applies to. */
export const BATCH_MODEL_TYPES = ["checkpoint", "lora"];

/** Model types the Stack grouping feature applies to. */
export const STACK_MODEL_TYPES = ["lora"];

/** Display labels per model type. */
export const TYPE_LABELS = {
    checkpoint: "Checkpoint",
    lora: "LoRA",
    vae: "VAE",
    controlnet: "ControlNet",
    unet: "UNET",
    textencoder: "TextEncoder",
    hypernetwork: "Hypernetwork",
    embedding: "Embedding",
};

/** The 8 model types, in navigation order. */
export const MODEL_TYPES = [
    "checkpoint",
    "lora",
    "vae",
    "controlnet",
    "unet",
    "textencoder",
    "hypernetwork",
    "embedding",
];

/**
 * Per-type fetch descriptor.
 *
 * `client` names the method on the re-exported `comfyUI` object (core/client.js)
 * used to list files, and `inputKey` is the ComfyUI node input this type feeds —
 * together with GENUI_TYPE_MAP this is what lets `applyToGenUI` be a pure call
 * instead of a DOM poke.
 *
 * `embedding` has no ComfyUI node input: upstream fetches it from the backend
 * (`comfyUI.fetchEmbeddings()` -> `/api/wfm/models/files?type=embedding`) and
 * applies it as prompt text, hence `inputKey: null`.
 */
export const FETCH_MAP = {
    checkpoint: { client: "fetchCheckpoints", inputKey: "ckpt_name" },
    lora: { client: "fetchLoras", inputKey: "lora_name" },
    vae: { client: "fetchVaes", inputKey: "vae_name" },
    controlnet: { client: "fetchControlNets", inputKey: "control_net_name" },
    unet: { client: "fetchDiffusionModels", inputKey: "unet_name" },
    textencoder: { client: "fetchTextEncoders", inputKey: "clip_name1" },
    hypernetwork: { client: "fetchHypernetworks", inputKey: "hypernetwork_name" },
    embedding: { client: "fetchEmbeddings", inputKey: null },
};

/**
 * Which Generate-view model-list slot a model type applies to.
 * `embedding` is intentionally absent — it is applied to the prompt, not a slot.
 */
export const GENUI_TYPE_MAP = {
    checkpoint: { key: "checkpoints", inputKey: "ckpt_name" },
    lora: { key: "loras", inputKey: "lora_name" },
    vae: { key: "vaes", inputKey: "vae_name" },
    controlnet: { key: "controlNets", inputKey: "control_net_name" },
    unet: { key: "diffusionModels", inputKey: "unet_name" },
    textencoder: { key: "textEncoders", inputKey: "clip_name1" },
    hypernetwork: { key: "hypernetworks", inputKey: "hypernetwork_name" },
};

/** Sortable table columns, in display order. Matches upstream `sortColumn` values. */
export const SORT_COLUMNS = [
    "fav",
    "filename",
    "subdir",
    "civtype",
    "basemodel",
    "ext",
    "tags",
    "memo",
    "enabled",
];

/** Status filter values. */
export const STATUS_FILTERS = ["all", "enabled", "disabled"];

/** View modes. */
export const VIEW_MODES = ["thumb", "table"];

/**
 * A badge palette is `{ [badgeLabel]: cssColor }`; an untouched palette is empty.
 * There is no built-in default colour — upstream's shape is a bare label→colour map
 * (models-spec §2.4), and newui leaves the colour decision to CSS tokens when a label
 * has no entry, so no colour literal lives in core or newui.
 */
export const DEFAULT_BADGE_PALETTE = {};

export function typeLabel(type) {
    return TYPE_LABELS[type] || type;
}

/** `"a/b/c.safetensors"` -> `"a/b"` ("" at the root). */
export function subdirOf(filename) {
    const i = String(filename || "").lastIndexOf("/");
    return i === -1 ? "" : filename.slice(0, i);
}

/** `"a/b/c.safetensors"` -> `"c.safetensors"` */
export function baseNameOf(filename) {
    const s = String(filename || "");
    const i = s.lastIndexOf("/");
    return i === -1 ? s : s.slice(i + 1);
}

/** `"model.safetensors"` -> `"safetensors"` (lowercase). */
export function extOf(filename) {
    const s = baseNameOf(filename);
    const i = s.lastIndexOf(".");
    return i === -1 ? "" : s.slice(i + 1).toLowerCase();
}

/** Model types that can be swapped into a workflow slot. */
export function isSlotType(type) {
    return Object.prototype.hasOwnProperty.call(GENUI_TYPE_MAP, type);
}

/** Model types that can be grouped for batch selection. */
export function isBatchType(type) {
    return BATCH_MODEL_TYPES.includes(type);
}

/** Model types that can be grouped for stacking. */
export function isStackType(type) {
    return STACK_MODEL_TYPES.includes(type);
}
