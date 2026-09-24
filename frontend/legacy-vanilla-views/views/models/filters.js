/**
 * views/models/filters.js — the single filter funnel (brief §4 item 4).
 *
 * Predicate order is observable and matches upstream: status → favourites-only →
 * batch-only → tag → badge → dir → group → search → sort. Every predicate narrows
 * the previous list; tag/badge matching is exact and case-sensitive, search is a
 * lower-cased substring test over `name + tags + memo`.
 */
import { MODEL_TYPES, subdirOf, typeLabel } from "../../core/index.js";
import { sortModels } from "./sort.js";
import { getAllTags } from "./tags.js";
import { isModelDisabled, tr } from "./state.js";

export function getCurrentModels(state) {
    return state.modelsByType[state.activeModelType] || [];
}

export { isModelDisabled };

export function filterModels(state) {
    let models = getCurrentModels(state);

    if (state.statusFilter === "enabled") {
        models = models.filter((name) => !isModelDisabled(state, name));
    } else if (state.statusFilter === "disabled") {
        models = models.filter((name) => isModelDisabled(state, name));
    }

    if (state.showFavoritesOnly) {
        models = models.filter((name) => Boolean(state.modelMetadata[name]?.favorite));
    }

    if (state.showBatchOnly) {
        const members = state.modelGroups.Batch || [];
        models = models.filter((name) => members.includes(name));
    }

    if (state.tagFilter) {
        models = models.filter((name) => (state.modelMetadata[name]?.tags || []).includes(state.tagFilter));
    }

    if (state.badgeFilter) {
        models = models.filter((name) => (state.modelMetadata[name]?.badges || []).includes(state.badgeFilter));
    }

    if (state.dirFilter) {
        models = models.filter((name) => subdirOf(name) === state.dirFilter);
    }

    if (state.groupFilter) {
        const members = state.modelGroups[state.groupFilter] || [];
        models = models.filter((name) => members.includes(name));
    }

    if (state.searchText) {
        const query = state.searchText.toLowerCase();
        models = models.filter((name) => {
            const meta = state.modelMetadata[name];
            return [name, ...(meta?.tags || []), meta?.memo || ""].join(" ").toLowerCase().includes(query);
        });
    }

    return sortModels(state, models);
}

/* --------------------------------------------------------- option builders */

export function statusOptions() {
    return [
        { value: "all", label: tr("modelsStatusAll", "All") },
        { value: "enabled", label: tr("modelsStatusEnabled", "Enabled only") },
        { value: "disabled", label: tr("modelsStatusDisabled", "Disabled only") },
    ];
}

export function viewModeOptions() {
    return [
        { value: "thumb", label: tr("modelsViewThumb", "Thumbnails") },
        { value: "table", label: tr("modelsViewTable", "Table") },
    ];
}

/** Directory filter entries come from the loaded model names (root only). */
export function dirOptions(state) {
    const dirs = [...new Set(getCurrentModels(state).map(subdirOf).filter((dir) => dir !== ""))].sort();
    return dirs.map((dir) => ({ value: dir, label: dir }));
}

export function tagOptions(state) {
    return getAllTags(state).map((tag) => ({ value: tag, label: tag }));
}

/** `"{type}::{group}"` — the group dropdown lists every type, like upstream. */
export function groupOptions(state) {
    const options = [];
    for (const type of MODEL_TYPES) {
        const groups = state.allModelGroups[type] || {};
        for (const name of Object.keys(groups).sort()) {
            options.push({ value: `${type}::${name}`, label: `${name} (${typeLabel(type)})` });
        }
    }
    return options;
}

export function parseGroupOption(value) {
    const index = typeof value === "string" ? value.indexOf("::") : -1;
    if (index === -1) return { type: "", group: "" };
    return { type: value.slice(0, index), group: value.slice(index + 2) };
}

/** Current dropdown value of the group filter. */
export function groupFilterValue(state) {
    return state.groupFilter ? `${state.activeModelType}::${state.groupFilter}` : "";
}

/** Every filter change resets the page (brief §4 item 16). */
export function applyFilter(store, patch) {
    const state = store.getState();
    Object.assign(state, patch);
    state.currentPage = 0;
    return state;
}

export function clearAllFilters(state) {
    state.searchText = "";
    state.tagFilter = "";
    state.badgeFilter = "";
    state.dirFilter = "";
    state.groupFilter = "";
    state.statusFilter = "all";
    state.showFavoritesOnly = false;
    state.showBatchOnly = false;
    state.currentPage = 0;
    return state;
}

export function activeFilterSummary(state) {
    const chips = [];
    if (state.searchText) chips.push(state.searchText);
    if (state.tagFilter) chips.push(`#${state.tagFilter}`);
    if (state.badgeFilter) chips.push(state.badgeFilter);
    if (state.dirFilter) chips.push(state.dirFilter);
    if (state.groupFilter) chips.push(state.groupFilter);
    if (state.statusFilter !== "all") chips.push(state.statusFilter);
    if (state.showFavoritesOnly) chips.push(tr("modelsFavorite", "Favorite"));
    if (state.showBatchOnly) chips.push("Batch");
    return chips;
}
