/**
 * core/batch.js — batch selection state machine, group loaders and the batch runner.
 *
 * Port of the DOM-free helpers of generate-tab.js §3 (L365-447, L553-591, L698-716, L953-1047,
 * L1257-1287 wiring contract), §8 `_runCatalogCreate`'s sibling helpers and §9
 * `_runBatchGenerate` (L1873-2057) + `_runBatchLoop` (L1656-1719). Three deliberate changes:
 *
 *  1. No module-level singleton. Upstream kept `_ckptState` / `_batchGroupState` /
 *     `_samplerSelected` / `_schedulerSelected` / `_batchStyleSelected` in module scope; here every
 *     operation takes the caller's state object (see `createBatchState()`), so the Generate view and
 *     the Models view can share one implementation.
 *  2. The two storage-backed group sources are parameters. Upstream read the browser key
 *     `wfm_prompt_preset_groups` (`_loadPromptGroupsForBatch`) and `wfm_groups`
 *     (`_loadWorkflowGroupsForBatch`) directly; core must not touch page storage, so the caller
 *     passes the parsed objects to `setPromptGroups()` / `setWorkflowGroups()`.
 *  3. DOM writes became callbacks: the 6 ids `_runBatchLoop` drove are replaced by `onStatus`,
 *     `#wfm-prompt-pos-text` by `onPromptText`, and `#wfm-gen-workflow-name` by `opts.filename` /
 *     `onWorkflowLoaded` (upstream read a misspelled id there, so the name was always lost - see
 *     spec §20.1; this port takes the real name as a parameter instead).
 *
 * Empty-selection / missing-node bails return `{skipped: {key, args}}` instead of a toast; the view
 * renders `t(key, ...args)` with the upstream i18n keys (`batchNoneSelected`, `modelsGenUINoNode`,
 * `batchLoraMissing`).
 *
 * Requires from ./api.js: getModelGroups(type), saveModelGroups(modelType, groups), listPrompts(),
 * getModelMetadata(), getCivitaiCache(), loadWorkflow(filename)
 */

import * as api from "./api.js";
import { comfyUI } from "./client.js";
import { comfyWorkflow } from "./workflow.js";
import { BATCH_MODEL_TYPES, RESERVED_GROUPS, STACK_MODEL_TYPES } from "./model-constants.js";
import { runGeneration } from "./pipeline.js";
import { fetchStyles, setCachedStyles } from "./style.js";

/** Upstream `_updateBatchTypeLabel`'s label map (spec §21: derived here instead of model-constants). */
export const BATCH_TYPE_LABELS = {
    checkpoint: "Checkpoint",
    lora: "Lora",
    prompt: "Prompt",
    workflow: "Workflow",
    sampler: "Sampler",
    scheduler: "Scheduler",
    style: "Style",
};

/** Upstream `batchNoneSelected` toast arguments, per batch type. */
const BATCH_PLURAL = {
    checkpoint: "checkpoints",
    lora: "LoRAs",
    prompt: "prompts",
    workflow: "workflows",
    sampler: "samplers",
    scheduler: "schedulers",
    style: "styles",
};

/** The two reserved model-group names (`RESERVED_GROUPS` = [Batch, Stack] upstream). */
const BATCH_GROUP = RESERVED_GROUPS[0];
const STACK_GROUP = RESERVED_GROUPS[1];

// ── State ─────────────────────────────────────────────────────────────────────────────────

/**
 * One runtime group-selection model (upstream `_batchGroupState.<x>Groups` +
 * `.<x>SelectedGroups` + `.<x>PartialSelections`).
 * @typedef {{defs:Object<string,string[]>, selected:Set<string>,
 *            partial:Object<string,Set<string>>, loaded:boolean}} GroupSet
 */

/** @returns {GroupSet} */
export function createGroupSet(defs = {}) {
    // `loaded` distinguishes "no groups on the server" from "not fetched yet": only a loaded set
    // may be persisted, otherwise a toggle would replace every group of that type with one name.
    return { defs: { ...defs }, selected: new Set(), partial: {}, loaded: false };
}

/**
 * @typedef {Object} BatchState
 * @property {string|null} activeBatchType  checkpoint|lora|prompt|workflow|sampler|scheduler|style|null
 * @property {{mode:'all'|'some'|'none', selected:Set<string>, all:string[]}} checkpoints
 * @property {{items:string[], selected:Set<string>}} samplers
 * @property {{items:string[], selected:Set<string>}} schedulers
 * @property {{items:string[], selected:Set<string>}} styles
 * @property {Object<string,GroupSet>} modelGroups  server groups per model type (Batch/Stack live here)
 * @property {GroupSet} promptGroups
 * @property {Array} promptPresets
 * @property {GroupSet} workflowGroups
 * @property {{aborted:boolean, paused:boolean, resume:(()=>void)|null}} run
 */

