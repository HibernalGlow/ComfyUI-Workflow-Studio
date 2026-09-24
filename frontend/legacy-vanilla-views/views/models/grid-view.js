/**
 * views/models/grid-view.js — thumbnail grid (brief §4 items 2, 10, 12, 13).
 *
 * One card per model: preview thumbnail, stem title, badges, the reserved-group
 * toggles (Batch for checkpoint/lora, Stack for lora), the favourite star and the
 * enable/disable switch. Single click opens the detail panel, double click opens the
 * detail dialog; in select mode a card carries a real checkbox and announces its
 * selection state instead of opening anything.
 *
 * Every action delegates: favourite → metadata write, enable → `state.js`,
 * batch/stack → `core/batch.js` via `groups.js`, selection → `bulk-actions.js`.
 */
import { baseNameOf, isBatchType, isStackType } from "../../core/index.js";
import { createCard } from "../../components/Card.js";
import { createCheckbox } from "../../components/Checkbox.js";
import { createIconButton } from "../../components/IconButton.js";
import { createBadge } from "./badges.js";
import { toggleSelection } from "./bulk-actions.js";
import { isInBatch, isInStack, toggleBatchForModel, toggleStackForModel } from "./groups.js";
import { commit, isModelDisabled, saveEntry, toggleModelEnabled, tr } from "./state.js";
import { attachLazyPreviews, createThumb } from "./preview.js";

/** Upstream `toggleFavorite`: flip, persist, re-render. */
export async function toggleFavorite(ui, name) {
    const state = ui.store.getState();
    const next = !state.modelMetadata[name]?.favorite;
    await saveEntry(ui, name, { favorite: next });
    commit(ui.store);
}

/** Gate: the B button exists for the Batch-capable types, S for Stack-capable ones. */
export function togglesFor(type) {
    return { batch: isBatchType(type), stack: isStackType(type) };
}

function actionRow(ui, name) {
    const state = ui.store.getState();
    const row = document.createElement("div");
    row.className = "nu-models-card__actions";
    const { batch, stack } = togglesFor(state.activeModelType);
    const disabled = isModelDisabled(state, name);
    /** Every control carries a stable key so a re-render can restore focus. */
    const icon = (key, options) => {
        const button = createIconButton(options);
        button.dataset.focusKey = `${key}:${name}`;
        return button;
    };

    if (batch) {
        row.appendChild(icon("batch", {
            icon: "B",
            ariaLabel: tr("modelsBatch", "Batch"),
            toggle: true,
            pressed: isInBatch(state, name),
            title: tr("modelsBatch", "Batch"),
            onClick: () => {
                toggleBatchForModel(ui, name).then(() => commit(ui.store));
            },
        }));
    }
    if (stack) {
        row.appendChild(icon("stack", {
            icon: "S",
            ariaLabel: "Stack",
            toggle: true,
            pressed: isInStack(state, name),
            title: "Stack",
            onClick: () => {
                toggleStackForModel(ui, name).then(() => commit(ui.store));
            },
        }));
    }
    row.appendChild(icon("fav", {
        icon: state.modelMetadata[name]?.favorite ? "★" : "☆",
        ariaLabel: tr("modelsFavorite", "Favorite"),
        toggle: true,
        pressed: Boolean(state.modelMetadata[name]?.favorite),
        onClick: () => {
            toggleFavorite(ui, name);
        },
    }));
    row.appendChild(icon("enable", {
        icon: disabled ? "▶" : "⏸",
        ariaLabel: disabled ? tr("modelEnable", "Enable") : tr("modelDisable", "Disable"),
        onClick: () => {
            toggleModelEnabled(ui, name).then(() => commit(ui.store));
        },
    }));
    return row;
}

function metaLine(ui, name) {
    const meta = ui.store.getState().modelMetadata[name] || {};
    const wrap = document.createElement("div");
    wrap.className = "nu-models-card__meta";
    for (const label of meta.badges || []) wrap.appendChild(createBadge(ui, label));
    for (const tag of meta.tags || []) {
        const chip = document.createElement("span");
        chip.className = "nu-badge nu-models-card__tag";
        chip.textContent = tag;
        wrap.appendChild(chip);
    }
    return wrap;
}

export function renderEmpty(host, message) {
    host.textContent = "";
    const empty = document.createElement("p");
    empty.className = "nu-empty";
    empty.textContent = message;
    host.appendChild(empty);
}

/** Thumbnail view: the page slice of the filtered list. */
export function renderGrid(host, ui, models) {
    const state = ui.store.getState();
    host.textContent = "";
    if (models.length === 0) {
        renderEmpty(host, tr("modelsNoModels", "No models"));
        return;
    }

    for (const name of models) {
        const checked = state.selectedModels.has(name);
        const disabled = isModelDisabled(state, name);

        const title = document.createElement("button");
        title.type = "button";
        title.className = "nu-models-card__title";
        title.textContent = baseNameOf(name).replace(/\.[^.]+$/, "");
        title.title = name;
        title.dataset.focusKey = `open:${name}`;
        title.addEventListener("click", (event) => {
            event.stopPropagation();
            if (ui.store.getState().selectMode) {
                toggleSelection(ui, name);
                return;
            }
            ui.showDetail?.(name);
        });

        const thumb = createThumb(ui, name, { alt: baseNameOf(name) });
        if (disabled) {
            const overlay = document.createElement("span");
            overlay.className = "nu-badge nu-models-card__disabled";
            overlay.textContent = tr("modelDisabled", "Disabled");
            thumb.root.appendChild(overlay);
        }

        const children = [thumb.root, title, metaLine(ui, name), actionRow(ui, name)];
        if (state.selectMode) {
            children.unshift(createCheckbox({
                label: tr("modelSelectMode", "Select"),
                checked,
                onChange: (on) => {
                    if (ui.store.getState().selectedModels.has(name) !== on) toggleSelection(ui, name);
                },
            }).root);
        }

        const card = createCard({
            variant: "outlined",
            children,
            onClick: (event) => {
                if (event?.target?.closest?.("button, input, a, label")) return;
                if (ui.store.getState().selectMode) {
                    toggleSelection(ui, name);
                    return;
                }
                ui.showDetail?.(name);
            },
        });
        card.classList.add("nu-models-card");
        if (disabled) card.classList.add("nu-models-card--disabled");
        if (state.selectedModel === name) card.classList.add("nu-models-card--selected");
        if (checked) card.classList.add("nu-models-card--checked");
        card.dataset.modelName = name;
        card.dataset.focusKey = `card:${name}`;
        card.setAttribute("aria-current", state.selectedModel === name ? "true" : "false");
        card.addEventListener("dblclick", (event) => {
            event.stopPropagation();
            if (ui.store.getState().selectMode) return;
            ui.openDetailDialog?.(name);
        });
        host.appendChild(card);
    }

    attachLazyPreviews(host, ui);
}
