/**
 * views/models/table-view.js — the 9-sortable-column table (brief §4 items 2, 3).
 *
 * Built on the frozen `DataTable` component (`createDataTable`), which owns the
 * `aria-sort` state, the keyboard-operable headers and the row checkboxes. This
 * module only supplies:
 *   - the column defs from `sort.js` (fav / filename / subdir / civtype / basemodel /
 *     ext / tags / memo / enabled) plus the thumbnail, Batch and Stack cells;
 *   - the sort cycle adapter: the component toggles asc → desc, the view's cycle adds
 *     the third "clear sort" state (upstream behaviour);
 *   - the per-row actions (favourite, enable/disable, batch/stack, selection).
 *
 * Re-rendering a table would drop keyboard focus, so a sort click updates the state,
 * re-sorts in place with `setRows()` and re-syncs the header with `setSort()`.
 */
import { baseNameOf, isBatchType, isStackType, subdirOf, extOf } from "../../core/index.js";
import { createDataTable } from "../../components/DataTable.js";
import { createIconButton } from "../../components/IconButton.js";
import { attachLazyPreviews, createThumb } from "./preview.js";
import { filterModels } from "./filters.js";
import { isInBatch, isInStack, toggleBatchForModel, toggleStackForModel } from "./groups.js";
import { toggleFavorite } from "./grid-view.js";
import { SORT_COLUMNS, applySort, sortColumnLabel } from "./sort.js";
import { commit, isModelDisabled, pageSlice, toggleModelEnabled, tr } from "./state.js";

/** One plain row object per model — the component's `row[col.key]` fallback path. */
function toRow(state, name) {
    const meta = state.modelMetadata[name] || {};
    const sha = meta.sha256;
    const civitai = sha ? state.civitaiCache[sha] : null;
    return {
        id: name,
        name,
        base: baseNameOf(name),
        subdir: subdirOf(name),
        ext: extOf(name),
        civtype: civitai?.type || "",
        basemodel: civitai?.baseModel || "",
        tags: (meta.tags || []).join(", "),
        memo: meta.memo || "",
        favorite: Boolean(meta.favorite),
        enabled: !isModelDisabled(state, name),
    };
}

function cellText(value, title) {
    const span = document.createElement("span");
    span.textContent = value;
    if (title) span.title = title;
    return span;
}

function buildColumns(ui) {
    const state = ui.store.getState();
    const { batch, stack } = { batch: isBatchType(state.activeModelType), stack: isStackType(state.activeModelType) };
    const columns = [];

    columns.push({
        key: "fav",
        label: "★",
        sortable: true,
        align: "center",
        width: "38px",
        render: (row) => {
            const on = Boolean(ui.store.getState().modelMetadata[row.id]?.favorite);
            const button = createIconButton({
                icon: on ? "★" : "☆",
                ariaLabel: tr("modelsFavorite", "Favorite"),
                toggle: true,
                pressed: on,
                onClick: () => toggleFavorite(ui, row.id),
            });
            button.dataset.focusKey = `fav:${row.id}`;
            return button;
        },
    });

    columns.push({
        key: "thumb",
        label: "",
        width: "52px",
        render: (row) => {
            const thumb = createThumb(ui, row.id, { alt: row.base });
            thumb.root.classList.add("nu-models-thumb--table");
            return thumb.root;
        },
    });

    for (const def of SORT_COLUMNS) {
        if (def.key === "fav" || def.key === "enabled") continue;
        columns.push({
            key: def.key,
            label: sortColumnLabel(def),
            sortable: true,
            align: def.align,
            width: def.width,
            render: (row) => {
                if (def.key === "filename") return cellText(row.base, row.name);
                return cellText(String(row[def.key] ?? ""));
            },
        });
    }

    columns.push({
        key: "enabled",
        label: "E/D",
        sortable: true,
        align: "center",
        width: "52px",
        render: (row) => {
            const disabled = isModelDisabled(ui.store.getState(), row.id);
            const button = createIconButton({
                icon: disabled ? "▶" : "⏸",
                ariaLabel: disabled ? tr("modelEnable", "Enable") : tr("modelDisable", "Disable"),
                onClick: () => toggleModelEnabled(ui, row.id).then(() => commit(ui.store)),
            });
            button.dataset.focusKey = `enable:${row.id}`;
            return button;
        },
    });

    if (batch) {
        columns.push({
            key: "batch",
            label: "B",
            align: "center",
            width: "44px",
            render: (row) => {
                const button = createIconButton({
                    icon: "B",
                    ariaLabel: tr("modelsBatch", "Batch"),
                    toggle: true,
                    pressed: isInBatch(ui.store.getState(), row.id),
                    onClick: () => toggleBatchForModel(ui, row.id).then(() => commit(ui.store)),
                });
                button.dataset.focusKey = `batch:${row.id}`;
                return button;
            },
        });
    }
    if (stack) {
        columns.push({
            key: "stack",
            label: "S",
            align: "center",
            width: "44px",
            render: (row) => {
                const button = createIconButton({
                    icon: "S",
                    ariaLabel: "Stack",
                    toggle: true,
                    pressed: isInStack(ui.store.getState(), row.id),
                    onClick: () => toggleStackForModel(ui, row.id).then(() => commit(ui.store)),
                });
                button.dataset.focusKey = `stack:${row.id}`;
                return button;
            },
        });
    }
    return columns;
}

/** Table view for the page slice; returns the live component handle. */
export function renderTable(host, ui, models) {
    const state = ui.store.getState();
    const rows = models.map((name) => toRow(state, name));
    let table = null;

    table = createDataTable({
        columns: buildColumns(ui),
        rows,
        sortKey: state.sortColumn,
        sortDir: state.sortDir,
        rowKey: "id",
        selectable: state.selectMode,
        selectedKeys: state.selectedModels,
        emptyText: tr("modelsNoModels", "No models"),
        onSelectChange: (keys) => {
            const next = ui.store.getState();
            next.selectedModels = new Set(keys);
            commit(ui.store);
        },
        onRowClick: (row) => ui.showDetail?.(row.id),
        onSort: (key) => {
            if (!table) return;
            const next = ui.store.getState();
            applySort(next, key);
            // Third click clears sorting: rebuild so the header loses its arrow too.
            if (!next.sortColumn) {
                ui.refresh?.();
                return;
            }
            table.setRows(pageSlice(next, filterModels(next)).map((name) => toRow(next, name)));
            table.setSort(next.sortColumn, next.sortDir);
            ui.syncPager?.();
        },
    });

    host.textContent = "";
    host.appendChild(table.root);
    attachLazyPreviews(table.root, ui);
    return table;
}
