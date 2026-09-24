/**
 * views/models/detail-panel.js — the side detail panel (brief §4 item 8), the detail
 * dialog (double click), and the "apply to Generate" bridge (item 14).
 *
 * Panel layout: preview + path / size / extension / subdir, then the editable tags and
 * memo, then the three tabs Info | Groups | CivitAI. Group editing writes the whole
 * per-type group map through `groups.js` (no delta endpoint exists).
 *
 * Item 14 is a **pure core call + store update**: `core/models.js` resolves the target
 * slot (`genUiTarget`) and the embedding token (`embeddingPromptToken`), and the intent
 * is published on the app store as `generateApply`. The Generate view reacts to that
 * key — this module never touches another view's DOM.
 */
import {
    api,
    baseNameOf,
    comfyUI,
    extOf,
    models as coreModels,
    subdirOf,
    typeLabel,
} from "../../core/index.js";
import { createButton } from "../../components/Button.js";
import { createCheckbox } from "../../components/Checkbox.js";
import { createIconButton } from "../../components/IconButton.js";
import { createSelect } from "../../components/Select.js";
import { createTabs } from "../../components/Tabs.js";
import { createTextField } from "../../components/TextField.js";
import { createBadge, getPalette, openPaletteDialog } from "./badges.js";
import { renderCivitaiPane } from "./civitai.js";
import {
    addToGroup,
    createGroup,
    deleteGroup,
    groupsOfModel,
    groupNames,
    isReservedGroup,
    removeFromGroup,
    renameGroup,
} from "./groups.js";
import { attachLazyPreviews, createThumb } from "./preview.js";
import { parseTagInput } from "./tags.js";
import { commit, entryOf, saveEntry, setGroupEnabled, tr } from "./state.js";

/** App-store key the Generate view subscribes to (see the module header). */
export const GENERATE_APPLY_KEY = "generateApply";

function stemOf(name) {
    return baseNameOf(name).replace(/\.[^.]+$/, "");
}

