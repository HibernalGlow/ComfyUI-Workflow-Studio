/**
 * views/models/state.js — the models view's own state factory, its persistence
 * and the small mutations every other models module shares.
 *
 * The state shape mirrors the upstream models tab one-for-one so the 18 features
 * of FRONTEND-OPTIMIZATION-BRIEF.md §4 behave identically, but nothing here is a
 * module-level singleton: `render()` builds one state object per mount.
 *
 * Storage: only `settings.readPref/writePref` (auto-prefixed `nu_`). The old UI's
 * keys are never read or written (brief §10 / FREEZE-NEWUI).
 *
 * Sections
 *   1. helpers + prefs            4. metadata (tags / memo / favourite / badges)
 *   2. state factory + local store 5. enable / disable (per model + per group)
 *   3. pagination                 6. type switching / filter resets
 */
import {
    RESERVED_GROUPS,
    BATCH_MODEL_TYPES,
    MODEL_TYPES,
    STACK_MODEL_TYPES,
    api,
    models as coreModels,
    readPref,
    t,
    writePref,
} from "../../core/index.js";

export const PAGE_SIZES = [24, 48, 96, 192];
export const DEFAULT_PAGE_SIZE = 48;

/** `t(key, fallback)` with the fallback actually honoured (core degrades to the key). */
export function tr(key, fallback) {
    const value = t(key, fallback);
    return value && value !== key ? value : fallback;
}

/* ------------------------------------------------------------------ prefs */

export function loadBadgePalette() {
    const palette = readPref("models_badge_palette", {});
    return palette && typeof palette === "object" ? palette : {};
}

export function loadCivitaiHost() {
    const host = readPref("civitai_host", "civitai.com");
    return typeof host === "string" && host ? host : "civitai.com";
}

export function saveViewMode(mode) {
    writePref("models_view", mode === "table" ? "table" : "thumb");
}

export function savePageSize(size) {
    writePref("models_page_size", Number(size) || DEFAULT_PAGE_SIZE);
}

export function saveBadgePalettePref(palette) {
    writePref("models_badge_palette", palette || {});
}

export function saveCivitaiHostPref(host) {
    writePref("civitai_host", host || "civitai.com");
}

/* ------------------------------------------------------------ state + store */

/** Every filter / sort / view default, matching the upstream default set. */
export function createModelsState() {
    const modelsByType = {};
    for (const type of MODEL_TYPES) modelsByType[type] = [];
    const storedSize = Number(readPref("models_page_size", DEFAULT_PAGE_SIZE));
    return {
        rev: 0,
        modelsByType,
        modelMetadata: {},
        modelGroups: {},
        allModelGroups: {}, // { type: { groupName: [models] } } — every type
        civitaiCache: {},
        disabledModels: {}, // { type: Set<modelName> }
        subdirs: [],
        selectMode: false,
        selectedModels: new Set(),
        searchText: "",
        tagFilter: "",
        badgeFilter: "",
        dirFilter: "",
        groupFilter: "",
        statusFilter: "all", // "all" | "enabled" | "disabled"
        showFavoritesOnly: false,
        showBatchOnly: false,
        viewMode: readPref("models_view", "thumb") === "table" ? "table" : "thumb",
        activeModelType: MODEL_TYPES[0],
        selectedModel: null,
        loaded: {},
        loading: false,
        error: null,
        currentPage: 0,
        pageSize: PAGE_SIZES.includes(storedSize) ? storedSize : DEFAULT_PAGE_SIZE,
        sortColumn: null, // fav | filename | subdir | civtype | basemodel | ext | tags | memo | enabled
        sortDir: "asc",
        badgePalette: loadBadgePalette(),
        civitaiHost: loadCivitaiHost(),
        civitaiRunning: false,
    };
}

/**
 * View-local, store-shaped subscription holder. Nested containers are mutated in
 * place (upstream style) and `rev` is bumped, so `setState` merges shallowly and
 * every listener re-reads the same object graph.
 */
export function createModelsStore(initial) {
    let state = initial || createModelsState();
    const listeners = new Set();
    return {
        getState() {
            return state;
        },
        setState(patch) {
            if (!patch || typeof patch !== "object") return state;
            state = { ...state, ...patch };
            for (const listener of Array.from(listeners)) {
                try {
                    listener(state);
                } catch (err) {
                    console.error("[newui/models] listener threw", err);
                }
            }
            return state;
        },
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        select(selector, listener) {
            let previous = selector(state);
            return this.subscribe(() => {
                const next = selector(state);
                if (Object.is(next, previous)) return;
                const last = previous;
                previous = next;
                listener(next, last);
            });
        },
    };
}

/** Force one render pass after in-place mutations. */
export function commit(store) {
    const state = store.getState();
    store.setState({ rev: (state.rev || 0) + 1 });
}

/* -------------------------------------------------------------- pagination */