/** @returns {BatchState} */
export function createBatchState(overrides = {}) {
    return {
        activeBatchType: null,
        checkpoints: { mode: "none", selected: new Set(), all: [] },
        samplers: { items: [], selected: new Set() },
        schedulers: { items: [], selected: new Set() },
        styles: { items: [], selected: new Set() },
        modelGroups: {},
        promptGroups: createGroupSet(),
        promptPresets: [],
        workflowGroups: createGroupSet(),
        run: { aborted: false, paused: false, resume: null },
        ...overrides,
    };
}

/** Upstream `_activeBatchType` was set by the batch-type checkboxes / `handleGenerate`. */
export function setActiveBatchType(state, batchType) {
    state.activeBatchType = batchType && BATCH_TYPE_LABELS[batchType] ? batchType : null;
    return state.activeBatchType;
}

/** The GroupSet behind a kind: `checkpoint` / `lora` are model-type groups, plus prompt / workflow. */
export function groupSetOf(state, kind) {
    if (kind === "prompt") return state.promptGroups;
    if (kind === "workflow") return state.workflowGroups;
    if (!state.modelGroups[kind]) state.modelGroups[kind] = createGroupSet();
    return state.modelGroups[kind];
}

/** Drop selections of groups that no longer exist (upstream pruned after every load). */
function pruneGroupSet(groupSet) {
    const names = new Set(Object.keys(groupSet.defs));
    for (const name of groupSet.selected) {
        if (!names.has(name)) groupSet.selected.delete(name);
    }
    for (const name of Object.keys(groupSet.partial)) {
        if (!names.has(name)) delete groupSet.partial[name];
    }
    return groupSet;
}

// ── Group selection kernel (upstream `_getItemsFromGroupState` + the transitions) ──────────

/**
 * All selected members of a group set, in declaration order, de-duplicated.
 * Port of `_getItemsFromGroupState`: a partial selection is intersected with the current member
 * list, so ids deleted server-side can never leak into a run.
 * @returns {Set<string>}
 */
export function selectedItemsFromGroupSet(groupSet) {
    const result = new Set();
    for (const [name, members] of Object.entries(groupSet.defs)) {
        if (groupSet.selected.has(name)) {
            members.forEach((member) => result.add(member));
        } else {
            const partial = groupSet.partial[name];
            if (partial) partial.forEach((member) => { if (members.includes(member)) result.add(member); });
        }
    }
    return result;
}

/** Port of `_getGroupSelCountFrom`. */
export function groupSelectedCount(groupSet, name) {
    const members = groupSet.defs[name] || [];
    if (groupSet.selected.has(name)) return members.length;
    const partial = groupSet.partial[name];
    return partial ? members.filter((member) => partial.has(member)).length : 0;
}

/** Renderer contract of the group header checkbox (`cb.checked` / `cb.indeterminate`). */
export function groupCheckState(groupSet, name, members) {
    const list = members || groupSet.defs[name] || [];
    const count = groupSelectedCount(groupSet, name);
    return {
        checked: list.length > 0 && count === list.length,
        indeterminate: count > 0 && count < list.length,
        count,
        total: list.length,
    };
}

/** Is `member` currently selected in `name` (whole group selected, or listed in the partial set)? */
export function isMemberSelected(groupSet, name, member) {
    return groupSet.selected.has(name) || Boolean(groupSet.partial[name]?.has(member));
}

/**
 * Member checkbox transition, ported verbatim from `_renderBatchGroupList` / `_renderAnyGroupList`:
 * unchecking a member of a fully-selected group demotes it to a partial selection, a partial that
 * reaches full membership is promoted back to `selected`, and an empty partial entry is deleted.
 * `checked === true` adds, `false` removes (i.e. this is also add/remove, not only toggle).
 */
export function toggleGroupMember(groupSet, name, member, checked) {
    const members = groupSet.defs[name] || [];
    if (groupSet.selected.has(name)) {
        // Upstream ignored `checked` here: with the whole group selected every member box is
        // checked, so the only reachable transition is the demotion to a partial selection.
        groupSet.selected.delete(name);
        const partial = new Set(members);
        partial.delete(member);
        if (partial.size > 0) groupSet.partial[name] = partial;
        else delete groupSet.partial[name];
        return groupSet;
    }

    if (!groupSet.partial[name]) groupSet.partial[name] = new Set();
    if (checked) groupSet.partial[name].add(member);
    else groupSet.partial[name].delete(member);

    if (members.length > 0 && members.every((x) => groupSet.partial[name].has(x))) {
        groupSet.selected.add(name);
        delete groupSet.partial[name];
    }
    if (groupSet.partial[name]?.size === 0) delete groupSet.partial[name];
    return groupSet;
}

/** Group header checkbox: all-or-nothing (upstream cleared the partial entry either way). */
export function selectGroup(groupSet, name, checked) {
    if (checked) {
        groupSet.selected.add(name);
        delete groupSet.partial[name];
    } else {
        groupSet.selected.delete(name);
        delete groupSet.partial[name];
    }
    return groupSet;
}

/** Drop the runtime selection of one group (not the persisted definition - see clearBatchGroup). */
export function clearGroup(groupSet, name) {
    return selectGroup(groupSet, name, false);
}

/** Select every member of one group at once. */
export function selectAllInGroup(groupSet, name) {
    return selectGroup(groupSet, name, true);
}

