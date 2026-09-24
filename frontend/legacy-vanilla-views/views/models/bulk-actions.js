/**
 * views/models/bulk-actions.js — multi-select and every bulk operation
 * (brief §4 items 11, 12-bulk, 18).
 *
 * Selection is a `Set` of model names on the view state; "select all" takes the
 * **filtered** list (not just the visible page), which is what upstream did and what
 * pagination must not silently change.
 *
 * Per-model writes (favourite, badge) are sequential POSTs, exactly like upstream,
 * so a large selection degrades gracefully instead of hammering the server.
 * Destructive operations go through the dialog host (`ui.confirm`).
 */
import { api } from "../../core/index.js";
import { createButton } from "../../components/Button.js";
import { createSelect } from "../../components/Select.js";
import { createTextField } from "../../components/TextField.js";
import { filterModels } from "./filters.js";
import { applyBadge } from "./badges.js";
import { addToGroup, removeFromGroup } from "./groups.js";
import { commit, saveEntries, tr } from "./state.js";

/* -------------------------------------------------------------- selection */

export function toggleSelectMode(ui) {
    const state = ui.store.getState();
    // Entering select mode on a stale selection is never useful.
    if (state.selectMode) state.selectedModels.clear();
    state.selectMode = !state.selectMode;
    commit(ui.store);
}

export function toggleSelection(ui, name) {
    const state = ui.store.getState();
    if (state.selectedModels.has(name)) state.selectedModels.delete(name);
    else state.selectedModels.add(name);
    commit(ui.store);
}

export function selectAll(ui) {
    const state = ui.store.getState();
    for (const name of filterModels(state)) state.selectedModels.add(name);
    commit(ui.store);
}

export function clearSelection(ui) {
    ui.store.getState().selectedModels.clear();
    commit(ui.store);
}

export function selectionCount(state) {
    return state.selectedModels.size;
}

/* ------------------------------------------------------------ subdirectories */

/** `GET subdirs?type=` — the move destinations (feature 18). */
export async function loadSubdirs(ui) {
    const state = ui.store.getState();
    try {
        const dirs = await api.getSubdirs(state.activeModelType);
        state.subdirs = Array.isArray(dirs) ? dirs : [];
    } catch {
        state.subdirs = [];
    }
    return state.subdirs;
}

/* ------------------------------------------------------------- bulk writes */

/** Bulk favourite (feature 12); only models whose value actually changes are written. */
export async function bulkFavorite(ui, value) {
    const names = [...ui.store.getState().selectedModels];
    const count = await saveEntries(ui, names, (entry) => (entry.favorite === value ? null : { favorite: value }));
    if (count > 0) {
        const key = value ? "modelBulkFavDone" : "modelBulkUnfavDone";
        ui.snack(`${count} ${tr(key, value ? "favourite(s) set" : "favourite(s) removed")}`, "success");
        commit(ui.store);
    }
    return count;
}

export async function bulkBadge(ui, label, add) {
    return applyBadge(ui, label, add);
}

export async function bulkDelete(ui) {
    const state = ui.store.getState();
    const names = [...state.selectedModels];
    if (names.length === 0) return 0;
    const ok = await ui.confirm({
        title: tr("modelBulkDelete", "Delete models"),
        content: tr("modelBulkDeleteConfirm", "Delete {count} model file(s)?").replace("{count}", String(names.length)),
        confirmLabel: tr("modelBulkDelete", "Delete"),
        danger: true,
    });
    if (!ok) return 0;

    try {
        const data = await api.deleteModels(state.activeModelType, names);
        const okCount = (data?.ok || []).length;
        const errCount = (data?.errors || []).length;
        if (errCount > 0) ui.snack(`${tr("modelBulkDeleteError", "Delete failed")}: ${errCount}`, "error");
        if (okCount > 0) {
            const list = state.modelsByType[state.activeModelType] || [];
            const disabled = state.disabledModels[state.activeModelType];
            for (const name of names) {
                const index = list.indexOf(name);
                if (index !== -1) list.splice(index, 1);
                delete state.modelMetadata[name];
                disabled?.delete(name);
                state.selectedModels.delete(name);
                if (state.selectedModel === name) state.selectedModel = null;
            }
            state.loaded[state.activeModelType] = false;
            ui.snack(`${okCount} ${tr("modelBulkDeleteDone", "model file(s) deleted")}`, "success");
        }
        commit(ui.store);
        return okCount;
    } catch (err) {
        ui.snack(`${tr("modelBulkDeleteError", "Delete failed")}: ${err.message}`, "error");
        return 0;
    }
}

