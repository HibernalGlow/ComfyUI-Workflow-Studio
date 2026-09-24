/**
 * views/models/index.js — the models view (frozen view contract).
 *
 *     render(container, ctx) -> { destroy(), refresh() }
 *
 * Wires the submodules of brief §3.1:
 *   state.js      state factory + prefs + metadata / enable-disable writes
 *   filters.js    the 8-predicate filter funnel          sort.js    the 9 columns
 *   tags.js       tag aggregation + edit format          badges.js  palette / chips
 *   groups.js     groups + Batch/Stack (via core/batch)  preview.js lazy thumbnails
 *   grid-view.js  thumbnails                             table-view.js  DataTable
 *   detail-panel.js  side panel + dialog + apply-to-Generate
 *   civitai.js    single fetch / cache / SSE batch       bulk-actions.js  multi-select
 *
 * Data flow: the view owns a local store (never a module singleton). Every mutation
 * commits a `rev`, the single subscription re-renders, and focus is restored through
 * `data-focus-key` so keyboard users are not thrown back to the body.
 */
import {
    FETCH_MAP,
    MODEL_TYPES,
    api,
    comfyUI,
    models as coreModels,
    typeLabel,
} from "../../core/index.js";
import { createButton } from "../../components/Button.js";
import { createChip } from "../../components/Chip.js";
import { createIconButton } from "../../components/IconButton.js";
import { createSegmentedButtons } from "../../components/SegmentedButtons.js";
import { createSelect } from "../../components/Select.js";
import { createTextField } from "../../components/TextField.js";
import { confirm as hostConfirm, openDialog as hostOpen, prompt as hostPrompt } from "../../dialog.js";
import { showSnackbar } from "../../snackbar.js";
import { createBadgeFilterBar, openPaletteDialog, paletteLabels } from "./badges.js";
import { createBulkBar, loadSubdirs, toggleSelectMode } from "./bulk-actions.js";
import { createCivitaiBatch } from "./civitai.js";
import { createDetailPanel, openDetailDialog } from "./detail-panel.js";
import {
    applyFilter,
    clearAllFilters,
    dirOptions,
    filterModels,
    getCurrentModels,
    groupFilterValue,
    groupOptions,
    parseGroupOption,
    statusOptions,
    tagOptions,
    viewModeOptions,
} from "./filters.js";
import { renderGrid } from "./grid-view.js";
import { clearBatch, clearStack, ensureReservedKeys, loadGroupsForType } from "./groups.js";
import {
    PAGE_SIZES,
    clampPage,
    commit,
    createModelsState,
    createModelsStore,
    pageCount,
    pageSlice,
    saveViewMode,
    setPageSize,
    switchType,
    tr,
} from "./state.js";
import { renderTable } from "./table-view.js";
import { previewUrl, reloadPreview } from "./preview.js";

