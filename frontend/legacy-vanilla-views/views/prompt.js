/**
 * views/prompt.js — Prompt workbench (brief §5).
 *
 * Three sections, one view root:
 *   Library   — prompt preset CRUD over `api.listPrompts|createPrompt|updatePrompt|deletePrompt`
 *   Styles    — style catalog CRUD + "apply style to the prompt text" (views/prompt/styles.js)
 *   Wildcards — file CRUD, Impact-Pack link, live `__name__` expansion (views/prompt/wildcards.js)
 *
 * The view owns every container it renders (zero element ids), re-renders itself and
 * only ever talks to the backend through `core/index.js`.
 *
 * Store handoff (the only cross-view contract this view writes):
 *   ctx.store.setState({ prompt, negativePrompt, promptSource: "prompt" })
 * — the Generate view reads those keys when it adopts a prompt.
 *
 * Deliberate delta vs the upstream Prompt tab: the `Table` sub-view is out of scope
 * (brief §5) and the localStorage-only "preset groups" feature is dropped — the core
 * layer has no storage contract for it and a new `nu_*` key would create a second
 * source of truth for the same presets. Prefs used here: `nu_prompt_tab`,
 * `nu_prompt_favorites_only`.
 */

import { api, t, readPref, writePref } from "../../core/index.js";
import { createButton } from "../components/Button.js";
import { createIconButton } from "../components/IconButton.js";
import { createTextField } from "../components/TextField.js";
import { createChip } from "../components/Chip.js";
import { createTabs } from "../components/Tabs.js";
import { confirm } from "../dialog.js";
import { showSnackbar } from "../snackbar.js";
import { initRipple } from "../ripple.js";
import { createStylesPanel } from "./prompt/styles.js";
import { createWildcardsPanel } from "./prompt/wildcards.js";

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
}

/**
 * @param {HTMLElement} container the view root handed over by the router
 * @param {{store?:object, navigate?:Function}} ctx
 * @returns {{destroy:()=>void, refresh:()=>Promise<void>}}
 */