/** Bulk move to a root-level subdir; `dest` must be "" or a single folder name. */
export async function bulkMove(ui, dest) {
    const state = ui.store.getState();
    const names = [...state.selectedModels];
    if (names.length === 0) return 0;
    try {
        const data = await api.moveModels(state.activeModelType, names, dest || "");
        const okCount = (data?.moved || []).length;
        const errCount = (data?.errors || []).length;
        if (okCount > 0) {
            const list = state.modelsByType[state.activeModelType] || [];
            const disabled = state.disabledModels[state.activeModelType];
            for (const { from, to } of data.moved) {
                const index = list.indexOf(from);
                if (index !== -1) list[index] = to;
                if (state.modelMetadata[from]) {
                    state.modelMetadata[to] = state.modelMetadata[from];
                    delete state.modelMetadata[from];
                }
                if (disabled?.has(from)) {
                    disabled.delete(from);
                    disabled.add(to);
                }
                state.selectedModels.delete(from);
                for (const members of Object.values(state.modelGroups)) {
                    const at = members.indexOf(from);
                    if (at !== -1) members[at] = to;
                }
                if (state.selectedModel === from) state.selectedModel = null;
            }
            ui.snack(`${okCount} ${tr("modelBulkMoveDone", "model(s) moved")}`, "success");
            await loadSubdirs(ui);
        }
        if (errCount > 0) {
            ui.snack(`${tr("modelBulkMoveError", "Move failed")}: ${data.errors[0].error}`, "error");
        }
        commit(ui.store);
        return okCount;
    } catch (err) {
        ui.snack(`${tr("modelBulkMoveError", "Move failed")}: ${err.message}`, "error");
        return 0;
    }
}

/* ---------------------------------------------------------------- bulk bar */

function groupSelect(ui) {
    const state = ui.store.getState();
    const names = Object.keys(state.modelGroups).sort();
    return createSelect({
        label: tr("modelsAllGroups", "Group"),
        value: names[0] || "",
        options: names.length
            ? names.map((name) => ({ value: name, label: name }))
            : [{ value: "", label: tr("modelsNoGroupAvailable", "No group available") }],
        disabled: names.length === 0,
    });
}

function badgeSelect(ui) {
    const labels = Object.keys(ui.store.getState().badgePalette || {}).sort();
    return createSelect({
        label: tr("modelsBadges", "Badges"),
        value: labels[0] || "",
        options: labels.length
            ? labels.map((label) => ({ value: label, label }))
            : [{ value: "", label: tr("modelBulkNoBadge", "No badge available") }],
        disabled: labels.length === 0,
    });
}

function moveSelect(ui) {
    const state = ui.store.getState();
    return createSelect({
        label: tr("modelsSubdir", "Subdir"),
        value: "",
        options: [
            { value: "", label: tr("modelBulkMoveRoot", "Root") },
            ...state.subdirs.map((dir) => ({ value: dir, label: dir })),
        ],
    });
}

/**
 * The bulk action bar. Rebuilt on every refresh (like upstream) so option lists and
 * the count always reflect the current state; hidden unless a selection exists.
 */
