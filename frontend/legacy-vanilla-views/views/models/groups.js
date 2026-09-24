/**
 * views/models/groups.js — model groups (brief §4 items 5 and 13).
 *
 * A group is `groups[name] = string[]` of model names, isolated per model type. The
 * server replaces the **whole per-type map** on POST, so every save sends the full
 * `state.modelGroups` object (upstream `saveModelGroups`).
 *
 * Reserved groups: `Batch` is auto-created for checkpoint/lora and `Stack` for lora;
 * `Stack` is dropped from the client map for every other type. Removing a member
 * keeps a reserved key even when it becomes empty.
 *
 * The Batch/Stack *toggles* are not reimplemented: they go through `core/batch.js`
 * (`toggleBatch` / `clearBatchGroup` / `toggleStack` / `clearStackGroup`), which the
 * Generate view's batch panel uses too, so both views share one state machine and one
 * persistence path. Group edits made here are published to the app store so the
 * Generate view can react without a cross-view DOM poke.
 */
import {
    BATCH_MODEL_TYPES,
    RESERVED_GROUPS,
    STACK_MODEL_TYPES,
    batch,
    models as coreModels,
} from "../../core/index.js";
import { commit, tr } from "./state.js";

export const BATCH_GROUP = "Batch";
export const STACK_GROUP = "Stack";

/** Sorted group names of the active type. */
export function groupNames(state) {
    return Object.keys(state.modelGroups || {}).sort();
}

/** Every group the model currently belongs to. */
export function groupsOfModel(state, name) {
    return coreModels.groupsOf(state.modelGroups, name);
}

/** Membership in the reserved Batch/Stack groups of the active type. */
export function isInBatch(state, name) {
    return (state.modelGroups?.Batch || []).includes(name);
}

export function isInStack(state, name) {
    return (state.modelGroups?.Stack || []).includes(name);
}

/**
 * Auto-create the reserved keys for a type and drop `Stack` where it does not apply.
 * Pure: returns a new map plus whether a save is needed.
 */
export function ensureReservedKeys(type, groups) {
    const next = { ...(groups || {}) };
    let changed = false;
    if (BATCH_MODEL_TYPES.includes(type) && !next[BATCH_GROUP]) {
        next[BATCH_GROUP] = [];
        changed = true;
    }
    if (STACK_MODEL_TYPES.includes(type) && !next[STACK_GROUP]) {
        next[STACK_GROUP] = [];
        changed = true;
    }
    if (!STACK_MODEL_TYPES.includes(type) && next[STACK_GROUP]) {
        delete next[STACK_GROUP];
        changed = true;
    }
    return { groups: next, changed };
}

/** True for a name that the rename/delete buttons must refuse. */
export function isReservedGroup(name) {
    return RESERVED_GROUPS.includes(name);
}

/* ------------------------------------------------------------ load + persist */

/** Mirror a saved map into `modelGroups` + `allModelGroups` and the core cache. */
function adoptGroups(ui, type, groups) {
    const state = ui.store.getState();
    state.modelGroups = groups;
    state.allModelGroups[type] = groups;
    syncBatchState(ui, type, groups);
}

/** Keep core/batch.js's per-type cache in step with the view's map. */
function syncBatchState(ui, type, groups) {
    if (!ui.batchState) ui.batchState = batch.createBatchState();
    ui.batchState.modelGroups[type] = batch.createGroupSet(groups || {});
}

/** Publish the map so the Generate view (and any other consumer) can react. */
export function publishGroups(ui, type, groups) {
    ui.appStore?.setState?.({
        modelsGroups: { type, groups: { ...groups } },
        modelsGroupsAt: Date.now(),
    });
}

/** `GET groups?type=` for one type, with the reserved keys ensured and re-saved. */
export async function loadGroupsForType(ui, type) {
    let groups = {};
    try {
        const data = await coreModels.loadGroups(type);
        groups = data && typeof data === "object" ? data : {};
    } catch {
        groups = {};
    }
    const ensured = ensureReservedKeys(type, groups);
    adoptGroups(ui, type, ensured.groups);
    if (ensured.changed) await saveGroupsForType(ui, type, ensured.groups);
    return ensured.groups;
}

/** Whole-map POST (never a delta) + local mirror + app-store publish. */
export async function saveGroupsForType(ui, type, groups) {
    try {
        await coreModels.saveGroups(type, groups);
        adoptGroups(ui, type, groups);
        publishGroups(ui, type, groups);
        return true;
    } catch (err) {
        ui.snack(`${tr("saveFailed", "Save failed")}: ${err.message}`, "error");
        return false;
    }
}

/* ------------------------------------------------------------- group editing */

export async function addToGroup(ui, groupName, names) {
    const state = ui.store.getState();
    const groups = coreModels.withMembers(state.modelGroups, groupName, names, true);
    const added = (groups[groupName] || []).length - (state.modelGroups[groupName] || []).length;
    await saveGroupsForType(ui, state.activeModelType, groups);
    if (added > 0) ui.snack(`${added} ${tr("modelBulkAddDone", "model(s) added to the group")}`, "success");
    return added;
}

