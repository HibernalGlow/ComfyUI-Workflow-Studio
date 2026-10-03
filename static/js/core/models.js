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

// --- auto badges from CivitAI base model info -------------------------------

// [pattern, label, colour] — first match wins, so the specific families come first. Kept in sync
// with upstream's static/js/models/auto-badge.js: both UIs must collapse the same `baseModel`
// string ("SDXL 1.0", "SD 1.5", "flux.1-dev") into the same label and colour.
const BADGE_FAMILY_RULES = [
    [/^pony/i, "Pony", "#d946ef"],
    [/^illustrious/i, "Illustrious", "#f59e0b"],
    [/^noobai/i, "NoobAI", "#14b8a6"],
    [/^sdxl|^sd ?xl/i, "SDXL", "#3b82f6"],
    [/^sd ?1\.[45]/i, "SD1.5", "#22c55e"],
    [/^sd ?2/i, "SD2", "#84cc16"],
    [/^sd ?3/i, "SD3", "#06b6d4"],
    [/^flux\.?1|^flux$/i, "Flux.1", "#ef4444"],
    [/^flux\.?2/i, "Flux.2", "#dc2626"],
    [/^qwen/i, "Qwen", "#8b5cf6"],
    [/^wan/i, "Wan", "#0ea5e9"],
    [/^z-?image/i, "Z-Image", "#ec4899"],
    [/^hidream/i, "HiDream", "#f97316"],
    [/^hunyuan/i, "Hunyuan", "#6366f1"],
    [/^chroma/i, "Chroma", "#a855f7"],
    [/^lumina/i, "Lumina", "#10b981"],
    [/^auraflow/i, "AuraFlow", "#64748b"],
    [/^kolors/i, "Kolors", "#e11d48"],
];
const BADGE_SKIP_VALUES = new Set(["", "other", "unknown"]);
const BADGE_FALLBACK_COLOURS = ["#0891b2", "#7c3aed", "#be185d", "#b45309", "#4d7c0f", "#475569"];

/**
 * Badge derived from a CivitAI `baseModel` string, or `null` when it carries no category. An
 * unrecognised value still gets a badge (the raw string) with a colour hashed from it, so two runs
 * over the same library always produce the same palette.
 */
export function baseModelToBadge(baseModel) {
    const raw = String(baseModel || "").trim();
    if (BADGE_SKIP_VALUES.has(raw.toLowerCase())) return null;
    for (const [re, label, colour] of BADGE_FAMILY_RULES) {
        if (re.test(raw)) return { label, colour };
    }
    let h = 0;
    for (const ch of raw) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return { label: raw, colour: BADGE_FALLBACK_COLOURS[h % BADGE_FALLBACK_COLOURS.length] };
}

/**
 * Which badge each model of one type would get: `{assignments:[{model,label}], labels:Map(label →
 * {colour, count}), noInfo}`. Only a model whose cached metadata carries a sha256, and whose sha256
 * is in the CivitAI cache, contributes — upstream's `autoBadgeNoInfo` counts the rest.
 */
export function planAutoBadges(names, metadata, civitaiCache) {
    const assignments = [];
    const labels = new Map();
    let noInfo = 0;
    for (const model of names || []) {
        const sha = entryOf(metadata, model).sha256;
        const civ = sha && civitaiCache?.[sha];
        const badge = civ ? baseModelToBadge(civ.baseModel) : null;
        if (!badge) { noInfo++; continue; }
        assignments.push({ model, label: badge.label });
        const entry = labels.get(badge.label) || { colour: badge.colour, count: 0 };
        entry.count++;
        labels.set(badge.label, entry);
    }
    return { assignments, labels, noInfo };
}

/**
 * Palette the plan would write: labels actually being applied are added, and an existing label is
 * recoloured only when `overwrite` is on (upstream's dialog defaults it to checked).
 */
export function mergeAutoBadgePalette(palette, plan, { overwrite = true } = {}) {
    const used = new Set(plan.assignments.map((a) => a.label));
    const next = { ...(palette || {}) };
    for (const [label, info] of plan.labels) {
        if (!used.has(label)) continue;
        if (!(label in next) || overwrite) next[label] = info.colour;
    }
    return next;
}

/**
 * Models the plan should touch: with `skipExisting` (upstream's second checkbox) a model that
 * already carries any badge drops out.
 */
export function autoBadgeTargets(plan, metadata, { skipExisting = false } = {}) {
    return skipExisting
        ? plan.assignments.filter(({ model }) => entryOf(metadata, model).badges.length === 0)
        : plan.assignments;
}

/**
 * Append each planned label to its model's badges, 8 writes in flight like upstream. Returns how
 * many models were written — a model already carrying the label is skipped, as is every badged
 * model when `skipExisting` is on.
 */
export async function assignAutoBadges(plan, metadata, { skipExisting = false } = {}) {
    const todo = autoBadgeTargets(plan, metadata, { skipExisting })
        .filter(({ model, label }) => !entryOf(metadata, model).badges.includes(label));
    for (let i = 0; i < todo.length; i += 8) {
        await Promise.all(todo.slice(i, i + 8).map(({ model, label }) => (
            saveMetadata(model, { badges: [...entryOf(metadata, model).badges, label] })
        )));
    }
    return todo.length;
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

/**
 * Absolute http(s) only, else "". A cached CivitAI record is remote data, and its `images[0]` is
 * fed straight into an <img src> — upstream v0.7.11 wrapped every such URL in `safeHttpUrl`
 * (static/js/util.js) for exactly that reason, so a `javascript:` / `data:` / relative value can
 * never leave the cache and reach the page. Same rule, same acceptance, no DOM here.
 */
export function safeRemoteUrl(url) {
    const s = String(url ?? "").trim();
    if (!/^https?:\/\/[^\s]+$/i.test(s)) return "";
    try {
        void new URL(s);
        return s;
    } catch {
        return "";
    }
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