export function createBulkBar(ui) {
    const root = document.createElement("div");
    root.className = "nu-models-bulk";

    function refresh() {
        const state = ui.store.getState();
        root.textContent = "";
        if (!state.selectMode || state.selectedModels.size === 0) {
            root.hidden = true;
            return;
        }
        root.hidden = false;

        const count = document.createElement("span");
        count.className = "nu-models-bulk__count";
        count.textContent = `${state.selectedModels.size} ${tr("modelSelected", "selected")}`;
        root.appendChild(count);

        const header = document.createElement("div");
        header.className = "nu-row";
        header.append(
            createButton({ label: tr("modelBulkSelectAll", "Select all"), variant: "text", onClick: () => selectAll(ui) }),
            createButton({ label: tr("modelBulkDeselectAll", "Deselect all"), variant: "text", onClick: () => clearSelection(ui) }),
            createButton({ label: tr("modelBulkFavAdd", "☆ Add"), variant: "text", onClick: () => bulkFavorite(ui, true) }),
            createButton({ label: tr("modelBulkFavRemove", "★ Remove"), variant: "text", onClick: () => bulkFavorite(ui, false) }),
        );
        root.appendChild(header);

        const groupRow = document.createElement("div");
        groupRow.className = "nu-row";
        const group = groupSelect(ui);
        const groupName = createTextField({ label: tr("modelsGroupName", "Group name"), value: "" });
        groupRow.append(
            group.root,
            createButton({
                label: tr("modelBulkAddGroup", "Add"),
                variant: "tonal",
                disabled: Object.keys(state.modelGroups).length === 0,
                onClick: () => withSelection(async () => addToGroup(ui, group.getValue(), [...ui.store.getState().selectedModels])),
            }),
            createButton({
                label: tr("modelBulkRemoveGroup", "Remove"),
                variant: "text",
                disabled: Object.keys(state.modelGroups).length === 0,
                onClick: () => withSelection(async () => removeFromGroup(ui, group.getValue(), [...ui.store.getState().selectedModels])),
            }),
            groupName.root,
            createButton({
                label: tr("modelBulkCreateAdd", "Create + add"),
                variant: "text",
                onClick: () => withSelection(async () => {
                    const name = groupName.getValue().trim();
                    if (!name) return;
                    const state2 = ui.store.getState();
                    if (state2.modelGroups[name]) {
                        ui.snack(tr("modelsGroupExists", "A group with this name already exists"), "warning");
                        return;
                    }
                    await addToGroup(ui, name, [...state2.selectedModels]);
                }),
            }),
        );
        root.appendChild(groupRow);

        const badgeRow = document.createElement("div");
        badgeRow.className = "nu-row";
        const badge = badgeSelect(ui);
        badgeRow.append(
            badge.root,
            createButton({
                label: tr("modelBulkBadgeApply", "Add badge"),
                variant: "tonal",
                disabled: Object.keys(state.badgePalette || {}).length === 0,
                onClick: () => withSelection(() => bulkBadge(ui, badge.getValue(), true)),
            }),
            createButton({
                label: tr("modelBulkBadgeRemove", "Remove badge"),
                variant: "text",
                disabled: Object.keys(state.badgePalette || {}).length === 0,
                onClick: () => withSelection(() => bulkBadge(ui, badge.getValue(), false)),
            }),
        );
        root.appendChild(badgeRow);

        const fileRow = document.createElement("div");
        fileRow.className = "nu-row";
        const dest = moveSelect(ui);
        const newDir = createTextField({ label: tr("modelBulkMoveNewFolder", "New folder"), value: "" });
        fileRow.append(
            dest.root,
            createButton({
                label: tr("modelBulkMoveBtn", "Move"),
                variant: "tonal",
                onClick: () => withSelection(() => bulkMove(ui, dest.getValue())),
            }),
            newDir.root,
            createButton({
                label: tr("modelBulkMoveCreateMove", "Create + move"),
                variant: "text",
                onClick: () => withSelection(() => {
                    const name = newDir.getValue().trim();
                    if (!name) return;
                    return bulkMove(ui, name);
                }),
            }),
            createButton({
                label: tr("modelBulkDelete", "Delete"),
                variant: "filled",
                onClick: () => withSelection(() => bulkDelete(ui)),
            }),
        );
        root.appendChild(fileRow);
    }

    /** Every bulk handler commits once afterwards so the grid + bar stay in step. */
    async function withSelection(action) {
        await action();
        commit(ui.store);
    }

    refresh();
    return { root, refresh };
}

/** True when the given model is currently selected. */
export function isSelected(state, name) {
    return state.selectedModels.has(name);
}
