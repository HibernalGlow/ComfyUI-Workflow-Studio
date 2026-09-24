/**
 * core/models.js — model metadata / groups / badges / disabled / favourites /
 * Civitai read-write layer.
 *
 * Pure data access + pure transforms over `api`. No DOM, no module-level mutable
 * state: callers own the state and pass it in.
 *
 * Storage policy (brief §10): the old UI's keys are forbidden here.
 *   - `wfm_models_view`               -> newui uses prefs key "models_view"
 *   - `wfm_models_badge_palette`      -> newui uses prefs key "models_badge_palette"
 *   - `wfm_civitai_host`              -> newui uses prefs key "civitai_host"
 * Badge *assignments* and tags/memo/favourites are server-side metadata, so they
 * carry over between the two UIs regardless.
 */

import * as api from "./api.js";
import { readPref, writePref } from "./settings.js";
import { DEFAULT_BADGE_PALETTE, subdirOf, baseNameOf, extOf } from "./model-constants.js";

// --- metadata ---------------------------------------------------------------

/** Whole metadata map: `{ [modelName]: {tags, favorite, memo, sha256?, badges?} }`. */
export async function loadMetadata() {
    const data = await api.getModelMetadata();
    return data && typeof data === "object" ? data : {};
}

/**
 * Persist a partial metadata update for one model.
 * @returns {Promise<object>} the stored entry as the server returns it
 */
export async function saveMetadata(modelName, updates) {
    return api.saveModelMetadata(modelName, updates);
}

/** Normalised read of one entry — the server omits legacy fields. */
export function entryOf(metadata, modelName) {
    const e = metadata?.[modelName];
    return {
        tags: Array.isArray(e?.tags) ? e.tags : [],
        favorite: e?.favorite === true,
        memo: typeof e?.memo === "string" ? e.memo : "",
        sha256: e?.sha256 || "",
        badges: Array.isArray(e?.badges) ? e.badges : [],
        updatedAt: e?.updatedAt || "",
    };
}

/** New entry value with `favorite` flipped. */
export function toggleFavorite(metadata, modelName) {
    const entry = entryOf(metadata, modelName);
    return { ...entry, favorite: !entry.favorite };
}

/** Merge `patch.tags`/`memo`/`badges`/`favorite` onto an entry (pure). */
export function mergeEntry(entry, patch) {
    const next = { ...entry };
    if (Array.isArray(patch.tags)) next.tags = patch.tags;
    if (typeof patch.memo === "string") next.memo = patch.memo;
    if (Array.isArray(patch.badges)) next.badges = patch.badges;
    if (typeof patch.favorite === "boolean") next.favorite = patch.favorite;
    return next;
}

/** Add/remove one tag, returning the new array (pure). */
export function withTag(entry, tag, on) {
    const tags = new Set(entry.tags || []);
    if (on) tags.add(tag);
    else tags.delete(tag);
    return [...tags];
}

export function withBadge(entry, badge, on) {
    const badges = new Set(entry.badges || []);
    if (on) badges.add(badge);
    else badges.delete(badge);
    return [...badges];
}

// --- tags -------------------------------------------------------------------

/**
 * Aggregate every tag used across the given model names, sorted.
 * (upstream `getAllTags` read the same way — see models-spec §3.6)
 */
export function aggregateTags(metadata, modelNames) {
    const names = Array.isArray(modelNames) ? modelNames : Object.keys(metadata || {});
    const out = new Set();
    for (const name of names) {
        for (const tag of entryOf(metadata, name).tags) out.add(tag);
    }
    return [...out].sort((a, b) => a.localeCompare(b));
}

/** All badges referenced by metadata, unioned with the palette labels, sorted. */
export function aggregateBadges(metadata, modelNames, palette) {
    const out = new Set(Object.keys(palette || {}));
    const names = Array.isArray(modelNames) ? modelNames : Object.keys(metadata || {});
    for (const name of names) {
        for (const badge of entryOf(metadata, name).badges) out.add(badge);
    }
    out.delete("");
    return [...out].sort((a, b) => a.localeCompare(b));
}

// --- groups -----------------------------------------------------------------

/**
 * Groups of one model type: `{ [groupName]: string[] }`.
 * The endpoint replaces the whole per-type map, so every save must send the
 * complete object (see models-spec §2.3).
 */
export async function loadGroups(type) {
    const data = await api.getModelGroups(type);
    return data && typeof data === "object" ? data : {};
}

export async function saveGroups(type, groups) {
    return api.saveModelGroups(type, groups);
}

/** Add/remove members, returning a new group map (pure). */
export function withMembers(groups, groupName, names, on) {
    const next = { ...(groups || {}) };
    const set = new Set(next[groupName] || []);
    for (const n of names) {
        if (on) set.add(n);
        else set.delete(n);
    }
    next[groupName] = [...set];
    return next;
}

/** Drop a group entirely (pure). */
export function withoutGroup(groups, groupName) {
    const next = { ...(groups || {}) };
    delete next[groupName];
    return next;
}

/** Rename a group, keeping membership (pure). */
export function renameGroup(groups, from, to) {
    if (!groups?.[from] || !to || from === to) return { ...(groups || {}) };
    const next = { ...groups };
    next[to] = next[from];
    delete next[from];
    return next;
}

/** Every group a model currently belongs to. */
export function groupsOf(groups, modelName) {
    return Object.entries(groups || {})
        .filter(([, members]) => members.includes(modelName))
        .map(([name]) => name);
}

// --- badges palette ---------------------------------------------------------