export function pageCount(state, total) {
    if (!(state.pageSize > 0)) return 1;
    return Math.max(1, Math.ceil(total / state.pageSize));
}

export function clampPage(state, total) {
    const pages = pageCount(state, total);
    if (state.currentPage > pages - 1) state.currentPage = pages - 1;
    if (state.currentPage < 0) state.currentPage = 0;
    return state.currentPage;
}

/** The slice handed to the grid / table (feature 16). */
export function pageSlice(state, list) {
    if (!(state.pageSize > 0)) return list;
    const start = state.currentPage * state.pageSize;
    return list.slice(start, start + state.pageSize);
}

export function goToPage(store, page) {
    const state = store.getState();
    state.currentPage = Math.max(0, Number(page) || 0);
    commit(store);
}

export function setPageSize(store, size) {
    const next = PAGE_SIZES.includes(Number(size)) ? Number(size) : DEFAULT_PAGE_SIZE;
    const state = store.getState();
    state.pageSize = next;
    state.currentPage = 0;
    savePageSize(next);
    commit(store);
}

/* ---------------------------------------------------------------- metadata */

/** One server entry read, normalised like `core/models.js#entryOf`. */
export function entryOf(state, name) {
    return coreModels.entryOf(state.modelMetadata, name);
}

/** POST one partial metadata update and mirror the server entry back into state. */
export async function saveEntry(ui, name, updates) {
    try {
        const data = await coreModels.saveMetadata(name, updates);
        if (data && data.metadata) ui.store.getState().modelMetadata[name] = data.metadata;
        return data;
    } catch (err) {
        ui.snack(`${tr("saveFailed", "Save failed")}: ${err.message}`, "error");
        return null;
    }
}

/**
 * Sequential per-model writes (upstream order) for bulk favourite / badge.
 * `patchOf(entry)` returns the partial update, or `null` to skip the model.
 */
export async function saveEntries(ui, names, patchOf) {
    let count = 0;
    for (const name of names) {
        const entry = entryOf(ui.store.getState(), name);
        const patch = patchOf(entry);
        if (!patch) continue;
        await saveEntry(ui, name, patch);
        count += 1;
    }
    return count;
}

/* ---------------------------------------------------------- enable/disable */

export function disabledSetOf(state, type) {
    return state.disabledModels[type || state.activeModelType] || new Set();
}

export function isModelDisabled(state, name) {
    return disabledSetOf(state).has(name);
}

/** Flip one model relative to the client Set; the wire value is the new state. */
export async function toggleModelEnabled(ui, name) {
    const state = ui.store.getState();
    const type = state.activeModelType;
    const nowDisabled = isModelDisabled(state, name);
    const enabled = nowDisabled;
    try {
        await api.toggleModelEnabled(type, name, enabled);
        const set = state.disabledModels[type] || new Set();
        if (enabled) set.delete(name);
        else set.add(name);
        state.disabledModels[type] = set;
        ui.snack(tr("modelStatusWarning", "Model files changed on disk"), "info");
    } catch (err) {
        ui.snack(`${tr("modelToggleError", "Failed to toggle model")}: ${err.message}`, "error");
    }
}

/** Enable/disable every member of a group; only members the server reported `ok`. */
export async function setGroupEnabled(ui, groupName, enabled) {
    const state = ui.store.getState();
    const type = state.activeModelType;
    try {
        const data = await api.toggleGroupEnabled(type, groupName, enabled);
        const set = state.disabledModels[type] || new Set();
        for (const member of data?.ok || []) {
            if (enabled) set.delete(member);
            else set.add(member);
        }
        state.disabledModels[type] = set;
        const errCount = data?.errors?.length || 0;
        if (errCount > 0) ui.snack(`${errCount} ${tr("modelToggleError", "Failed to toggle model")}`, "warning");
        ui.snack(tr("modelStatusWarning", "Model files changed on disk"), "info");
    } catch (err) {
        ui.snack(`${tr("modelToggleError", "Failed to toggle model")}: ${err.message}`, "error");
    }
}

/* -------------------------------------------------- type switch / filters */

/**
 * Type switch reset semantics: filters, page, selection and the side panel are
 * cleared; sort order, the favourites/batch-only toggles and the view mode survive.
 */
export function switchType(store, type) {
    const state = store.getState();
    if (!MODEL_TYPES.includes(type)) return state;
    state.activeModelType = type;
    state.searchText = "";
    state.tagFilter = "";
    state.badgeFilter = "";
    state.dirFilter = "";
    state.groupFilter = "";
    state.statusFilter = "all";
    state.currentPage = 0;
    state.selectedModel = null;
    state.selectMode = false;
    state.selectedModels.clear();
    state.modelGroups = state.allModelGroups[type] || {};
    state.subdirs = [];
    return state;
}

export function clearFilters(store) {
    const state = store.getState();
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

export { MODEL_TYPES, RESERVED_GROUPS, BATCH_MODEL_TYPES, STACK_MODEL_TYPES };