/** The group's selected members as an array, in declaration order (the run queue). */
export function selectedGroupItems(state, kind) {
    return [...selectedItemsFromGroupSet(groupSetOf(state, kind))];
}

/** Iterate the group's selected members. */
export function* iterateGroupItems(state, kind) {
    yield* selectedGroupItems(state, kind);
}

/**
 * Cursor-style "next item" over a snapshot of the group (upstream `_runBatchLoop` walked the array
 * captured before the loop, so selections changed mid-run never altered the queue).
 * @returns {{item:string|null, cursor:number, done:boolean, total:number}}
 */
export function nextGroupItem(state, kind, cursor = 0) {
    const items = selectedGroupItems(state, kind);
    if (cursor < items.length) {
        return { item: items[cursor], cursor: cursor + 1, done: false, total: items.length };
    }
    return { item: null, cursor, done: true, total: items.length };
}

// ── Group loaders ─────────────────────────────────────────────────────────────────────────

/**
 * `GET /api/wfm/models/groups?type=<type>` into `state.modelGroups[type]` (upstream
 * `_loadBatchCheckpointGroups` / `_loadBatchLoraGroups`, including the stale-name pruning).
 * @returns {Promise<GroupSet>}
 */
export async function loadModelGroups(state, type) {
    let defs = {};
    try {
        const groups = await api.getModelGroups(type);
        defs = groups && typeof groups === "object" ? groups : {};
    } catch {
        defs = {};
    }
    const groupSet = groupSetOf(state, type);
    groupSet.defs = defs;
    groupSet.loaded = true;
    return pruneGroupSet(groupSet);
}

/**
 * Load the groups of every Batch-capable model type (upstream loaded checkpoint + lora when the
 * Batch tab was opened).
 * @returns {Promise<Object<string, GroupSet>>}
 */
export async function loadBatchGroups(state, types = BATCH_MODEL_TYPES) {
    const loaded = {};
    for (const type of types) loaded[type] = await loadModelGroups(state, type);
    return loaded;
}

/**
 * Load the groups of every Stack-capable model type and return the members of the reserved
 * "Stack" group per type - that list is what the Stack feature consumes.
 * @returns {Promise<Object<string, string[]>>}
 */
export async function loadStackGroups(state, types = STACK_MODEL_TYPES) {
    const stacks = {};
    for (const type of types) {
        const groupSet = await loadModelGroups(state, type);
        stacks[type] = [...(groupSet.defs[STACK_GROUP] || [])];
    }
    return stacks;
}

/**
 * Reuse the cached groups of `type`, loading them first when they were never fetched
 * (`loaded`, not existence - `groupSetOf` creates an empty set as soon as a view renders).
 */
async function ensureModelGroups(state, type) {
    const groupSet = groupSetOf(state, type);
    if (!groupSet.loaded) await loadModelGroups(state, type);
    return groupSet;
}

/** `GET /api/wfm/prompts` (upstream `_loadPromptGroupsForBatch`'s first half). */
export async function loadPromptPresets(state) {
    try {
        const presets = await api.listPrompts();
        state.promptPresets = Array.isArray(presets) ? presets : [];
    } catch {
        state.promptPresets = [];
    }
    return state.promptPresets;
}

/**
 * Prompt group definitions. Upstream read the `wfm_prompt_preset_groups` browser key, so the
 * caller passes the parsed object; unknown preset ids are dropped like upstream.
 * @returns {GroupSet}
 */
export function setPromptGroups(state, groups = {}) {
    const validIds = new Set((state.promptPresets || []).map((preset) => preset.id));
    const defs = {};
    for (const [name, ids] of Object.entries(groups || {})) {
        defs[name] = (ids || []).filter((id) => validIds.has(id));
    }
    state.promptGroups.defs = defs;
    return pruneGroupSet(state.promptGroups);
}

/** Presets + group definitions in one step (upstream `_loadPromptGroupsForBatch`). */
export async function loadPromptGroups(state, groups = {}) {
    await loadPromptPresets(state);
    return setPromptGroups(state, groups);
}

/**
 * Workflow group definitions. Upstream read the `wfm_groups` browser key (written by the
 * Workflow tab), so the caller passes the parsed object.
 * @returns {GroupSet}
 */
export function setWorkflowGroups(state, groups = {}) {
    state.workflowGroups.defs = { ...(groups || {}) };
    return pruneGroupSet(state.workflowGroups);
}

/** Upstream `_getSelectedPromptGroupItems`: group ids resolved to preset records, orphans dropped. */
export function getSelectedPromptItems(state) {
    const ids = selectedItemsFromGroupSet(state.promptGroups);
    return [...ids]
        .map((id) => (state.promptPresets || []).find((preset) => preset.id === id))
        .filter(Boolean);
}

/** Upstream `_getSelectedWfGroupItems`. */
export function getSelectedWorkflowItems(state) {
    return selectedItemsFromGroupSet(state.workflowGroups);
}

/** Upstream `_getSelectedLoraGroupItems`. */
export function getSelectedLoraItems(state) {
    return selectedItemsFromGroupSet(groupSetOf(state, "lora"));
}