export async function removeFromGroup(ui, groupName, names) {
    const state = ui.store.getState();
    if (!state.modelGroups[groupName]) return 0;
    const before = state.modelGroups[groupName].length;
    let groups = coreModels.withMembers(state.modelGroups, groupName, names, false);
    // Reserved keys survive an empty array (upstream kept Batch/Stack).
    if ((groups[groupName] || []).length === 0 && !isReservedGroup(groupName)) {
        groups = coreModels.withoutGroup(groups, groupName);
    }
    await saveGroupsForType(ui, state.activeModelType, groups);
    const removed = before - (groups[groupName] || []).length;
    if (removed > 0) ui.snack(`${removed} ${tr("modelBulkRemoveDone", "model(s) removed from the group")}`, "success");
    return removed;
}

/** Create a group (refused when the name is taken) holding `names`. */
export async function createGroup(ui, groupName, names = []) {
    const state = ui.store.getState();
    if (state.modelGroups[groupName]) {
        ui.snack(tr("modelsGroupExists", "A group with this name already exists"), "warning");
        return false;
    }
    const groups = coreModels.withMembers(state.modelGroups, groupName, names, true);
    return saveGroupsForType(ui, state.activeModelType, groups);
}

export async function renameGroup(ui, from, to) {
    if (!to || to === from) return false;
    if (isReservedGroup(from)) {
        ui.snack(tr("modelsGroupReserved", "Reserved group names cannot be changed"), "warning");
        return false;
    }
    const state = ui.store.getState();
    if (state.modelGroups[to]) {
        ui.snack(tr("modelsGroupExists", "A group with this name already exists"), "warning");
        return false;
    }
    const groups = coreModels.renameGroup(state.modelGroups, from, to);
    const saved = await saveGroupsForType(ui, state.activeModelType, groups);
    if (saved && state.groupFilter === from) state.groupFilter = to;
    return saved;
}

export async function deleteGroup(ui, groupName) {
    if (isReservedGroup(groupName)) {
        ui.snack(tr("modelsGroupReserved", "Reserved group names cannot be changed"), "warning");
        return false;
    }
    const state = ui.store.getState();
    const ok = await ui.confirm({
        title: tr("modelsDelete", "Delete"),
        content: tr("modelsDeleteGroupConfirm", "Delete group {name}?").replace("{name}", groupName),
        confirmLabel: tr("modelsDelete", "Delete"),
        danger: true,
    });
    if (!ok) return false;
    const groups = coreModels.withoutGroup(state.modelGroups, groupName);
    if (state.groupFilter === groupName) state.groupFilter = "";
    return saveGroupsForType(ui, state.activeModelType, groups);
}

/* ------------------------------------------------- Batch / Stack (core-owned) */

/** Adopt the members core/batch.js just persisted. */
function adoptReserved(ui, type, groupName, result) {
    const state = ui.store.getState();
    const groups = { ...state.modelGroups, [groupName]: result.members || [] };
    adoptGroups(ui, type, groups);
    publishGroups(ui, type, groups);
    if (result.persisted === false) ui.snack(tr("saveFailed", "Save failed"), "error");
    commit(ui.store);
    return result;
}

function batchStateFor(ui) {
    if (!ui.batchState) ui.batchState = batch.createBatchState();
    return ui.batchState;
}

/** Toggle a model in the reserved Batch group (feature 13, core implementation). */
export async function toggleBatchForModel(ui, name) {
    const state = ui.store.getState();
    const type = state.activeModelType;
    syncBatchState(ui, type, state.modelGroups);
    const result = await batch.toggleBatch(batchStateFor(ui), type, name);
    return adoptReserved(ui, type, BATCH_GROUP, result);
}

export async function toggleStackForModel(ui, name) {
    const state = ui.store.getState();
    const type = state.activeModelType;
    syncBatchState(ui, type, state.modelGroups);
    const result = await batch.toggleStack(batchStateFor(ui), type, name);
    return adoptReserved(ui, type, STACK_GROUP, result);
}

export async function clearBatch(ui) {
    const state = ui.store.getState();
    const type = state.activeModelType;
    syncBatchState(ui, type, state.modelGroups);
    const result = await batch.clearBatchGroup(batchStateFor(ui), type);
    if (state.showBatchOnly) state.showBatchOnly = false;
    adoptReserved(ui, type, BATCH_GROUP, result);
    ui.snack(tr("modelsBatchClear", "Batch selection cleared"), "success");
    return result;
}

export async function clearStack(ui) {
    const state = ui.store.getState();
    const type = state.activeModelType;
    syncBatchState(ui, type, state.modelGroups);
    const result = await batch.clearStackGroup(batchStateFor(ui), type);
    adoptReserved(ui, type, STACK_GROUP, result);
    ui.snack(tr("stackCleared", "Stack selection cleared"), "success");
    return result;
}
