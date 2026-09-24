/**
 * views/models/badges.js — badge palette, rendering, filter and bulk add/remove
 * (brief §4 item 7).
 *
 * A badge is a plain label. The palette maps `label -> CSS colour string` and is
 * persisted through the models prefs (`models_badge_palette`, i.e. `nu_…`).
 * Assignment per model lives in the metadata record (`meta.badges`), so deleting a
 * palette entry never strips the label from a model — orphans keep filtering and
 * render with the theme's fallback colour.
 *
 * Colours are user data: they are pushed into the `--nu-badge-color` custom
 * property (`style.setProperty`) and the stylesheet consumes it. No colour literal
 * is ever written here; a label without a palette colour simply does not set the
 * property and the CSS token applies.
 */
import { models as coreModels } from "../../core/index.js";
import { createButton } from "../../components/Button.js";
import { createChip } from "../../components/Chip.js";
import { createIconButton } from "../../components/IconButton.js";
import { createTextField } from "../../components/TextField.js";
import {
    commit,
    entryOf,
    saveEntries,
    saveBadgePalettePref,
    tr,
} from "./state.js";

export function getPalette(state) {
    return state.badgePalette || {};
}

export function paletteLabels(state) {
    return Object.keys(getPalette(state)).sort();
}

/** Palette colour for a label, or `null` so the caller falls back to a token. */
export function colorOf(state, label) {
    const value = getPalette(state)[label];
    return typeof value === "string" && value ? value : null;
}

export function setPalette(ui, palette) {
    const next = palette && typeof palette === "object" ? palette : {};
    ui.store.getState().badgePalette = next;
    saveBadgePalettePref(next);
    commit(ui.store);
}

/* ---------------------------------------------------------------- rendering */

/** One badge `<span>`; the palette colour travels as a custom property. */
export function createBadge(ui, label, { clickable = false } = {}) {
    const badge = document.createElement("span");
    badge.className = "nu-badge nu-models-badge";
    badge.textContent = label;
    badge.dataset.badge = label;
    const color = colorOf(ui.store.getState(), label);
    if (color) badge.style.setProperty("--nu-badge-color", color);
    if (clickable) {
        badge.classList.add("nu-models-badge--clickable");
        badge.tabIndex = 0;
    }
    return badge;
}

export function renderBadges(host, ui, labels) {
    host.textContent = "";
    for (const label of labels || []) host.appendChild(createBadge(ui, label));
    return host;
}

export function badgesOf(state, name) {
    return entryOf(state, name).badges;
}

/* -------------------------------------------------------------- filter bar */

/**
 * Single-select badge chips: clicking the active badge clears the filter.
 * Returns a handle whose `refresh()` re-reads the palette (after palette edits).
 */
export function createBadgeFilterBar(ui) {
    const root = document.createElement("div");
    root.className = "nu-models-badge-filter";
    root.setAttribute("role", "group");
    root.setAttribute("aria-label", tr("modelsBadges", "Badges"));
    let chips = [];

    function refresh() {
        const state = ui.store.getState();
        const labels = paletteLabels(state);
        root.textContent = "";
        chips = [];
        root.hidden = labels.length === 0;
        for (const label of labels) {
            const chip = createChip({
                label,
                variant: "filter",
                selected: state.badgeFilter === label,
                onToggle: () => {
                    const next = ui.store.getState();
                    next.badgeFilter = next.badgeFilter === label ? "" : label;
                    next.currentPage = 0;
                    commit(ui.store);
                },
            });
            const color = colorOf(state, label);
            if (color) chip.root.style.setProperty("--nu-badge-color", color);
            chip.root.classList.add("nu-models-badge-chip");
            chip.root.dataset.badge = label;
            chips.push(chip);
            root.appendChild(chip.root);
        }
    }

    refresh();
    return { root, refresh };
}

/* ------------------------------------------------------- palette edit dialog */

/**
 * Palette manager. Rows are `<label> <colour string> <colour picker> <remove>`;
 * the picker and the text field write the same palette entry, so either a CSS
 * colour string or a swatch pick is possible.
 */