// ── Batch / Stack toggles (upstream models/grid-view.js, shared by Models and Generate) ────

function isMemberOfReserved(state, type, name, modelName) {
    const groupSet = state.modelGroups[type];
    return Boolean(groupSet?.defs?.[name]?.includes(modelName));
}

export function isInBatch(state, type, modelName) {
    return isMemberOfReserved(state, type, BATCH_GROUP, modelName);
}

export function isInStack(state, type, modelName) {
    return isMemberOfReserved(state, type, STACK_GROUP, modelName);
}

async function persistGroups(state, type) {
    try {
        await api.saveModelGroups(type, groupSetOf(state, type).defs);
        return true;
    } catch {
        // The local membership is already updated; the caller decides how to report this.
        return false;
    }
}

async function toggleReservedMember(state, type, groupName, modelName) {
    const groupSet = await ensureModelGroups(state, type);
    if (!groupSet.defs[groupName]) groupSet.defs[groupName] = [];
    const members = groupSet.defs[groupName];
    const index = members.indexOf(modelName);
    if (index >= 0) members.splice(index, 1);
    else members.push(modelName);
    return { members: [...members], added: index < 0, persisted: await persistGroups(state, type) };
}

/**
 * Toggle one model in the reserved "Batch" group of `type` and persist it
 * (upstream `toggleBatch`, without the re-render / toast).
 * @returns {Promise<{members:string[], added:boolean, persisted:boolean}>}
 */
export function toggleBatch(state, type, modelName) {
    return toggleReservedMember(state, type, BATCH_GROUP, modelName);
}

/** Empty the reserved "Batch" group of `type` (upstream `clearBatchGroup`). */
export async function clearBatchGroup(state, type) {
    const groupSet = await ensureModelGroups(state, type);
    groupSet.defs[BATCH_GROUP] = [];
    return { members: [], persisted: await persistGroups(state, type) };
}

/** Toggle one model in the reserved "Stack" group of `type` (upstream `toggleStack`). */
export function toggleStack(state, type, modelName) {
    return toggleReservedMember(state, type, STACK_GROUP, modelName);
}

/** Empty the reserved "Stack" group of `type` (upstream `clearStackGroup`). */
export async function clearStackGroup(state, type) {
    const groupSet = await ensureModelGroups(state, type);
    groupSet.defs[STACK_GROUP] = [];
    return { members: [], persisted: await persistGroups(state, type) };
}

// ── Checkpoint left pane (tri-state + folder tree) ─────────────────────────────────────────

/** Upstream universe: `comfyEditor.models.checkpoints` (a DOM-layer list, now a parameter). */
export function setCheckpointUniverse(state, models) {
    state.checkpoints.all = Array.isArray(models) ? [...models] : [];
    return state.checkpoints.all;
}

/** Group model paths by directory: root folder first, the rest `localeCompare`d. */
export function buildFolderTree(models) {
    const map = new Map();
    for (const model of models) {
        const normalized = model.replace(/\\/g, "/");
        const lastSlash = normalized.lastIndexOf("/");
        const folder = lastSlash === -1 ? "" : normalized.substring(0, lastSlash);
        if (!map.has(folder)) map.set(folder, []);
        map.get(folder).push(model);
    }
    return new Map([...map.entries()].sort((a, b) => {
        if (a[0] === b[0]) return 0;
        if (a[0] === "") return -1;
        if (b[0] === "") return 1;
        return a[0].localeCompare(b[0]);
    }));
}

/** Port of `_getFolderCheckState`: "checked" | "unchecked" | "indeterminate". */
export function folderCheckState(state, folderModels) {
    const { mode, selected } = state.checkpoints;
    if (mode === "all") return "checked";
    if (mode === "none") return "unchecked";
    const selectedCount = folderModels.filter((model) => selected.has(model)).length;
    if (selectedCount === 0) return "unchecked";
    if (selectedCount === folderModels.length) return "checked";
    return "indeterminate";
}

/** Port of `_toggleSingleModel` (tri-state transitions + collapse rules). */
export function toggleCheckpointModel(state, model, checked) {
    const ckpt = state.checkpoints;
    const all = ckpt.all;
    if (ckpt.mode === "all" && !checked) {
        ckpt.mode = "some";
        ckpt.selected.clear();
        all.forEach((x) => ckpt.selected.add(x));
    } else if (ckpt.mode === "none" && checked) {
        ckpt.mode = "some";
        ckpt.selected.clear();
    }
    if (checked) ckpt.selected.add(model);
    else ckpt.selected.delete(model);
    if (ckpt.selected.size === all.length) { ckpt.mode = "all"; ckpt.selected.clear(); }
    if (ckpt.mode === "some" && ckpt.selected.size === 0) ckpt.mode = "none";
    return ckpt;
}

