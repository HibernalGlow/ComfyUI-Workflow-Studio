/**
 * views/workflow.js — Workflow library + parameter form (parity table items 1 and 2).
 *
 * Left pane: every `api.listWorkflows()` entry, filtered by the search field.
 * Right pane: the selected workflow — its node-input form (built by ./workflow/form.js from the
 * API format) and its raw JSON (./workflow/json.js), kept in sync with each other and with the
 * in-memory workflow object this view owns.
 *
 * Ownership: the view owns the API-format workflow after load; every edit writes into that object
 * and is republished to `ctx.store` so the Generate view can consume the same instance. Loading a
 * file goes through ./workflow/loader.js, which is also what the Generate view uses, so both views
 * agree on `comfyUI.currentWorkflow` / `currentAnalysis` (what the pipeline reads).
 *
 * Parity item 2 (UI↔API conversion) is satisfied by reusing `comfyWorkflow` — this module never
 * converts graphs itself.
 */

import { api, t } from "../../core/index.js";
import { createButton } from "../components/Button.js";
import { createList } from "../components/List.js";
import { createTabs } from "../components/Tabs.js";
import { createTextField } from "../components/TextField.js";
import { createParamForm } from "./workflow/form.js";
import { createJsonPanel } from "./workflow/json.js";
import { adoptWorkflow, loadWorkflowIntoEditor, modelBadge } from "./workflow/loader.js";

function tr(key, fallback) {
    const value = t(key);
    return value !== undefined && value !== null && value !== key ? String(value) : fallback;
}

const IMAGE_ACCEPT = "image/png,image/webp,image/jpeg";

/** Compact `dl` of an analysis object; every value goes through textContent. */
function renderAnalysis(container, analysis) {
    container.replaceChildren();
    if (!analysis) {
        container.textContent = tr("noAnalysis", "No analysis yet — press Analyze.");
        return;
    }
    const list = document.createElement("dl");
    list.className = "nu-workflow-analysis";
    for (const [key, value] of Object.entries(analysis)) {
        const term = document.createElement("dt");
        term.textContent = key;
        const def = document.createElement("dd");
        if (value === null || value === undefined) def.textContent = "—";
        else if (Array.isArray(value)) def.textContent = value.length ? value.map(String).join(", ") : "—";
        else if (typeof value === "object") def.textContent = JSON.stringify(value);
        else def.textContent = String(value);
        list.append(term, def);
    }
    container.append(list);
}

/** Hidden file input + a button that opens it (the `hidden` attribute needs no CSS). */
function filePicker({ accept, multiple = false, onFiles }) {
    const input = document.createElement("input");
    input.type = "file";
    input.hidden = true;
    input.accept = accept;
    input.multiple = multiple;
    input.addEventListener("change", () => {
        const files = [...(input.files || [])];
        input.value = "";
        if (files.length > 0) onFiles(files);
    });
    const button = { input, open: () => input.click() };
    return button;
}

