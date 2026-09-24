/**
 * views/models/sort.js — the 9-column sort (brief §4 item 3).
 *
 * Columns: fav / filename / subdir / civtype / basemodel / ext / tags / memo /
 * enabled. Sorting is the last step of the filter funnel (`filters.filterModels`)
 * and is applied to the already-filtered list, exactly like upstream.
 *
 * Comparison semantics are upstream's: keys are lower-cased strings except `fav`
 * and `enabled` (numeric 0|1), the direction multiplies by ±1 and ties keep their
 * relative order (stable sort).
 */
import { baseNameOf, extOf, subdirOf } from "../../core/index.js";
import { isModelDisabled, tr } from "./state.js";

/** Display metadata per column; `label` is resolved through i18n at render time. */
export const SORT_COLUMNS = [
    { key: "fav", label: "★", sortable: true, align: "center", width: "34px" },
    { key: "filename", i18n: "modelsFileName", fallback: "File name", sortable: true },
    { key: "subdir", i18n: "modelsSubdir", fallback: "Subdir", sortable: true },
    { key: "civtype", i18n: "civitaiType", fallback: "Civitai type", sortable: true },
    { key: "basemodel", i18n: "civitaiBaseModel", fallback: "Base model", sortable: true },
    { key: "ext", i18n: "modelsExt", fallback: "Ext", sortable: true },
    { key: "tags", i18n: "modelsTags", fallback: "Tags", sortable: true },
    { key: "memo", i18n: "modelsMemo", fallback: "Memo", sortable: true },
    { key: "enabled", label: "E/D", sortable: true, align: "center", width: "54px" },
];

export function sortColumnLabel(column) {
    return column.i18n ? tr(column.i18n, column.fallback) : column.label;
}

/** The value a column sorts on for one model (mirrors upstream `sortKeyOf`). */
export function sortKeyOf(state, modelName) {
    const meta = state.modelMetadata[modelName] || {};
    switch (state.sortColumn) {
        case "fav":
            return meta.favorite ? 1 : 0;
        case "filename":
            return baseNameOf(modelName).toLowerCase();
        case "subdir":
            return subdirOf(modelName).toLowerCase();
        case "civtype": {
            const civ = meta.sha256 && state.civitaiCache[meta.sha256];
            return String(civ?.type || "").toLowerCase();
        }
        case "basemodel": {
            const civ = meta.sha256 && state.civitaiCache[meta.sha256];
            return String(civ?.baseModel || "").toLowerCase();
        }
        case "ext":
            return extOf(modelName).toLowerCase();
        case "tags":
            return (meta.tags || []).join(", ").toLowerCase();
        case "memo":
            return String(meta.memo || "").toLowerCase();
        case "enabled":
            return isModelDisabled(state, modelName) ? 1 : 0;
        default:
            return 0;
    }
}

/** One key per model, then a plain `<`/`>` comparator (upstream's optimisation). */
export function sortModels(state, models) {
    if (!state.sortColumn) return models;
    const sign = state.sortDir === "asc" ? 1 : -1;
    return models
        .map((name) => [sortKeyOf(state, name), name])
        .sort((a, b) => (a[0] < b[0] ? -sign : a[0] > b[0] ? sign : 0))
        .map((pair) => pair[1]);
}

/**
 * Three-state cycle: new column → asc, same column asc → desc, same column desc
 * → sorting cleared (the original array order returns). Returns the next
 * `{ sortColumn, sortDir }` without touching the state.
 */
export function nextSort(state, column) {
    if (state.sortColumn !== column) return { sortColumn: column, sortDir: "asc" };
    if (state.sortDir === "asc") return { sortColumn: column, sortDir: "desc" };
    return { sortColumn: null, sortDir: "asc" };
}

export function sortLabel(state, column) {
    if (state.sortColumn !== column) return "";
    return state.sortDir === "asc" ? "▲" : "▼";
}

/** Applies the cycle to the state (used by both views' headers). */
export function applySort(state, column) {
    const next = nextSort(state, column);
    state.sortColumn = next.sortColumn;
    state.sortDir = next.sortDir;
    state.currentPage = 0;
    return next;
}