function formatSize(kb) {
    const value = Number(kb);
    if (!Number.isFinite(value) || value <= 0) return "—";
    if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(2)} GB`;
    if (value >= 1024) return `${(value / 1024).toFixed(1)} MB`;
    return `${Math.round(value)} KB`;
}

/* --------------------------------------------------------------- data fetch */

/** `GET filepath?type=&name=` → the absolute path, or the model name on failure. */
export async function loadFilePath(ui, name, target) {
    const state = ui.store.getState();
    let path = name;
    try {
        const data = await api.getModelFilePath(state.activeModelType, name);
        if (data?.path) path = data.path;
    } catch {
        path = name;
    }
    if (target) {
        target.textContent = path;
        target.title = path;
    }
    return path;
}

/** Upload a replacement thumbnail, then reload the affected previews. */
export async function changePreview(ui, name, file) {
    const state = ui.store.getState();
    try {
        await api.changeModelPreview(state.activeModelType, name, file);
        ui.snack(tr("thumbnailChanged", "Thumbnail updated"), "success");
        ui.refreshPreviews?.(name, true);
        return true;
    } catch (err) {
        ui.snack(`${tr("thumbnailError", "Thumbnail update failed")}: ${err.message}`, "error");
        return false;
    }
}

/* ------------------------------------------- apply to Generate (item 14) */

export function applyToGenUI(ui, name, modelType) {
    const target = coreModels.genUiTarget(modelType);
    if (!target || !target.slot) {
        ui.snack(tr("modelsGenUIUnsupported", "This model type cannot be applied to the Generate view"), "warning");
        return false;
    }
    if (!comfyUI.currentWorkflow) {
        ui.snack(tr("modelsGenUINoWorkflow", "Load a workflow first"), "warning");
        return false;
    }
    const loraNode = (comfyUI.currentAnalysis?.lora_nodes || [])[0];
    ui.appStore?.setState?.({
        [GENERATE_APPLY_KEY]: {
            kind: "slot",
            type: modelType,
            slot: target.slot,
            inputKey: target.inputKey,
            model: name,
            stem: stemOf(name),
            loraManager: Boolean(loraNode?.is_lora_manager),
            at: Date.now(),
        },
    });
    ui.snack(`${typeLabel(modelType)}: ${baseNameOf(name)}`, "success");
    return true;
}

export function applyEmbeddingToPrompt(ui, name, promptType) {
    if (!comfyUI.currentWorkflow) {
        ui.snack(tr("modelsGenUINoWorkflow", "Load a workflow first"), "warning");
        return false;
    }
    const token = coreModels.embeddingPromptToken(name);
    ui.appStore?.setState?.({
        [GENERATE_APPLY_KEY]: {
            kind: "prompt",
            promptType,
            token,
            model: name,
            stem: stemOf(name),
            at: Date.now(),
        },
    });
    ui.snack(`Embedding → ${promptType === "positive" ? "PP" : "NP"}: ${stemOf(name)}`, "success");
    return true;
}

/** The apply buttons for one model: slot types get one, embeddings get PP + NP. */
function applyButtons(ui, name, type) {
    const row = document.createElement("div");
    row.className = "nu-row";
    if (type === "embedding") {
        row.append(
            createButton({
                label: "GenUI PP",
                variant: "tonal",
                title: "Add to the positive prompt",
                onClick: () => applyEmbeddingToPrompt(ui, name, "positive"),
            }),
            createButton({
                label: "GenUI NP",
                variant: "text",
                title: "Add to the negative prompt",
                onClick: () => applyEmbeddingToPrompt(ui, name, "negative"),
            }),
        );
        return row;
    }
    if (coreModels.genUiTarget(type)?.slot) {
        row.appendChild(createButton({
            label: tr("modelsGenUIBtn", "Apply to GenerateUI"),
            variant: "tonal",
            title: tr("modelsGenUITitle", "Apply to the Generate view"),
            onClick: () => applyToGenUI(ui, name, type),
        }));
    }
    return row;
}

/* ------------------------------------------------------------- info pane */

function buildInfoPane(ui, name) {
    const state = ui.store.getState();
    const entry = entryOf(state, name);
    const pane = document.createElement("div");
    pane.className = "nu-models-detail__pane";

    const thumb = createThumb(ui, name, { alt: baseNameOf(name) });
    thumb.img.classList.add("nu-models-detail__img");
    pane.appendChild(thumb.root);
    attachLazyPreviews(thumb.root, ui);

    const facts = document.createElement("dl");
    facts.className = "nu-models-detail__facts";
    const addFact = (labelText, valueNode) => {
        const dt = document.createElement("dt");
        dt.textContent = labelText;
        const dd = document.createElement("dd");
        if (typeof valueNode === "string") dd.textContent = valueNode;
        else dd.appendChild(valueNode);
        facts.append(dt, dd);
    };

    const extBadges = document.createElement("span");
    extBadges.className = "nu-row";
    extBadges.appendChild(createBadge(ui, extOf(name) || "—"));
    const subdir = subdirOf(name);
    if (subdir) extBadges.appendChild(createBadge(ui, subdir));
    addFact(tr("modelsInfo", "Info"), extBadges);

    const pathEl = document.createElement("span");
    pathEl.className = "nu-models-detail__path";
    pathEl.textContent = tr("modelsLoading", "Loading…");
    pathEl.tabIndex = 0;
    pathEl.setAttribute("role", "button");
    pathEl.title = tr("modelsCopyPath", "Copy path");
    pathEl.addEventListener("click", () => {
        navigator.clipboard?.writeText(pathEl.textContent).then(
            () => ui.snack(tr("modelsCopiedPath", "Path copied"), "info"),
            () => {},
        );
    });
    addFact(tr("modelsFilePath", "File path"), pathEl);
    loadFilePath(ui, name, pathEl);

    const civitai = coreModels.civitaiFor(state.civitaiCache, { sha256: entry.sha256, name });
    addFact(tr("modelsSize", "Size"), formatSize(civitai?.fileSize));
    pane.appendChild(facts);

    const tags = createTextField({
        label: tr("modelsTags", "Tags"),
        value: entry.tags.join(", "),
        supportingText: tr("modelsTagsHint", "Comma separated"),
        placeholder: tr("modelsTagsPlaceholder", "style, portrait"),
    });
    const memo = createTextField({
        label: tr("modelsMemo", "Memo"),
        value: entry.memo,
        multiline: true,
        rows: 4,
    });
    pane.append(tags.root, memo.root);

    const actions = document.createElement("div");
    actions.className = "nu-row";
    const save = createButton({
        label: tr("modelsSave", "Save"),
        variant: "filled",
        onClick: async () => {
            await saveEntry(ui, name, { tags: parseTagInput(tags.getValue()), memo: memo.getValue() });
            ui.snack(tr("modelsSaved", "Saved"), "success");
            commit(ui.store);
        },
    });
    actions.append(save, applyButtons(ui, name, state.activeModelType));
    actions.appendChild(createButton({
        label: tr("modelsDelete", "Delete"),
        variant: "text",
        onClick: () => deleteWithConfirm(ui, name),
    }));
    pane.appendChild(actions);
    return { root: pane, thumb };
}

/* ------------------------------------------------------------ group pane */

function buildGroupPane(ui, name) {
    const state = ui.store.getState();
    const pane = document.createElement("div");
    pane.className = "nu-models-detail__pane";

    const heading = document.createElement("h4");
    heading.textContent = tr("modelsCurrentGroups", "Current groups");
    pane.appendChild(heading);

    const memberOf = groupsOfModel(state, name);
    if (memberOf.length === 0) {
        const empty = document.createElement("p");
        empty.className = "nu-muted";
        empty.textContent = tr("modelsNoGroup", "Not in any group");
        pane.appendChild(empty);
    }
    for (const groupName of memberOf) {
        const line = document.createElement("div");
        line.className = "nu-row";
        const label = document.createElement("span");
        label.textContent = groupName;
        label.className = "nu-models-detail__group-name";
        line.append(
            label,
            createIconButton({
                icon: "×",
                ariaLabel: `${tr("modelsRemoveFromGroup", "Remove from group")}: ${groupName}`,
                onClick: async () => {
                    await removeFromGroup(ui, groupName, [name]);
                    ui.refreshDetail?.();
                },
            }),
        );
        pane.appendChild(line);
    }

    const names = groupNames(state);
    const available = names.filter((groupName) => !memberOf.includes(groupName));
    const assign = createSelect({
        label: tr("modelsAssignGroup", "Add to group"),
        value: available[0] || "",
        options: available.length
            ? available.map((groupName) => ({ value: groupName, label: groupName }))
            : [{ value: "", label: tr("modelsNoGroupAvailable", "No group available") }],
        disabled: available.length === 0,
    });
    pane.appendChild(assign.root);
    pane.appendChild(createButton({
        label: tr("modelsAdd", "Add"),
        variant: "tonal",
        disabled: available.length === 0,
        onClick: async () => {
            await addToGroup(ui, assign.getValue(), [name]);
            ui.refreshDetail?.();
        },
    }));

    const newName = createTextField({ label: tr("modelsGroupName", "Group name"), value: "" });
    pane.append(newName.root, createButton({
        label: tr("modelsCreate", "Create"),
        variant: "text",
        onClick: async () => {
            const value = newName.getValue().trim();
            if (!value) return;
            await createGroup(ui, value, [name]);
            ui.refreshDetail?.();
        },
    }));

    const manageHeading = document.createElement("h4");
    manageHeading.textContent = tr("modelsManageGroups", "Manage groups");
    pane.appendChild(manageHeading);
    const manage = createSelect({
        label: tr("modelsAllGroups", "Group"),
        value: names[0] || "",
        options: names.map((groupName) => ({ value: groupName, label: groupName })),
        disabled: names.length === 0,
        onChange: () => {},
    });
    pane.appendChild(manage.root);

    const manageButtons = document.createElement("div");
    manageButtons.className = "nu-row";
    manageButtons.append(
        createButton({
            label: tr("modelsRename", "Rename"),
            variant: "text",
            disabled: names.length === 0,
            onClick: async () => {
                const from = manage.getValue();
                if (!from || isReservedGroup(from)) {
                    if (isReservedGroup(from)) ui.snack(tr("modelsGroupReserved", "Reserved group names cannot be changed"), "warning");
                    return;
                }
                const to = await ui.prompt({ title: tr("modelsRenamePrompt", "New group name"), value: from });
                await renameGroup(ui, from, to || "");
                ui.refreshDetail?.();
            },
        }),
        createButton({
            label: tr("modelsDelete", "Delete"),
            variant: "text",
            disabled: names.length === 0,
            onClick: async () => {
                await deleteGroup(ui, manage.getValue());
                ui.refreshDetail?.();
            },
        }),
        createButton({
            label: tr("modelGroupEnableAll", "Enable all"),
            variant: "tonal",
            disabled: names.length === 0,
            onClick: async () => {
                await setGroupEnabled(ui, manage.getValue(), true);
                commit(ui.store);
            },
        }),
        createButton({
            label: tr("modelGroupDisableAll", "Disable all"),
            variant: "text",
            disabled: names.length === 0,
            onClick: async () => {
                await setGroupEnabled(ui, manage.getValue(), false);
                commit(ui.store);
            },
        }),
    );
    pane.appendChild(manageButtons);
    return pane;
}

/* ------------------------------------------------------------ delete helper */

async function deleteWithConfirm(ui, name) {
    const ok = await ui.confirm({
        title: tr("modelBulkDelete", "Delete models"),
        content: tr("modelBulkDeleteConfirm", "Delete {count} model file(s)?").replace("{count}", "1"),
        confirmLabel: tr("modelsDelete", "Delete"),
        danger: true,
    });
    if (!ok) return false;
    const state = ui.store.getState();
    try {
        const data = await api.deleteModels(state.activeModelType, [name]);
        if (data?.errors?.length) {
            ui.snack(`${tr("modelBulkDeleteError", "Delete failed")}: ${data.errors[0].error}`, "error");
            return false;
        }
        const list = state.modelsByType[state.activeModelType] || [];
        const index = list.indexOf(name);
        if (index !== -1) list.splice(index, 1);
        delete state.modelMetadata[name];
        state.disabledModels[state.activeModelType]?.delete(name);
        state.selectedModels.delete(name);
        if (state.selectedModel === name) state.selectedModel = null;
        ui.snack(`${stemOf(name)} ${tr("modelBulkDeleteDone", "deleted")}`, "success");
        commit(ui.store);
        return true;
    } catch (err) {
        ui.snack(`${tr("modelBulkDeleteError", "Delete failed")}: ${err.message}`, "error");
        return false;
    }
}

/* ------------------------------------------------------------ the panel */

/** Side panel handle; `show(name)` renders the panel for one model. */
export function createDetailPanel(ui) {
    const root = document.createElement("aside");
    root.className = "nu-models-detail";
    root.setAttribute("aria-label", tr("modelsInfo", "Model detail"));
    let current = null;
    let tabs = null;

    function clear() {
        root.textContent = "";
        current = null;
    }

    function panelFor(name) {
        root.textContent = "";
        const state = ui.store.getState();
        const head = document.createElement("div");
        head.className = "nu-models-detail__head";
        const title = document.createElement("h3");
        title.className = "nu-models-detail__title";
        title.textContent = baseNameOf(name);
        title.title = name;
        title.tabIndex = 0;
        title.addEventListener("click", () => {
            navigator.clipboard?.writeText(name).then(
                () => ui.snack(tr("modelsCopiedName", "Name copied"), "info"),
                () => {},
            );
        });
        head.append(title, createIconButton({
            icon: "×",
            ariaLabel: tr("close", "Close"),
            onClick: () => ui.closeDetail?.(),
        }));
        root.appendChild(head);

        const infoPane = buildInfoPane(ui, name);
        const groupPane = buildGroupPane(ui, name);
        const civitaiPane = document.createElement("div");
        civitaiPane.className = "nu-models-detail__pane";
        const paneHost = document.createElement("div");
        paneHost.className = "nu-models-detail__panes";

        tabs = createTabs({
            tabs: [
                { id: "info", label: tr("modelsInfo", "Info") },
                { id: "group", label: tr("modelsAllGroups", "Groups") },
                { id: "civitai", label: "CivitAI" },
            ],
            activeId: tabs?.getActive?.() || "info",
            onChange: (id) => {
                infoPane.root.hidden = id !== "info";
                groupPane.hidden = id !== "group";
                civitaiPane.hidden = id !== "civitai";
                if (id === "civitai") renderCivitaiPane(civitaiPane, ui, name);
            },
        });
        root.appendChild(tabs.root);
        infoPane.root.hidden = false;
        groupPane.hidden = true;
        civitaiPane.hidden = true;
        renderCivitaiPane(civitaiPane, ui, name);
        paneHost.append(infoPane.root, groupPane, civitaiPane);
        root.appendChild(paneHost);

        const upload = document.createElement("input");
        upload.type = "file";
        upload.accept = "image/*";
        upload.className = "nu-hidden";
        upload.addEventListener("change", () => {
            const file = upload.files?.[0];
            upload.value = "";
            if (file) changePreview(ui, name, file);
        });
        root.append(upload, createButton({
            label: tr("changeThumbnail", "Change thumbnail"),
            variant: "outlined",
            onClick: () => upload.click(),
        }));
        current = { name, thumb: infoPane.thumb };
        return root;
    }

    function show(name) {
        if (!name) return clear();
        if (name !== current?.name) panelFor(name);
        root.hidden = false;
        return current;
    }

    function refresh() {
        const name = ui.store.getState().selectedModel;
        if (!name) return clear();
        return panelFor(name);
    }

    clear();
    root.hidden = true;
    return { root, show, refresh, clear, currentName: () => current?.name || null };
}

/* ------------------------------------------------------- detail dialog */

/** The double-click dialog: preview, badges, tags, memo, favourite, apply, delete. */
export function openDetailDialog(ui, name) {
    const state = ui.store.getState();
    const entry = entryOf(state, name);
    const content = document.createElement("div");
    content.className = "nu-models-dialog";

    const thumb = createThumb(ui, name, { alt: baseNameOf(name) });
    thumb.img.classList.add("nu-models-detail__img");
    content.appendChild(thumb.root);
    attachLazyPreviews(thumb.root, ui);

    content.appendChild(createCheckbox({
        label: tr("modelsFavorite", "Favorite"),
        checked: entry.favorite,
        onChange: async (on) => {
            await saveEntry(ui, name, { favorite: Boolean(on) });
            commit(ui.store);
        },
    }).root);

    const badgeBoxes = new Map();
    const badgeWrap = document.createElement("div");
    badgeWrap.className = "nu-row nu-models-dialog__badges";
    for (const label of Object.keys(getPalette(state)).sort()) {
        const box = createCheckbox({
            label,
            checked: entry.badges.includes(label),
        });
        badgeBoxes.set(label, box);
        badgeWrap.appendChild(box.root);
    }
    if (badgeBoxes.size === 0) {
        const hint = document.createElement("p");
        hint.className = "nu-muted";
        hint.textContent = tr("badgeNoneHint", "No badges defined yet");
        badgeWrap.appendChild(hint);
    }
    content.append(badgeWrap, createButton({
        label: tr("badgeManage", "Manage badges"),
        variant: "text",
        onClick: () => openPaletteDialog(ui),
    }));

    const tags = createTextField({ label: tr("modelsTags", "Tags"), value: entry.tags.join(", ") });
    const memo = createTextField({ label: tr("modelsMemo", "Memo"), value: entry.memo, multiline: true, rows: 4 });
    content.append(tags.root, memo.root, applyButtons(ui, name, state.activeModelType));

    const save = async () => {
        const badges = [...badgeBoxes.entries()].filter(([, box]) => box.isChecked()).map(([label]) => label);
        await saveEntry(ui, name, { tags: parseTagInput(tags.getValue()), memo: memo.getValue(), badges });
        ui.snack(tr("modelsSaved", "Saved"), "success");
        commit(ui.store);
    };

    return ui.openDialog({
        title: stemOf(name),
        wide: true,
        content,
        actions: [
            {
                label: tr("modelsDelete", "Delete"),
                variant: "text",
                close: false,
                onClick: () => deleteWithConfirm(ui, name),
                danger: true,
            },
            { label: tr("modelsSave", "Save"), variant: "filled", close: false, onClick: save },
            { label: tr("close", "Close"), variant: "text", value: true },
        ],
    });
}