/** Port of `_toggleFolderModels` (same kernel over a folder subset). */
export function toggleCheckpointFolder(state, folderModels, checked) {
    const ckpt = state.checkpoints;
    const all = ckpt.all;
    if (ckpt.mode === "all" && !checked) {
        ckpt.mode = "some";
        ckpt.selected.clear();
        all.forEach((x) => ckpt.selected.add(x));
    } else if (ckpt.mode === "none" && checked) {
        ckpt.mode = "some";
        ckpt.selected.clear();
    }
    folderModels.forEach((model) => {
        if (checked) ckpt.selected.add(model);
        else ckpt.selected.delete(model);
    });
    if (ckpt.selected.size === all.length) { ckpt.mode = "all"; ckpt.selected.clear(); }
    if (ckpt.mode === "some" && ckpt.selected.size === 0) ckpt.mode = "none";
    return ckpt;
}

/** The select-all / deselect-all buttons upstream wrote straight into `_ckptState`. */
export function setAllCheckpoints(state, mode) {
    state.checkpoints.mode = mode === "all" ? "all" : "none";
    state.checkpoints.selected.clear();
    return state.checkpoints;
}

/**
 * Port of `_getSelectedCheckpoints`: the left-pane tri-state merged with the center-pane group
 * selection, de-duplicated in insertion order (left pane first).
 */
export function getSelectedCheckpoints(state) {
    const all = state.checkpoints.all;
    const ckpt = state.checkpoints;
    let leftModels;
    if (ckpt.mode === "all") leftModels = all;
    else if (ckpt.mode === "none") leftModels = [];
    else leftModels = all.filter((model) => ckpt.selected.has(model));

    const seen = new Set(leftModels);
    const result = [...leftModels];
    for (const model of selectedItemsFromGroupSet(groupSetOf(state, "checkpoint"))) {
        if (!seen.has(model)) { seen.add(model); result.push(model); }
    }
    return result;
}

// ── Simple lists (sampler / scheduler / style) ─────────────────────────────────────────────

/** Fill one flat list UI's universe (upstream: `comfyEditor.models.samplers` / `_stylesData`). */
export function setSimpleItems(state, kind, items) {
    const list = state[kind];
    list.items = Array.isArray(items) ? [...items] : [];
    for (const item of [...list.selected]) {
        if (!list.items.includes(item)) list.selected.delete(item);
    }
    return list;
}

/** Port of the `_buildSimpleGroupList` checkbox transitions (single item + header all-or-nothing). */
export function toggleSimpleItem(state, kind, item, checked) {
    if (checked) state[kind].selected.add(item);
    else state[kind].selected.delete(item);
    return state[kind];
}

/** Port of the select-all / deselect-all buttons for sampler / scheduler / style. */
export function setAllSimpleItems(state, kind, checked) {
    const list = state[kind];
    list.selected.clear();
    if (checked) list.items.forEach((item) => list.selected.add(item));
    return list;
}

/** Renderer contract of the flat list's folder checkbox. */
export function simpleListState(state, kind) {
    const list = state[kind];
    const count = list.items.filter((item) => list.selected.has(item)).length;
    return {
        items: list.items,
        count,
        checked: list.items.length > 0 && count === list.items.length,
        indeterminate: count > 0 && count < list.items.length,
    };
}

/** The selected style names, in catalog order (upstream `_stylesData.filter(...)`). */
export function getSelectedStyles(state) {
    return state.styles.items.filter((name) => state.styles.selected.has(name));
}

// ── Queue assembly (upstream `_runBatchGenerate`'s per-case item sources) ──────────────────

/**
 * Items of the active batch type + the label formatter upstream used for each case.
 * @param {BatchState} state
 * @param {{styles?:Array}} [options] style records for the `style` case
 * @returns {{batchType:string|null, items:Array, labelOf:(item:*)=>string}}
 */
export function collectBatchItems(state, { styles = [] } = {}) {
    const batchType = state.activeBatchType;
    switch (batchType) {
        case "checkpoint":
            return { batchType, items: getSelectedCheckpoints(state), labelOf: (m) => String(m) };
        case "lora":
            return { batchType, items: [...getSelectedLoraItems(state)], labelOf: (n) => String(n).replace(/\.[^.]+$/, "") };
        case "prompt":
            return { batchType, items: getSelectedPromptItems(state), labelOf: (preset) => preset.name || preset.id };
        case "workflow":
            return { batchType, items: [...getSelectedWorkflowItems(state)], labelOf: (f) => String(f).replace(/\.json$/, "") };
        case "sampler":
            return { batchType, items: [...state.samplers.selected].sort(), labelOf: (s) => String(s) };
        case "scheduler":
            return { batchType, items: [...state.schedulers.selected].sort(), labelOf: (s) => String(s) };
        case "style":
            return { batchType, items: styles.filter((style) => state.styles.selected.has(style.name)), labelOf: (style) => style.name };
        default:
            return { batchType, items: [], labelOf: (item) => String(item) };
    }
}