export function render(container, ctx) {
    const { store, snackbar, dialog } = ctx;
    const notify = (label, actionLabel, onAction) => {
        if (snackbar?.showSnackbar) snackbar.showSnackbar({ label, actionLabel, onAction });
    };
    const fail = (err) => notify(`${tr("saveError", "Error")}: ${err?.message || err}`, tr("dismiss", "Dismiss"));

    const state = {
        entries: [],
        filter: "",
        selected: "",
        workflow: null,
        analysis: null,
        rev: 0,
    };

    /* ---------------------------------------------------------------- shell */
    const view = document.createElement("div");
    view.className = "nu-view nu-workflow";

    const header = document.createElement("header");
    header.className = "nu-view__header";
    const title = document.createElement("h1");
    title.className = "nu-view__title";
    title.textContent = tr("tabWorkflow", "Workflow");

    const search = createTextField({
        label: tr("search", "Search"),
        placeholder: tr("filterPlaceholder", "Filter workflows..."),
        onInput: (event) => {
            state.filter = event.target.value.trim().toLowerCase();
            paintList();
        },
    });
    search.root.classList.add("nu-workflow__search");

    const importFiles = filePicker({
        accept: "application/json,.json",
        multiple: true,
        onFiles: (files) => doImport(files),
    });
    const thumbFile = filePicker({ accept: IMAGE_ACCEPT, onFiles: (files) => doThumbnail(files[0]) });

    const toolbar = document.createElement("div");
    toolbar.className = "nu-view__toolbar";
    toolbar.append(
        search.root,
        createButton({
            label: tr("import", "Import"),
            variant: "tonal",
            onClick: () => importFiles.open(),
        }),
        createButton({
            label: tr("reanalyzeAll", "Re-analyze all"),
            variant: "text",
            onClick: () => doReanalyzeAll(),
        })
    );
    header.append(title, toolbar);

    const body = document.createElement("div");
    body.className = "nu-view__body nu-workflow__body";

    /* ------------------------------------------------------------ list pane */
    const listPane = document.createElement("section");
    listPane.className = "nu-workflow__list";
    const list = createList({ items: [], onSelect: (id) => selectWorkflow(id) });
    listPane.append(list.root);

    /* ---------------------------------------------------------- detail pane */
    const detail = document.createElement("section");
    detail.className = "nu-workflow__detail";

    const detailHead = document.createElement("div");
    detailHead.className = "nu-workflow__head";
    const name = document.createElement("h2");
    name.className = "nu-workflow__name";
    name.textContent = tr("noWorkflowSelected", "No workflow selected");
    const badge = document.createElement("span");
    badge.className = "nu-badge nu-workflow__badge";
    badge.hidden = true;
    const actions = document.createElement("div");
    actions.className = "nu-row nu-workflow__actions";
    const actionButtons = {
        save: createButton({ label: tr("save", "Save"), variant: "filled", onClick: () => doSave() }),
        rename: createButton({ label: tr("rename", "Rename"), variant: "outlined", onClick: () => doRename() }),
        thumbnail: createButton({
            label: tr("changeThumbnail", "Thumbnail"),
            variant: "outlined",
            onClick: () => thumbFile.open(),
        }),
        analyze: createButton({ label: tr("analyze", "Analyze"), variant: "outlined", onClick: () => doAnalyze() }),
        remove: createButton({ label: tr("delete", "Delete"), variant: "text", onClick: () => doDelete() }),
    };
    actions.append(
        actionButtons.save,
        actionButtons.rename,
        actionButtons.thumbnail,
        actionButtons.analyze,
        actionButtons.remove
    );
    for (const button of Object.values(actionButtons)) button.disabled = true;
    detailHead.append(name, badge, actions);

    const analysisPanel = document.createElement("div");
    analysisPanel.className = "nu-workflow__analysis";
    analysisPanel.setAttribute("role", "status");

    const panels = document.createElement("div");
    panels.className = "nu-workflow__panels";
    const paramsPanel = document.createElement("div");
    paramsPanel.className = "m3-tabpanel";
    const jsonPanelHost = document.createElement("div");
    jsonPanelHost.className = "m3-tabpanel";
    jsonPanelHost.id = "nu-workflow-panel-json";
    paramsPanel.id = "nu-workflow-panel-params";
    panels.append(paramsPanel, jsonPanelHost);

    const tabs = createTabs({
        tabs: [
            { id: "params", label: tr("parameters", "Parameters"), panelId: paramsPanel.id },
            { id: "json", label: tr("rawJson", "Raw JSON"), panelId: jsonPanelHost.id },
        ],
        activeId: "params",
        ariaLabel: tr("workflowPanels", "Workflow panels"),
        onChange: (id) => {
            paramsPanel.hidden = id !== "params";
            jsonPanelHost.hidden = id !== "json";
        },
    });

    const empty = document.createElement("p");
    empty.className = "nu-empty nu-workflow__empty";
    empty.textContent = tr("selectWorkflowHint", "Select a workflow on the left to edit its parameters.");

    detail.append(detailHead, tabs.root, analysisPanel, panels, empty);
    body.append(listPane, detail);
    view.append(header, body, importFiles.input, thumbFile.input);
    container.append(view);

    let paramForm = null;
    let jsonView = null;

    /* ------------------------------------------------------------- helpers */
    function setActionsEnabled(enabled) {
        for (const button of Object.values(actionButtons)) button.disabled = !enabled;
    }

    function publish() {
        state.rev += 1;
        store?.setState?.({
            workflowApi: state.workflow,
            workflowName: state.selected,
            workflowAnalysis: state.analysis,
            workflowList: state.entries,
            workflowRev: state.rev,
        });
    }

    /** A JSON edit (or a fresh load) replaces the object; rebuild both sides from it. */
    function adopt(workflow, { fromJson = false } = {}) {
        state.workflow = workflow;
        const adopted = adoptWorkflow(state.selected, workflow);
        state.analysis = adopted.analysis;
        if (jsonView) jsonView.setValue(workflow);
        if (fromJson) paramForm?.refresh(workflow);
        badge.hidden = false;
        const label = modelBadge(state.analysis);
        badge.hidden = !label;
        badge.textContent = label;
        publish();
    }

    function onFieldWrite(nodeId, key, value) {
        if (!state.workflow?.[nodeId]?.inputs) return;
        state.workflow[nodeId].inputs[key] = value;
        jsonView?.setValue(state.workflow);
        publish();
    }

    function buildPanels() {
        paramForm?.root.remove?.();
        jsonView?.root.remove?.();
        paramForm = createParamForm({ workflow: state.workflow, onWrite: onFieldWrite });
        jsonView = createJsonPanel({
            value: state.workflow,
            onApply: (parsed) => {
                adopt(parsed, { fromJson: true });
                renderAnalysis(analysisPanel, state.analysis);
                notify(tr("jsonApplied", "JSON applied."));
            },
        });
        paramsPanel.replaceChildren(paramForm.root);
        jsonPanelHost.replaceChildren(jsonView.root);
    }

    function paintList() {
        const needle = state.filter;
        const items = state.entries
            .filter((entry) => {
                if (!needle) return true;
                const types = (entry.analysis?.modelTypes || []).join(" ");
                return `${entry.filename} ${types}`.toLowerCase().includes(needle);
            })
            .map((entry) => {
                const types = entry.analysis?.modelTypes || [];
                return {
                    id: entry.filename,
                    headline: entry.filename,
                    supportingText: types.length > 0 ? types.join(", ") : entry.analysis?.format || "",
                    leading: entry.thumbnail ? thumbnailNode(entry) : undefined,
                    selected: entry.filename === state.selected,
                };
            });
        list.setItems(items);
        list.setSelected(state.selected);
    }

    function thumbnailNode(entry) {
        const image = document.createElement("img");
        image.className = "nu-workflow__thumb";
        image.alt = "";
        image.loading = "lazy";
        image.src = entry.thumbnail;
        return image;
    }

    async function selectWorkflow(filename) {
        if (!filename || filename === state.selected) return;
        state.selected = filename;
        name.textContent = filename;
        try {
            const loaded = await loadWorkflowIntoEditor(filename);
            state.workflow = loaded.workflow;
            state.analysis = loaded.analysis;
            setActionsEnabled(true);
            empty.hidden = true;
            const label = modelBadge(state.analysis);
            badge.hidden = !label;
            badge.textContent = label;
            buildPanels();
            analysisPanel.replaceChildren();
            for (const warning of loaded.warnings) notify(warning);
            publish();
        } catch (err) {
            state.workflow = null;
            setActionsEnabled(false);
            fail(err);
        }
        paintList();
    }

    async function refreshList() {
        try {
            const entries = await api.listWorkflows();
            state.entries = Array.isArray(entries) ? entries : [];
            paintList();
        } catch (err) {
            fail(err);
        }
    }

    /* ------------------------------------------------------------- actions */
    async function doSave() {
        if (!state.workflow) return;
        try {
            await api.saveWorkflow(state.selected, state.workflow);
            notify(tr("settingsSaved", "Saved."));
            await refreshList();
        } catch (err) {
            fail(err);
        }
    }

    async function doRename() {
        if (!state.selected) return;
        const stem = state.selected.replace(/\.json$/i, "");
        const next = dialog?.prompt
            ? await dialog.prompt({
                  title: tr("rename", "Rename"),
                  label: tr("newName", "New name"),
                  value: stem,
                  confirmLabel: tr("save", "Save"),
              })
            : null;
        if (!next || next === stem) return;
        try {
            await api.renameWorkflow(state.selected, next);
            state.selected = /\.json$/i.test(next) ? next : `${next}.json`;
            await refreshList();
            name.textContent = state.selected;
        } catch (err) {
            fail(err);
        }
    }

    async function doDelete() {
        if (!state.selected) return;
        const ok = dialog?.confirm
            ? await dialog.confirm({
                  title: tr("delete", "Delete"),
                  content: `${state.selected}`,
                  confirmLabel: tr("delete", "Delete"),
                  danger: true,
              })
            : false;
        if (!ok) return;
        try {
            await api.deleteWorkflow(state.selected);
            resetSelection();
            await refreshList();
        } catch (err) {
            fail(err);
        }
    }

    function resetSelection() {
        state.selected = "";
        state.workflow = null;
        state.analysis = null;
        setActionsEnabled(false);
        badge.hidden = true;
        name.textContent = tr("noWorkflowSelected", "No workflow selected");
        analysisPanel.replaceChildren();
        paramsPanel.replaceChildren();
        jsonPanelHost.replaceChildren();
        empty.hidden = false;
        publish();
    }

    async function doThumbnail(file) {
        if (!state.selected || !file) return;
        try {
            await api.changeWorkflowThumbnail(state.selected, file);
            notify(tr("settingsSaved", "Saved."));
            await refreshList();
        } catch (err) {
            fail(err);
        }
    }

    async function doImport(files) {
        try {
            const result = await api.importWorkflows(files);
            const results = Array.isArray(result?.results) ? result.results : [];
            const failed = results.filter((entry) => entry.status !== "success");
            notify(
                `${results.length - failed.length}/${results.length} ${tr("import", "Import")}`,
                failed.length ? tr("showFailed", "Show failed") : null,
                failed.length
                    ? () => failed.forEach((entry) => notify(`${entry.name}: ${entry.message || entry.status}`))
                    : null
            );
            await refreshList();
        } catch (err) {
            fail(err);
        }
    }

    async function doAnalyze() {
        if (!state.selected) return;
        try {
            const result = await api.analyzeWorkflow(state.selected);
            const analysis = result?.analysis || result;
            state.analysis = analysis;
            renderAnalysis(analysisPanel, analysis);
            const entry = state.entries.find((item) => item.filename === state.selected);
            if (entry) entry.analysis = analysis;
            paintList();
            publish();
        } catch (err) {
            fail(err);
        }
    }

    async function doReanalyzeAll() {
        try {
            await api.reanalyzeAllWorkflows();
            await refreshList();
            notify(tr("settingsSaved", "Saved."));
        } catch (err) {
            fail(err);
        }
    }

    /* --------------------------------------------------------------- start */
    const tabLabels = [...tabs.root.querySelectorAll(".m3-tab")];
    if (tabLabels.length === 0) {
        // No tabs component rendered: show both panels rather than hiding either.
        paramsPanel.hidden = false;
        jsonPanelHost.hidden = false;
    }
    jsonPanelHost.hidden = true;
    setActionsEnabled(false);
    refreshList();

    // A workflow pushed by another view (e.g. a Gallery "load into editor") adopts it as-is.
    const unsubscribe = store?.subscribe?.((next) => {
        if (next.workflowApi && next.workflowApi !== state.workflow && next.workflowRev !== state.rev) {
            state.selected = next.workflowName || state.selected;
            state.workflow = next.workflowApi;
            state.analysis = next.workflowAnalysis || state.analysis;
            name.textContent = state.selected || name.textContent;
            setActionsEnabled(true);
            empty.hidden = true;
            buildPanels();
            paintList();
        }
    });

    return {
        refresh() {
            return refreshList();
        },
        destroy() {
            if (typeof unsubscribe === "function") unsubscribe();
        },
    };
}