export function openPaletteDialog(ui) {
    const body = document.createElement("div");
    body.className = "nu-models-palette";
    const list = document.createElement("div");
    list.className = "nu-models-palette__list";
    body.appendChild(list);

    const addRow = document.createElement("div");
    addRow.className = "nu-row";
    const labelField = createTextField({
        label: tr("badgeNewLabel", "New badge label"),
        value: "",
    });
    const colorField = createTextField({
        label: tr("badgeColorHint", "Colour (CSS value)"),
        value: "",
        placeholder: "var(--md-sys-color-primary)",
    });
    const addBtn = createButton({
        label: tr("badgeAdd", "Add"),
        variant: "filled",
        onClick: () => {
            const label = labelField.getValue().trim();
            if (!label) return;
            const palette = { ...getPalette(ui.store.getState()) };
            palette[label] = colorField.getValue().trim();
            labelField.setValue("");
            colorField.setValue("");
            setPalette(ui, palette);
            renderRows();
        },
    });
    addRow.append(labelField.root, colorField.root, addBtn);
    body.appendChild(addRow);

    function renderRows() {
        const state = ui.store.getState();
        list.textContent = "";
        const labels = paletteLabels(state);
        if (labels.length === 0) {
            const empty = document.createElement("p");
            empty.className = "nu-muted";
            empty.textContent = tr("badgeNone", "No badges yet");
            list.appendChild(empty);
            return;
        }
        for (const label of labels) {
            const row = document.createElement("div");
            row.className = "nu-row nu-models-palette__row";
            row.appendChild(createBadge(ui, label));

            const field = createTextField({
                label: tr("badgeColorHint", "Colour (CSS value)"),
                value: getPalette(state)[label] || "",
                onChange: (value) => {
                    const palette = { ...getPalette(ui.store.getState()) };
                    palette[label] = value.trim();
                    setPalette(ui, palette);
                },
            });
            row.appendChild(field.root);

            const picker = document.createElement("input");
            picker.type = "color";
            picker.className = "nu-models-palette__picker";
            picker.value = getPalette(state)[label] || "";
            picker.setAttribute("aria-label", tr("badgeColorHint", "Colour (CSS value)"));
            picker.addEventListener("input", () => {
                field.setValue(picker.value);
                const palette = { ...getPalette(ui.store.getState()) };
                palette[label] = picker.value;
                setPalette(ui, palette);
                renderRows();
            });
            row.appendChild(picker);

            row.appendChild(createIconButton({
                icon: "×",
                ariaLabel: tr("badgeDelete", "Delete badge"),
                variant: "standard",
                onClick: () => {
                    const palette = { ...getPalette(ui.store.getState()) };
                    delete palette[label];
                    setPalette(ui, palette);
                    renderRows();
                },
            }));
            list.appendChild(row);
        }
    }

    renderRows();
    return ui.openDialog({
        title: tr("badgeManage", "Manage badges"),
        content: body,
        actions: [{ label: tr("close", "Close"), variant: "text", value: true }],
    });
}

/* ---------------------------------------------------------------- assignment */

/** Replace one model's badge array; the whole array is sent, like upstream. */
export async function setModelBadges(ui, name, badges) {
    return coreModels
        .saveMetadata(name, { badges })
        .then((data) => {
            if (data?.metadata) ui.store.getState().modelMetadata[name] = data.metadata;
            return data;
        })
        .catch((err) => {
            ui.snack(`${tr("saveFailed", "Save failed")}: ${err.message}`, "error");
            return null;
        });
}

/** Add / remove one label across the current selection (skip no-op models). */
export async function applyBadge(ui, label, add) {
    const state = ui.store.getState();
    const names = [...state.selectedModels];
    const count = await saveEntries(ui, names, (entry) => {
        const badges = [...(entry.badges || [])];
        const at = badges.indexOf(label);
        if (add) {
            if (at !== -1) return null;
            badges.push(label);
        } else {
            if (at === -1) return null;
            badges.splice(at, 1);
        }
        return { badges };
    });
    if (count > 0) {
        const key = add ? "modelBulkBadgeApplyDone" : "modelBulkBadgeRemoveDone";
        ui.snack(`${count} ${tr(key, add ? "badge(s) added" : "badge(s) removed")}`, "success");
        commit(ui.store);
    }
    return count;
}