export function render(container, ctx) {
    container.replaceChildren();

    const state = {
        prompts: [],
        selectedId: null,
        search: "",
        favoritesOnly: readPref("prompt_favorites_only", false) === true,
        tab: String(readPref("prompt_tab", "library") || "library"),
        destroyed: false,
    };

    const view = el("section", "nu-view nu-prompt");

    // ── header ──────────────────────────────────────────────────────────────
    const header = el("header", "nu-view__header");
    const heading = el("div", "nu-stack");
    heading.appendChild(el("h1", "nu-view__title", t("prompt")));
    heading.appendChild(el("p", "nu-view__subtitle nu-muted", "Prompt library, style catalog and wildcards — send text to Generate when it is ready."));
    const headerTools = el("div", "nu-view__toolbar");
    const refreshBtn = createIconButton({
        icon: "⟳",
        ariaLabel: t("refresh"),
        title: t("refresh"),
        onClick: () => loadPrompts(),
    });
    const newBtn = createButton({
        label: "New prompt",
        variant: "filled",
        onClick: () => selectPrompt(null),
    });
    headerTools.append(refreshBtn, newBtn);
    header.append(heading, headerTools);

    // ── sections ────────────────────────────────────────────────────────────
    const panels = el("div", "nu-prompt__panels");
    const libraryPanel = el("div", "nu-view__body nu-prompt__panel");

    const tabs = createTabs({
        tabs: [
            { id: "library", label: "Library" },
            { id: "styles", label: "Styles" },
            { id: "wildcards", label: "Wildcards" },
        ],
        activeId: state.tab,
        onChange: (id) => setTab(id),
        ariaLabel: "Prompt workbench sections",
    });

    // ── library: list + editor ──────────────────────────────────────────────
    const grid = el("div", "nu-prompt__grid");
    grid.style.cssText =
        "display:grid;grid-template-columns:minmax(240px,320px) minmax(0,1fr);gap:16px;align-items:start";

    const sidebar = el("div", "nu-prompt__sidebar");
    sidebar.style.cssText = "display:flex;flex-direction:column;gap:8px;min-width:0";

    const searchField = createTextField({
        label: "Search prompts",
        placeholder: t("searchPlaceholder"),
        onInput: (value) => {
            state.search = String(value || "");
            renderList();
        },
    });
    const favChip = createChip({
        label: t("favorite"),
        variant: "filter",
        selected: state.favoritesOnly,
        onToggle: (selected) => {
            state.favoritesOnly = !!selected;
            writePref("prompt_favorites_only", state.favoritesOnly);
            renderList();
        },
    });
    const list = el("ul", "m3-list nu-prompt__list");
    list.setAttribute("aria-label", "Prompt presets");
    list.style.cssText = "max-height:56vh;overflow:auto;margin:0;padding:0";
    sidebar.append(searchField.root, favChip.root, list);

    const editor = el("div", "nu-prompt__editor");
    editor.style.cssText = "display:flex;flex-direction:column;gap:10px;min-width:0";
    const statusLabel = el("p", "nu-field__supporting-text nu-muted", "");
    const nameField = createTextField({ label: "Name", placeholder: "Preset name" });
    const categoryField = createTextField({ label: "Category", placeholder: "optional" });
    const posField = createTextField({
        label: t("positivePrompt"),
        multiline: true,
        rows: 6,
        placeholder: "a photo of ...",
    });
    const negField = createTextField({
        label: t("negativePrompt"),
        multiline: true,
        rows: 4,
        placeholder: "blurry, low quality",
    });

    const editorActions = el("div", "nu-row");
    const saveBtn = createButton({ label: t("save"), variant: "filled", onClick: () => savePrompt() });
    const deleteBtn = createButton({ label: t("delete"), variant: "outlined", onClick: () => deletePrompt() });
    const copyPosBtn = createButton({ label: `${t("copy")} +`, variant: "text", onClick: () => copy(posField.getValue()) });
    const copyNegBtn = createButton({ label: `${t("copy")} -`, variant: "text", onClick: () => copy(negField.getValue()) });
    const sendBtn = createButton({ label: "Send to Generate", variant: "tonal", onClick: () => sendToGenerate() });
    editorActions.append(saveBtn, deleteBtn, copyPosBtn, copyNegBtn, sendBtn);
    editor.append(statusLabel, nameField.root, categoryField.root, posField.root, negField.root, editorActions);

    grid.append(sidebar, editor);
    libraryPanel.appendChild(grid);

    // ── styles + wildcards panels ───────────────────────────────────────────
    const stylesPanel = createStylesPanel({
        getPositive: () => posField.getValue(),
        assign: (kind, textValue) => {
            const field = kind === "negative" ? negField : posField;
            field.setValue(textValue);
            showSnackbar({
                label: `${kind === "negative" ? t("negativePrompt") : t("positivePrompt")} updated`,
                timeout: 2500,
            });
        },
    });
    const wildcardsPanel = createWildcardsPanel(ctx);

    panels.append(libraryPanel, stylesPanel.root, wildcardsPanel.root);
    view.append(header, tabs.root, panels);
    container.appendChild(view);

    // ── section switching ───────────────────────────────────────────────────
    function setTab(id) {
        state.tab = id;
        writePref("prompt_tab", id);
        tabs.setActive(id);
        libraryPanel.classList.toggle("nu-hidden", id !== "library");
        stylesPanel.root.classList.toggle("nu-hidden", id !== "styles");
        wildcardsPanel.root.classList.toggle("nu-hidden", id !== "wildcards");
    }

    // ── library data ────────────────────────────────────────────────────────
    async function loadPrompts() {
        try {
            const data = await api.listPrompts();
            state.prompts = Array.isArray(data) ? data : [];
        } catch (e) {
            state.prompts = [];
            if (!state.destroyed) showSnackbar({ label: t("errorWithMsg", e.message), timeout: 6000 });
        }
        if (state.destroyed) return;
        if (state.selectedId && !state.prompts.some((p) => p.id === state.selectedId)) {
            selectPrompt(null);
        }
        renderList();
    }

    function visiblePrompts() {
        const q = state.search.trim().toLowerCase();
        return state.prompts.filter((p) => {
            if (state.favoritesOnly && !p.favorite) return false;
            if (!q) return true;
            const haystack = [p.name, p.text, p.negText, p.category, ...(p.tags || [])]
                .filter(Boolean)
                .join(" ")
                .toLowerCase();
            return haystack.includes(q);
        });
    }

    function renderList() {
        list.replaceChildren();
        const items = visiblePrompts();
        if (items.length === 0) {
            list.appendChild(el("li", "nu-empty", state.prompts.length === 0 ? "No prompts yet." : "No matches."));
            return;
        }
        for (const prompt of items) {
            list.appendChild(promptRow(prompt));
        }
    }

    function promptRow(prompt) {
        const li = el("li");
        const row = el("div", "m3-list-item nu-prompt__row");
        if (prompt.id === state.selectedId) row.classList.add("m3-list-item--selected");

        const main = el("button", "nu-prompt__row-main");
        main.type = "button";
        main.setAttribute("aria-current", prompt.id === state.selectedId ? "true" : "false");
        const preview = String(prompt.text || "");
        main.append(
            el("span", "m3-list-item__headline", prompt.name || "(unnamed)"),
            el("span", "m3-list-item__supporting-text", preview.length > 64 ? `${preview.slice(0, 64)}…` : preview),
        );
        main.addEventListener("click", () => selectPrompt(prompt));

        const starBtn = createIconButton({
            icon: prompt.favorite ? "★" : "☆",
            ariaLabel: prompt.favorite ? `Unfavorite ${prompt.name}` : `Favorite ${prompt.name}`,
            title: t("favorite"),
            toggle: true,
            pressed: !!prompt.favorite,
            onClick: () => toggleFavorite(prompt),
        });
        const delBtn = createIconButton({
            icon: "✕",
            ariaLabel: `Delete ${prompt.name}`,
            title: t("delete"),
            onClick: () => {
                selectPrompt(prompt);
                deletePrompt();
            },
        });
        row.append(main, starBtn, delBtn);
        li.appendChild(row);
        return li;
    }

    function selectPrompt(prompt) {
        state.selectedId = prompt ? prompt.id : null;
        nameField.setValue(prompt ? prompt.name || "" : "");
        categoryField.setValue(prompt ? prompt.category || "" : "");
        posField.setValue(prompt ? prompt.text || "" : "");
        negField.setValue(prompt ? prompt.negText || "" : "");
        statusLabel.textContent = prompt ? `Editing: ${prompt.name}` : "New prompt (not saved yet)";
        deleteBtn.classList.toggle("nu-hidden", !prompt);
        renderList();
    }

    async function savePrompt() {
        const name = nameField.getValue().trim();
        const positive = posField.getValue();
        const negative = negField.getValue();
        if (!name) { showSnackbar({ label: t("enterPresetName"), timeout: 4000 }); return; }
        if (!positive.trim() && !negative.trim()) {
            showSnackbar({ label: t("noPromptToSave"), timeout: 4000 });
            return;
        }
        const body = {
            name,
            text: positive,
            negText: negative,
            category: categoryField.getValue().trim(),
        };
        try {
            if (state.selectedId) {
                await api.updatePrompt(state.selectedId, body);
            } else {
                const created = await api.createPrompt({ ...body, tags: [], favorite: false });
                const saved = created && created.prompt ? created.prompt : created;
                if (saved && saved.id) state.selectedId = saved.id;
            }
            showSnackbar({ label: t("presetSaved"), timeout: 3000 });
            await loadPrompts();
            if (state.selectedId) {
                const found = state.prompts.find((p) => p.id === state.selectedId);
                if (found) selectPrompt(found);
            }
        } catch (e) {
            showSnackbar({ label: t("errorWithMsg", e.message), timeout: 6000 });
        }
    }

    async function toggleFavorite(prompt) {
        try {
            const res = await api.updatePrompt(prompt.id, { favorite: !prompt.favorite });
            const updated = res && res.prompt ? res.prompt : null;
            const idx = state.prompts.findIndex((p) => p.id === prompt.id);
            if (updated && idx >= 0) state.prompts[idx] = updated;
            else if (idx >= 0) state.prompts[idx].favorite = !prompt.favorite;
            renderList();
        } catch (e) {
            showSnackbar({ label: t("errorWithMsg", e.message), timeout: 5000 });
        }
    }

    async function deletePrompt() {
        const prompt = state.prompts.find((p) => p.id === state.selectedId);
        if (!prompt) return;
        const ok = await confirm({
            title: t("delete"),
            content: `Delete "${prompt.name}"?`,
            confirmLabel: t("delete"),
            danger: true,
        });
        if (!ok) return;
        try {
            await api.deletePrompt(prompt.id);
            showSnackbar({ label: t("deletedName", prompt.name), timeout: 3000 });
            selectPrompt(null);
            await loadPrompts();
        } catch (e) {
            showSnackbar({ label: t("errorWithMsg", e.message), timeout: 6000 });
        }
    }

    async function copy(value) {
        if (!String(value || "").trim()) { showSnackbar({ label: t("noTextToCopy"), timeout: 3000 }); return; }
        try {
            await navigator.clipboard.writeText(value);
            showSnackbar({ label: t("copiedToClipboard"), timeout: 3000 });
        } catch (e) {
            showSnackbar({ label: t("errorWithMsg", e.message), timeout: 5000 });
        }
    }

    /** Push the edited text into the app store for the Generate view. */
    function sendToGenerate() {
        const positive = posField.getValue();
        const negative = negField.getValue();
        if (!positive.trim() && !negative.trim()) {
            showSnackbar({ label: t("noPromptToSave"), timeout: 4000 });
            return;
        }
        const store = ctx && ctx.store;
        if (!store || typeof store.setState !== "function") {
            showSnackbar({ label: "Store unavailable", timeout: 4000 });
            return;
        }
        store.setState({ prompt: positive, negativePrompt: negative, promptSource: "prompt" });
        showSnackbar({ label: t("appliedToGenerateUI"), timeout: 3000 });
        if (typeof ctx.navigate === "function") ctx.navigate("generate");
    }

    // ── lifecycle ───────────────────────────────────────────────────────────
    function destroy() {
        state.destroyed = true;
        wildcardsPanel.destroy();
        stylesPanel.destroy();
    }

    setTab(state.tab === "styles" || state.tab === "wildcards" ? state.tab : "library");
    selectPrompt(null);
    loadPrompts();
    initRipple(view);

    return { destroy, refresh: loadPrompts };
}

export default render;