/** Which analysis node list each batch type needs (upstream guard + toast argument). */
function batchNodeRequirement(batchType, analysis) {
    switch (batchType) {
        case "checkpoint":
            return (analysis?.checkpoint_nodes || []).length === 0 ? "checkpoint" : null;
        case "lora":
            return (analysis?.lora_nodes || []).length === 0 ? "LoRA" : null;
        case "prompt": {
            const promptNodes = analysis?.prompt_nodes || [];
            const hasAny = promptNodes.some((node) => node.role === "positive" || node.role === "negative");
            return hasAny ? null : "prompt";
        }
        case "sampler":
        case "scheduler":
            return (analysis?.sampler_nodes || []).length === 0 ? "KSampler" : null;
        default:
            return null;
    }
}

// ── Pause / resume / abort (upstream `_ckptBatch` + `_waitIfPaused`) ──────────────────────

/** Resolve a loop parked on the pause gate (upstream `_resumeResolve` call sites). */
function releasePause(state) {
    if (state.run.resume) {
        const resume = state.run.resume;
        state.run.resume = null;
        resume();
    }
}

/** Port of `_waitIfPaused`: resolves immediately unless a pause is pending. */
export function waitIfPaused(state) {
    if (!state.run.paused) return Promise.resolve();
    return new Promise((resolve) => { state.run.resume = resolve; });
}

export function pauseBatch(state) {
    state.run.paused = true;
    return state.run;
}

export function resumeBatch(state) {
    state.run.paused = false;
    releasePause(state);
    return state.run;
}

/**
 * Stop the batch loop (upstream interrupt button: abort + release the pause gate + interrupt the
 * running prompt). The loop observes it before an item, after the pause gate and in its catch.
 * @param {{interrupt?:boolean}} [options]
 */
export function abortBatch(state, { interrupt = true } = {}) {
    state.run.aborted = true;
    state.run.paused = false;
    releasePause(state);
    if (interrupt) comfyUI.interrupt().catch(() => {});
    return state.run;
}

// ── Runner (upstream `_runBatchGenerate` + `_runBatchLoop`) ───────────────────────────────

function batchSummary(batchType, total, extra = {}) {
    return { batchType, total, completed: 0, failed: 0, aborted: false, skipped: null, warnings: [], ...extra };
}

/** Load one workflow file for the `workflow` batch case (core half of `loadWorkflowIntoEditor`). */
async function loadBatchWorkflow(filename) {
    const raw = await api.loadWorkflow(filename);
    const format = comfyWorkflow.detectFormat(raw, filename);
    if (format === "app" || format === "unknown") {
        // Upstream toasted and generated with the PREVIOUS workflow; here the item fails instead.
        throw new Error(`Unsupported workflow format "${format}": ${filename}`);
    }
    const workflow = format === "ui" ? await comfyWorkflow.convertUiToApi(raw) : raw;
    return { filename, workflow, analysis: comfyWorkflow.analyzeWorkflow(workflow) };
}

const loraStem = (loraName) => String(loraName).replace(/\\/g, "/").split("/").pop().replace(/\.[^.]+$/, "");

/**
 * Build the per-item `apply` / `restore` pair for one batch type. `apply` mutates the caller's
 * workflow in place, exactly like upstream's `applyFn`s did (the last item therefore stays applied
 * for checkpoint / prompt / sampler / scheduler, while lora and workflow restore in `restore`).
 */