/** `{ [label]: cssColor }`. Never returns null; empty until the user edits it. */
export function getBadgePalette() {
    const p = readPref("models_badge_palette", null);
    return p && typeof p === "object" ? p : { ...DEFAULT_BADGE_PALETTE };
}

export function saveBadgePalette(palette) {
    return writePref("models_badge_palette", palette || {});
}

/** Colour for a label, or `null` so the caller can fall back to a design token. */
export function badgeColor(palette, label) {
    const c = palette?.[label];
    return typeof c === "string" && c ? c : null;
}

// --- enable / disable -------------------------------------------------------

/** `Set` of disabled file names for a type. */
export async function loadDisabled(type) {
    const list = await api.getDisabledModels(type);
    return new Set(Array.isArray(list) ? list : []);
}

export async function setEnabled(type, modelName, enabled) {
    return api.toggleModelEnabled(type, modelName, enabled);
}

export async function setGroupEnabled(type, groupName, enabled) {
    return api.toggleGroupEnabled(type, groupName, enabled);
}

export function isEnabled(disabledSet, modelName) {
    return !(disabledSet?.has?.(modelName) ?? false);
}

// --- Civitai ----------------------------------------------------------------

export function getCivitaiHost() {
    const h = readPref("civitai_host", "civitai.com");
    return typeof h === "string" && h ? h : "civitai.com";
}

export function setCivitaiHost(host) {
    return writePref("civitai_host", host || "civitai.com");
}

export async function loadCivitaiCache() {
    const data = await api.getCivitaiCache();
    return data && typeof data === "object" ? data : {};
}

/** Look a record up by sha256 first, then by file name. */
export function civitaiFor(cache, { sha256, name } = {}) {
    if (!cache) return null;
    if (sha256 && cache[sha256]) return cache[sha256];
    if (name && cache[name]) return cache[name];
    return null;
}

/**
 * Build the Civitai page URL for a cached record (pure).
 * Mirrors upstream `renderCivitaiInfo`'s URL logic, including the
 * `/model-versions/` fallback when no modelId is known.
 */
export function civitaiUrl(record, host = getCivitaiHost()) {
    const h = host || "civitai.com";
    const base = `https://${h}`;
    const modelId = record?.modelId ?? record?.model_id ?? null;
    const versionId = record?.id ?? record?.versionId ?? record?.version_id ?? null;
    if (modelId && versionId) {
        return `${base}/models/${modelId}?modelVersionId=${versionId}`;
    }
    if (versionId) return `${base}/model-versions/${versionId}`;
    if (modelId) return `${base}/models/${modelId}`;
    return null;
}

export function fetchCivitai(type, name) {
    return api.fetchCivitai(type, name);
}

/**
 * Batch fetch with SSE progress. `onProgress({current,total,model,status})`.
 * Returns the `done` payload: `{total, found, not_found, errors, hashes, preview_saved}`.
 */
export function batchFetchCivitai(type, models, onProgress, signal) {
    return api.batchCivitai(type, models, onProgress, signal);
}

// --- preview ----------------------------------------------------------------

export function previewUrl(type, name) {
    return api.modelPreviewUrl(type, name);
}

// --- Generate-view bridge ---------------------------------------------------

const GENUI_TARGETS = {
    checkpoint: { slot: "checkpoints", inputKey: "ckpt_name", mode: "slot" },
    lora: { slot: "loras", inputKey: "lora_name", mode: "slot" },
    vae: { slot: "vaes", inputKey: "vae_name", mode: "slot" },
    controlnet: { slot: "controlNets", inputKey: "control_net_name", mode: "slot" },
    unet: { slot: "diffusionModels", inputKey: "unet_name", mode: "slot" },
    textencoder: { slot: "textEncoders", inputKey: "clip_name1", mode: "slot" },
    hypernetwork: { slot: "hypernetworks", inputKey: "hypernetwork_name", mode: "slot" },
    embedding: { slot: null, inputKey: null, mode: "prompt" },
};

/**
 * Where a model type lands in the Generate view's model slots.
 * Returns `null` for types that are not slot-backed (`embedding`).
 * The caller applies this to its own state — never to the DOM.
 */
export function genUiTarget(modelType) {
    const target = GENUI_TARGETS[modelType];
    return target ? { ...target } : null;
}

/** `embedding:name` token to append to a positive prompt. */
export function embeddingPromptToken(modelName) {
    return `embedding:${baseNameOf(modelName)}`;
}

/**
 * Append an embedding token to prompt text, idempotently (pure).
 * Mirrors upstream `applyEmbeddingToPrompt`.
 */
export function appendEmbedding(promptText, modelName) {
    const token = embeddingPromptToken(modelName);
    const text = String(promptText || "");
    if (text.includes(token)) return text;
    return text.trim() ? `${text.trim()} ${token}` : token;
}

// --- derived record ---------------------------------------------------------

/** The display record the models view renders — one shape for both views. */
export function decorate(type, name, metadata, { disabledSet, civitaiCache, groups } = {}) {
    const entry = entryOf(metadata, name);
    const record = civitaiFor(civitaiCache, { sha256: entry.sha256, name }) || {};
    return {
        name,
        base: baseNameOf(name),
        subdir: subdirOf(name),
        ext: extOf(name),
        tags: entry.tags,
        memo: entry.memo,
        badges: entry.badges,
        favorite: entry.favorite,
        sha256: entry.sha256,
        enabled: isEnabled(disabledSet, name),
        groups: groupsOf(groups, name),
        civitai: record,
        civType: record?.type || record?.model?.type || "",
        baseModel: record?.baseModel || record?.base_model || record?.model?.baseModel || "",
        previewUrl: previewUrl(type, name),
    };
}
