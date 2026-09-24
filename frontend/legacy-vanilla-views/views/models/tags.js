/**
 * views/models/tags.js — tag aggregation + the tag edit format (brief §4 item 6).
 *
 * Tags live in the server-side metadata record (`meta.tags: string[]`). They are
 * aggregated for the filter dropdown from the **current model type only** (upstream
 * `getAllTags`) and edited through one comma-separated text field.
 *
 * Edit format is upstream-exact: `value.split(",").map(trim).filter(Boolean)` — no
 * de-duplication, no upper/lower-casing. Matching in filters.js is an exact,
 * case-sensitive `Array.includes`.
 */
import { models as coreModels } from "../../core/index.js";
import { entryOf, saveEntry } from "./state.js";

/** Sorted union of every tag used by the models of the active type. */
export function getAllTags(state) {
    return coreModels.aggregateTags(state.modelMetadata, state.modelsByType[state.activeModelType] || []);
}

/** Comma-separated text → string[] (upstream's exact split, duplicates kept). */
export function parseTagInput(value) {
    return String(value || "")
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean);
}

/** string[] → the text shown in the edit field. */
export function formatTags(tags) {
    return (tags || []).join(", ");
}

/** Pure add/remove of one tag on an entry (delegates to core). */
export function withTag(entry, tag, on) {
    return coreModels.withTag(entry, tag, on);
}

export function tagsOf(state, name) {
    return entryOf(state, name).tags;
}

export function hasTag(state, name, tag) {
    return tagsOf(state, name).includes(tag);
}

/** Model names of the active type that carry a tag (used by the tag filter). */
export function modelsWithTag(state, tag) {
    const models = state.modelsByType[state.activeModelType] || [];
    return models.filter((name) => hasTag(state, name, tag));
}

/** Persist the tag field of one model (side panel / detail dialog save). */
export async function saveTags(ui, name, tags) {
    return saveEntry(ui, name, { tags });
}

/** Persist tags + memo together — the two-field save both editors use. */
export async function saveTagsAndMemo(ui, name, { tags, memo }) {
    return saveEntry(ui, name, { tags, memo });
}