async function createBatchApplier(batchType, ctx) {
    const { workflow, onPromptText, onWorkflowLoaded, warnings } = ctx;
    const analysis = comfyUI.currentAnalysis;
    const checkpointNodes = analysis?.checkpoint_nodes || [];
    const loraNodes = analysis?.lora_nodes || [];
    const samplerNodes = analysis?.sampler_nodes || [];
    const positiveNodes = (analysis?.prompt_nodes || []).filter((node) => node.role === "positive");
    const negativeNodes = (analysis?.prompt_nodes || []).filter((node) => node.role === "negative");
    const promptKey = (node) => node.textKey || "text";

    switch (batchType) {
        case "checkpoint":
            return {
                getWorkflow: () => workflow,
                apply: (model) => {
                    for (const node of checkpointNodes) {
                        const wfNode = workflow?.[node.id];
                        if (wfNode) wfNode.inputs.ckpt_name = model;
                    }
                },
            };

        case "sampler":
            return {
                getWorkflow: () => workflow,
                apply: (samplerName) => {
                    for (const node of samplerNodes) {
                        const wfNode = workflow?.[node.id];
                        if (wfNode) wfNode.inputs.sampler_name = samplerName;
                    }
                },
            };

        case "scheduler":
            return {
                getWorkflow: () => workflow,
                apply: (schedulerName) => {
                    for (const node of samplerNodes) {
                        const wfNode = workflow?.[node.id];
                        if (wfNode) wfNode.inputs.scheduler = schedulerName;
                    }
                },
            };

        case "prompt":
            return {
                getWorkflow: () => workflow,
                apply: (preset) => {
                    for (const node of positiveNodes) {
                        const wfNode = workflow?.[node.id];
                        if (wfNode) wfNode.inputs[promptKey(node)] = preset.text || "";
                    }
                    for (const node of negativeNodes) {
                        const wfNode = workflow?.[node.id];
                        if (wfNode) wfNode.inputs[promptKey(node)] = preset.negText || "";
                    }
                },
            };

        case "lora": {
            // Non-LoraManager nodes validate against ComfyUI's own enum list, which uses "/" even
            // on Windows, so the selected names are mapped before the run (upstream pre-flight).
            const selectedNames = [...getSelectedLoraItems(ctx.state)];
            let loraNameMap = null;
            if (loraNodes.some((node) => !node.is_lora_manager)) {
                try {
                    const known = await comfyUI.fetchLoras();
                    loraNameMap = new Map(known.map((name) => [name.replace(/\\/g, "/"), name]));
                    const missing = selectedNames.filter((name) => !loraNameMap.has(String(name).replace(/\\/g, "/")));
                    if (missing.length > 0) {
                        warnings.push({
                            key: "batchLoraMissing",
                            args: [missing.length, selectedNames.length, missing[0]],
                        });
                    }
                } catch { loraNameMap = null; }
            }

            let metadata = {};
            let civitaiCache = {};
            try {
                const [meta, cache] = await Promise.all([api.getModelMetadata(), api.getCivitaiCache()]);
                metadata = meta && typeof meta === "object" ? meta : {};
                civitaiCache = cache && typeof cache === "object" ? cache : {};
            } catch { /* trigger words are optional */ }

            // Prompt texts as they were before the run, restored in `restore` (upstream `finally`).
            const savedNodeTexts = new Map();
            for (const node of positiveNodes) {
                const wfNode = workflow?.[node.id];
                if (wfNode) savedNodeTexts.set(node.id, wfNode.inputs[promptKey(node)]);
            }

            return {
                getWorkflow: () => workflow,
                apply: (loraName) => {
                    for (const node of loraNodes) {
                        const wfNode = workflow?.[node.id];
                        if (!wfNode) continue;
                        if (node.is_lora_manager) {
                            const stem = loraStem(loraName);
                            wfNode.inputs.loras = {
                                __value__: [{ name: stem, strength: 1.0, active: true, expanded: false, clipStrength: 1.0, locked: false }],
                            };
                            wfNode.inputs.text = `<lora:${stem}:1:1>`;
                        } else {
                            wfNode.inputs.lora_name = loraNameMap?.get(String(loraName).replace(/\\/g, "/")) || loraName;
                        }
                    }

                    if (positiveNodes.length === 0) return;
                    const stem = loraStem(loraName);
                    const firstStandardNode = loraNodes.find((node) => !node.is_lora_manager);
                    const strModel = firstStandardNode
                        ? (workflow?.[firstStandardNode.id]?.inputs.strength_model ?? 1.0) : 1.0;
                    const strClip = firstStandardNode
                        ? (workflow?.[firstStandardNode.id]?.inputs.strength_clip ?? 1.0) : 1.0;
                    const loraSyntax = `<lora:${stem}:${strModel}:${strClip}>`;
                    const sha = (metadata[loraName] || {}).sha256;
                    const civInfo = sha ? civitaiCache[sha] : null;
                    const triggerWords = civInfo?.trainedWords || [];
                    const append = triggerWords.length > 0 ? `${loraSyntax}, ${triggerWords.join(", ")}` : loraSyntax;

                    for (const node of positiveNodes) {
                        const wfNode = workflow?.[node.id];
                        if (!wfNode) continue;
                        const base = (savedNodeTexts.get(node.id) || "").replace(/,\s*$/, "").trim();
                        wfNode.inputs[promptKey(node)] = base ? `${base}, ${append}` : append;
                    }
                    onPromptText?.(append);
                },
                restore: () => {
                    for (const node of positiveNodes) {
                        const wfNode = workflow?.[node.id];
                        if (wfNode && savedNodeTexts.has(node.id)) {
                            wfNode.inputs[promptKey(node)] = savedNodeTexts.get(node.id);
                        }
                    }
                },
            };
        }

        case "workflow": {
            // The loop swaps the client's working workflow per item (upstream loadWorkflowIntoEditor
            // did the same through comfyUI.currentWorkflow) and puts it back afterwards.
            const savedWorkflow = comfyUI.currentWorkflow;
            const savedAnalysis = comfyUI.currentAnalysis;
            const savedFilename = ctx.filename || "";
            return {
                getWorkflow: () => comfyUI.currentWorkflow,
                apply: async (filename) => {
                    const loaded = await loadBatchWorkflow(filename);
                    comfyUI.currentWorkflow = loaded.workflow;
                    comfyUI.currentAnalysis = loaded.analysis;
                    onWorkflowLoaded?.(loaded);
                },
                restore: () => {
                    comfyUI.currentWorkflow = savedWorkflow;
                    comfyUI.currentAnalysis = savedAnalysis;
                    onWorkflowLoaded?.({
                        filename: savedFilename,
                        workflow: savedWorkflow,
                        analysis: savedAnalysis,
                    });
                },
            };
        }

        default:
            return { getWorkflow: () => workflow, apply: () => {} };
    }
}

/**
 * Iterate the queue (upstream `_runBatchLoop`): items in order, pause gate between items, per-item
 * catch that never breaks the loop, abort checked before the item / after the gate / in the catch.
 */