/** Main entry point. */
export function render(container, ctx = {}) {
    const store = createModelsStore(createModelsState());
    const state0 = store.getState();
    state0.civitaiHost = state0.civitaiHost; // read by civitai.js through the state
    const snack = (label, variant) => {
        const host = ctx.snackbar?.showSnackbar || showSnackbar;
        try {
            host({ label });
        } catch {
            /* snackbars are best-effort */
        }
    };

    /* ------------------------------------------------------------- skeleton */

    const root = document.createElement("section");
    root.className = "nu-view nu-models";

    const header = document.createElement("div");
    header.className = "nu-view__header";
    const title = document.createElement("h2");
    title.className = "nu-view__title";
    title.textContent = tr("tabModels", "Models");
    const count = document.createElement("span");
    count.className = "nu-muted nu-models__count";
    count.setAttribute("aria-live", "polite");
    header.append(title, count);

    const toolbar = document.createElement("div");
    toolbar.className = "nu-view__toolbar nu-models__toolbar";

    const typeSelector = createSegmentedButtons({
        segments: MODEL_TYPES.map((type) => ({ value: type, label: typeLabel(type) })),
        value: state0.activeModelType,
        ariaLabel: tr("modelsTypes", "Model type"),
        onChange: (type) => {
            switchType(store, type);
            commit(store);
            loadType(type);
        },
    });
    toolbar.appendChild(typeSelector.root);

    const search = createTextField({
        label: tr("search", "Search"),
        value: "",
        onInput: (event) => {
            applyFilter(store, { searchText: event.target.value });
            commit(store);
        },
    });
    const tagSelect = createSelect({
        label: tr("modelsAllTags", "Tags"),
        options: [],
        value: "",
        onChange: (value) => {
            applyFilter(store, { tagFilter: value });
            commit(store);
        },
    });
    const dirSelect = createSelect({
        label: tr("modelsAllDirs", "Subdir"),
        options: [],
        value: "",
        onChange: (value) => {
            applyFilter(store, { dirFilter: value });
            commit(store);
        },
    });
    const groupSelect = createSelect({
        label: tr("modelsAllGroups", "Groups"),
        options: [],
        value: "",
        onChange: async (value) => {
            const parsed = parseGroupOption(value);
            if (!parsed.group) {
                applyFilter(store, { groupFilter: "" });
                commit(store);
                return;
            }
            if (parsed.type && parsed.type !== store.getState().activeModelType) {
                switchType(store, parsed.type);
                commit(store);
                await loadType(parsed.type);
            }
            applyFilter(store, { groupFilter: parsed.group });
            commit(store);
        },
    });
    const statusSelect = createSelect({
        label: tr("modelsStatus", "Status"),
        options: statusOptions(),
        value: "all",
        onChange: (value) => {
            applyFilter(store, { statusFilter: value });
            commit(store);
        },
    });
    const filterRow = document.createElement("div");
    filterRow.className = "nu-row nu-models__filters";
    filterRow.append(search.root, tagSelect.root, dirSelect.root, groupSelect.root, statusSelect.root);

    const badgeChips = createBadgeFilterBar(ui0());
    const favChip = createChip({
        label: tr("modelsFavorite", "Favorites only"),
        variant: "filter",
        selected: false,
        onToggle: () => {
            const state = store.getState();
            applyFilter(store, { showFavoritesOnly: !state.showFavoritesOnly });
            commit(store);
        },
    });
    const batchChip = createChip({
        label: tr("modelsBatch", "Batch only"),
        variant: "filter",
        selected: false,
        onToggle: () => {
            const state = store.getState();
            applyFilter(store, { showBatchOnly: !state.showBatchOnly });
            commit(store);
        },
    });
    const chipRow = document.createElement("div");
    chipRow.className = "nu-row nu-models__chips";
    chipRow.append(badgeChips.root, favChip.root, batchChip.root);

    const viewSelector = createSegmentedButtons({
        segments: viewModeOptions(),
        value: state0.viewMode,
        ariaLabel: tr("modelsView", "View"),
        onChange: (mode) => {
            store.getState().viewMode = mode;
            saveViewMode(mode);
            commit(store);
        },
    });
    const selectBtn = createButton({
        label: tr("modelSelectMode", "Select"),
        variant: "outlined",
        onClick: () => toggleSelectMode(ui0()),
    });
    selectBtn.setAttribute("aria-pressed", "false");
    const badgeManageBtn = createButton({
        label: tr("badgeManage", "Badges"),
        variant: "text",
        onClick: () => openPaletteDialog(ui0()),
    });
    const civitaiBatch = createCivitaiBatch(ui0());
    const civitaiBtn = createButton({
        label: "CivitAI",
        variant: "text",
        onClick: () => civitaiBatch.start(),
    });
    const clearBatchBtn = createButton({
        label: tr("modelsBatchClear", "Clear batch"),
        variant: "text",
        onClick: () => clearBatch(ui0()),
    });
    const clearStackBtn = createButton({
        label: tr("stackCleared", "Clear stack"),
        variant: "text",
        onClick: () => clearStack(ui0()),
    });
    const clearFiltersBtn = createButton({
        label: tr("clearFilters", "Clear filters"),
        variant: "text",
        onClick: () => {
            clearAllFilters(store.getState());
            commit(store);
        },
    });
    const refreshBtn = createIconButton({
        icon: "⟳",
        ariaLabel: tr("refresh", "Refresh"),
        onClick: () => {
            const state = store.getState();
            state.loaded[state.activeModelType] = false;
            state.modelsByType[state.activeModelType] = [];
            loadType(state.activeModelType);
        },
    });
    const actionRow = document.createElement("div");
    actionRow.className = "nu-row nu-models__actions";
    actionRow.append(viewSelector.root, selectBtn, badgeManageBtn, civitaiBtn, clearBatchBtn, clearStackBtn, clearFiltersBtn, refreshBtn);

    const status = document.createElement("p");
    status.className = "nu-muted nu-models__status";
    status.setAttribute("role", "status");

    toolbar.append(filterRow, chipRow, actionRow, civitaiBatch.root, status);

    const bulkBar = createBulkBar(ui0());
    const body = document.createElement("div");
    body.className = "nu-view__body nu-models__body";
    const main = document.createElement("div");
    main.className = "nu-models__main";
    const gridHost = document.createElement("div");
    gridHost.className = "nu-models__grid";
    const pager = createPager();
    main.append(gridHost, pager.root);
    const detail = createDetailPanel(ui0());
    body.append(main, detail.root);

    root.append(header, toolbar, bulkBar.root, body);
    container.textContent = "";
    container.appendChild(root);

    /* ------------------------------------------------------------ pager */

    function createPager() {
        const node = document.createElement("div");
        node.className = "nu-row nu-models__pager";
        const prev = createIconButton({
            icon: "‹",
            ariaLabel: tr("modelsPagePrev", "Previous page"),
            onClick: () => {
                const state = store.getState();
                state.currentPage = Math.max(0, state.currentPage - 1);
                commit(store);
            },
        });
        const next = createIconButton({
            icon: "›",
            ariaLabel: tr("modelsPageNext", "Next page"),
            onClick: () => {
                const state = store.getState();
                state.currentPage += 1;
                commit(store);
            },
        });
        prev.dataset.focusKey = "pager:prev";
        next.dataset.focusKey = "pager:next";
        const label = document.createElement("span");
        label.className = "nu-muted";
        label.setAttribute("aria-live", "polite");
        const size = createSelect({
            label: tr("modelsPageSize", "Per page"),
            options: PAGE_SIZES.map((n) => ({ value: String(n), label: String(n) })),
            value: String(store.getState().pageSize),
            onChange: (value) => {
                setPageSize(store, Number(value));
            },
        });
        node.append(prev, label, next, size.root);
        return {
            root: node,
            update(state, total) {
                const pages = pageCount(state, total);
                label.textContent = `${state.currentPage + 1} / ${pages} (${total})`;
                prev.disabled = state.currentPage <= 0;
                next.disabled = state.currentPage >= pages - 1;
            },
        };
    }

    /* --------------------------------------------------------------- ui */

    function ui0() {
        return ui;
    }

    const ui = {
        store,
        appStore: ctx.store,
        snack,
        confirm: (options) => (ctx.dialog?.confirm || hostConfirm)(options),
        prompt: (options) => (ctx.dialog?.prompt || hostPrompt)(options),
        openDialog: (options) => (ctx.dialog?.openDialog || hostOpen)(options),
        refresh: () => commit(store),
        refreshDetail: () => detail.refresh(),
        showDetail: (name) => {
            store.getState().selectedModel = name;
            detail.show(name);
            commit(store);
        },
        closeDetail: () => {
            store.getState().selectedModel = null;
            detail.clear();
            detail.root.hidden = true;
            commit(store);
        },
        openDetailDialog: (name) => openDetailDialog(ui, name),
        syncPager: () => pager.update(store.getState(), filterModels(store.getState()).length),
        refreshPreviews: (name, localSaved) => {
            const state = store.getState();
            for (const img of root.querySelectorAll("img[data-nu-preview]")) {
                if (img.dataset.nuPreview !== name) continue;
                reloadPreview(ui, img, name, {
                    type: state.activeModelType,
                    url: localSaved ? `${previewUrl(state.activeModelType, name)}&t=${Date.now()}` : "",
                });
            }
        },
    };

    /* ------------------------------------------------------ data loading */

    async function loadInitial() {
        status.textContent = tr("modelsLoading", "Loading…");
        const [metadata, cache, allGroups] = await Promise.all([
            coreModels.loadMetadata().catch(() => ({})),
            coreModels.loadCivitaiCache().catch(() => ({})),
            api.getModelGroups().catch(() => ({})),
        ]);
        const state = store.getState();
        state.modelMetadata = metadata && typeof metadata === "object" ? metadata : {};
        state.civitaiCache = cache && typeof cache === "object" ? cache : {};
        state.allModelGroups = allGroups && typeof allGroups === "object" ? allGroups : {};
        await loadType(state.activeModelType);
    }

    /** Fetch names + disabled set + groups for one type (reserved keys ensured). */
    async function loadType(type) {
        const state = store.getState();
        state.loading = true;
        state.error = null;
        commit(store);

        try {
            if (state.loaded[type] && (state.modelsByType[type] || []).length > 0) {
                await loadGroupsForType(ui, type);
                await loadSubdirs(ui);
                status.textContent = "";
                state.loading = false;
                commit(store);
                return;
            }

            const descriptor = FETCH_MAP[type];
            const client = descriptor ? comfyUI[descriptor.client] : null;
            const [models, disabled] = await Promise.all([
                typeof client === "function" ? client.call(comfyUI) : Promise.resolve([]),
                coreModels.loadDisabled(type).catch(() => new Set()),
            ]);
            const state2 = store.getState();
            state2.disabledModels[type] = disabled instanceof Set ? disabled : new Set();
            await loadGroupsForType(ui, type);
            const enabled = Array.isArray(models) ? models : [];
            // Disabled models are appended after the enabled list (upstream dedup order).
            state2.modelsByType[type] = [...new Set([...enabled, ...state2.disabledModels[type]])];
            state2.loaded[type] = true;
            await loadSubdirs(ui);
            status.textContent = state2.modelsByType[type].length ? "" : tr("modelsNoModels", "No models");
        } catch (err) {
            status.textContent = `${tr("modelsLoadError", "Failed to load models")}: ${err.message}`;
            status.className = "nu-error nu-models__status";
            snack(`${tr("modelsLoadError", "Failed to load models")}: ${err.message}`, "error");
        } finally {
            store.getState().loading = false;
            commit(store);
        }
    }

    /* ------------------------------------------------------------ render */

    function syncFilters(state) {
        if (search.input.value !== state.searchText) search.setValue(state.searchText);
        tagSelect.setOptions([{ value: "", label: tr("modelsAllTags", "Tags") }, ...tagOptions(state)]);
        tagSelect.setValue(state.tagFilter);
        dirSelect.setOptions([{ value: "", label: tr("modelsAllDirs", "Subdir") }, ...dirOptions(state)]);
        dirSelect.setValue(state.dirFilter);
        groupSelect.setOptions([{ value: "", label: tr("modelsAllGroups", "Groups") }, ...groupOptions(state)]);
        groupSelect.setValue(groupFilterValue(state));
        statusSelect.setValue(state.statusFilter);
        favChip.setSelected(state.showFavoritesOnly);
        batchChip.setSelected(state.showBatchOnly);
        typeSelector.setValue(state.activeModelType);
        viewSelector.setValue(state.viewMode);
        selectBtn.textContent = state.selectMode ? tr("modelSelectExit", "Exit select") : tr("modelSelectMode", "Select");
        selectBtn.setAttribute("aria-pressed", state.selectMode ? "true" : "false");
        civitaiBtn.disabled = state.civitaiRunning;
        clearBatchBtn.disabled = !state.modelGroups.Batch?.length;
        clearStackBtn.disabled = !state.modelGroups.Stack?.length;
    }

    /** A re-render must never move a keyboard user: keys survive via data-focus-key. */
    function preserveFocus(fn) {
        const active = document.activeElement;
        const key = active && root.contains(active) ? active.dataset?.focusKey || "" : "";
        const top = gridHost.scrollTop;
        fn();
        if (key) {
            const next = [...root.querySelectorAll("[data-focus-key]")].find((el) => el.dataset.focusKey === key);
            if (next && next !== active && typeof next.focus === "function") next.focus({ preventScroll: true });
        }
        gridHost.scrollTop = top;
    }

    function renderAll() {
        const state = store.getState();
        const filtered = filterModels(state);
        clampPage(state, filtered.length);
        const total = getCurrentModels(state).length;
        count.textContent = `${filtered.length} / ${total}`;
        syncFilters(state);
        badgeChips.refresh();
        const slice = pageSlice(state, filtered);

        preserveFocus(() => {
            if (state.viewMode === "table") {
                gridHost.className = "nu-models__grid nu-models__grid--table";
                renderTable(gridHost, ui, slice);
            } else {
                gridHost.className = "nu-models__grid";
                gridHost.setAttribute("role", "list");
                renderGrid(gridHost, ui, slice);
            }
        });

        pager.update(state, filtered.length);
        bulkBar.refresh();
        if (state.selectedModel) detail.show(state.selectedModel);
        else if (detail.currentName()) {
            detail.clear();
            detail.root.hidden = true;
        }
    }

    const unsubscribe = store.subscribe(() => renderAll());
    renderAll();
    loadInitial();

    return {
        destroy() {
            unsubscribe();
            civitaiBatch.destroy();
            container.textContent = "";
        },
        refresh() {
            commit(store);
        },
    };
}

export default render;