async function runBatchLoop(options) {
    const {
        state, batchType, items, labelOf, applier, generate, runOptions, signal,
        onStatus, onItemResult, onItemError, warnings,
    } = options;

    // `handleGenerate` reset the batch controller before every run.
    state.run.aborted = false;
    state.run.paused = false;
    state.run.resume = null;

    const isAborted = () => state.run.aborted || Boolean(signal?.aborted);
    const status = (event) => onStatus?.({ batchType, total: items.length, ...event });

    status({ phase: "running", index: 0, label: "" });
    let completed = 0;
    let failed = 0;

    try {
        for (let i = 0; i < items.length; i++) {
            if (isAborted()) break;

            if (state.run.paused) status({ phase: "paused", index: i, label: "" });
            await waitIfPaused(state);
            if (isAborted()) break;

            const item = items[i];
            const label = labelOf(item);
            status({ phase: "item", index: i + 1, label, pct: i / items.length });

            try {
                await applier.apply(item, i);
                const result = await generate({
                    workflow: applier.getWorkflow(),
                    ...runOptions,
                    signal,
                    onProgress: (pct, msg) => status({ phase: "progress", index: i + 1, label, pct, msg }),
                });
                if (onItemResult) await onItemResult(item, result);
                completed++;
            } catch (err) {
                if (isAborted()) break;
                failed++;
                onItemError?.(item, err, i + 1, items.length);
            }
        }
    } finally {
        if (applier.restore) await applier.restore();
        state.run.paused = false;
        releasePause(state);
    }

    const stopped = isAborted();
    status({ phase: stopped ? "stopped" : "done", index: items.length, completed, failed, aborted: stopped });
    return batchSummary(batchType, items.length, { completed, failed, aborted: stopped, warnings });
}

/**
 * Run the active batch type over the current selection, calling `runGeneration` once per item.
 *
 * @param {BatchState} state
 * @param {{
 *   workflow?:object,                      // caller's API-format workflow, mutated per item
 *   filename?:string,                      // current workflow name (restored after a workflow run)
 *   generate?:typeof runGeneration,        // injectable for tests
 *   styles?:Array,                         // style records for the `style` case (else loaded here)
 *   storyLoras?:Array, autoInjectLoras?:boolean, seedMode?:string, seedValue?:number,
 *   onStatus?:(evt:{phase:string, batchType:string, index:number, total:number,
 *                   label:string, pct?:number, msg?:string,
 *                   completed?:number, failed?:number, aborted?:boolean}) => void,
 *   onItemResult?:(item:*, result:object) => void|Promise<void>,
 *   onItemError?:(item:*, err:Error, index:number, total:number) => void,
 *   onPromptText?:(appended:string) => void,          // upstream wrote #wfm-prompt-pos-text
 *   onWorkflowLoaded?:(info:{filename:string, workflow:object, analysis:object}) => void,
 *   signal?:AbortSignal,
 * }} [opts]
 * @returns {Promise<{batchType:string|null, total:number, completed:number, failed:number,
 *                    aborted:boolean, skipped:null|{key:string,args:Array},
 *                    warnings:Array<{key:string,args:Array}>}>}
 */
export async function runBatchGenerate(state, opts = {}) {
    const {
        workflow = null,
        filename = "",
        generate = runGeneration,
        styles = null,
        storyLoras = null,
        autoInjectLoras,
        seedMode,
        seedValue,
        onStatus = null,
        onItemResult = null,
        onItemError = null,
        onPromptText = null,
        onWorkflowLoaded = null,
        signal = null,
    } = opts;

    const batchType = state.activeBatchType;
    const warnings = [];
    const baseWorkflow = workflow || comfyUI.currentWorkflow;

    const missingNode = batchNodeRequirement(batchType, comfyUI.currentAnalysis);
    if (missingNode) {
        return batchSummary(batchType, 0, { skipped: { key: "modelsGenUINoNode", args: [missingNode] } });
    }
    if (!baseWorkflow && batchType !== "workflow") {
        throw new Error("runBatchGenerate: no workflow loaded");
    }

    // The style universe came from the loaded catalog upstream (`_stylesData`). A caller that
    // already holds the catalog passes it in - it then also primes the pipeline's cache so the
    // per-item `styleName` lookup is a hit; otherwise the catalog is (re)loaded here.
    const styleCatalog = batchType === "style" ? (styles || await fetchStyles()) : [];
    if (batchType === "style" && styles) setCachedStyles(styles);
    const { items, labelOf } = collectBatchItems(state, { styles: styleCatalog });
    if (items.length === 0) {
        return batchSummary(batchType, 0, {
            skipped: { key: "batchNoneSelected", args: [BATCH_PLURAL[batchType] || String(batchType)] },
        });
    }

    const applier = await createBatchApplier(batchType, {
        state, workflow: baseWorkflow, filename, onPromptText, onWorkflowLoaded, warnings,
    });

    return runBatchLoop({
        state,
        batchType,
        items,
        labelOf,
        applier,
        generate,
        runOptions: { storyLoras, autoInjectLoras, seedMode, seedValue },
        signal,
        onStatus,
        onItemResult,
        onItemError,
        warnings,
    });
}
