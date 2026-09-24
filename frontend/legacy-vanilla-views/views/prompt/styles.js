/**
 * views/prompt/styles.js — style catalog panel of the Prompt workbench.
 *
 * Browse / create / update / delete entries of the backend style catalog
 * (`api.listStyles|createStyle|updateStyle|deleteStyle`) and *apply* a style to the
 * prompt text currently held by the library editor. The application itself is
 * delegated to core's `style` namespace (brief §6 item 5); this module only picks
 * the style, shows the produced text and hands it back to the editor.
 */

import { api, t, style as styleCore } from "../../../core/index.js";
import { createButton } from "../../components/Button.js";
import { createIconButton } from "../../components/IconButton.js";
import { createTextField } from "../../components/TextField.js";
import { confirm } from "../../dialog.js";
import { showSnackbar } from "../../snackbar.js";
function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
}

/**
 * Compose `style.prompt` onto `text` — the text-level half of upstream
 * `_applyNamedStyle` (generate-tab.js L1356): a `{prompt}` placeholder is replaced
 * by the original text, otherwise the two are comma-joined. core/style.js owns this
 * rule; the local copy is only a fallback for the text (non-workflow) case.
 */
async function applyStyleToText(text, style, kind) {
    const fn = styleCore && (styleCore.applyStyleToText || styleCore.applyStyleToPrompt);
    if (typeof fn === "function") {
        try {
            const out = await fn({ text, prompt: text, style, kind });
            const value = typeof out === "string" ? out : out && (out.text ?? out.prompt);
            if (typeof value === "string") return value;
        } catch {
            /* no text-level helper in core — fall through to the upstream rule */
        }
    }
    const piece = String((kind === "negative" ? style.negative_prompt : style.prompt) || "");
    if (!piece) return text;
    if (kind === "negative") return text ? `${text}, ${piece}` : piece;
    return piece.includes("{prompt}") ? piece.replace("{prompt}", text) : (text ? `${text}, ${piece}` : piece);
}

/**
 * @param {{getPositive:()=>string, assign:(kind:"positive"|"negative", text:string)=>void}} host
 *        accessors into the library editor this panel applies styles to
 * @returns {{root:HTMLElement, refresh:()=>Promise<void>, destroy:()=>void}}
 */
export function createStylesPanel(host) {
    const root = el("div", "nu-prompt__panel nu-prompt__styles");
    root.style.cssText = "display:flex;flex-direction:column;gap:12px";

    let styles = [];
    let selected = null;      // style object being edited (null = new)
    let targetFile = null;    // create into this catalog file (upstream "add to file")
    let search = "";
    let destroyed = false;

    // ── toolbar ─────────────────────────────────────────────────────────────
    const toolbar = el("div", "nu-view__toolbar");
    const refreshBtn = createIconButton({
        icon: "⟳",
        ariaLabel: t("refresh"),
        title: t("refresh"),
        onClick: () => refresh(),
    });
    const searchField = createTextField({
        label: "Search styles",
        placeholder: t("searchPlaceholder"),
        onInput: (value) => {
            search = String(value || "");
            renderList();
        },
    });
    searchField.root.style.flex = "1 1 180px";
    const newBtn = createButton({
        label: "New style",
        variant: "tonal",
        onClick: () => openEditor(null, null),
    });
    toolbar.append(searchField.root, refreshBtn, newBtn);

    // ── list ────────────────────────────────────────────────────────────────
    const list = el("ul", "m3-list nu-prompt__style-list");
    list.setAttribute("aria-label", "Style catalog");
    list.style.cssText = "max-height:32vh;overflow:auto;margin:0;padding:0";

    // ── editor ──────────────────────────────────────────────────────────────
    const editor = el("div", "nu-stack nu-prompt__style-editor");
    editor.style.cssText = "display:flex;flex-direction:column;gap:10px";

    const nameField = createTextField({ label: "Style name" });
    const promptField = createTextField({ label: t("positivePrompt"), multiline: true, rows: 4 });
    const negativeField = createTextField({ label: t("negativePrompt"), multiline: true, rows: 3 });
    const fileLabel = el("p", "nu-muted", "");

    const actions = el("div", "nu-row");
    const saveBtn = createButton({ label: t("save"), variant: "filled", onClick: () => save() });
    const applyBtn = createButton({ label: "Apply to prompt", variant: "tonal", onClick: () => applyToPrompt() });
    const dupBtn = createButton({ label: "Duplicate into file", variant: "text", onClick: () => duplicateIntoFile() });
    const deleteBtn = createButton({ label: t("delete"), variant: "outlined", onClick: () => remove() });
    const cancelBtn = createButton({ label: t("cancel"), variant: "text", onClick: () => openEditor(null, null) });
    actions.append(saveBtn, applyBtn, dupBtn, deleteBtn, cancelBtn);

    // ── application result ──────────────────────────────────────────────────
    const resultBox = el("div", "nu-stack");
    resultBox.style.cssText = "display:flex;flex-direction:column;gap:8px";
    const resultLabel = el("p", "nu-field__label", "Applied result");
    const resultPre = el("pre", "m3-card nu-prompt__result", "—");
    resultPre.setAttribute("aria-live", "polite");
    resultPre.style.cssText =
        "white-space:pre-wrap;word-break:break-word;margin:0;padding:12px;" +
        "min-height:56px;max-height:20vh;overflow:auto";
    const resultActions = el("div", "nu-row");
    const usePosBtn = createButton({
        label: "Use as positive",
        variant: "text",
        onClick: () => host.assign("positive", resultPre.textContent || ""),
    });
    const useNegBtn = createButton({
        label: "Use as negative",
        variant: "text",
        onClick: () => host.assign("negative", resultPre.textContent || ""),
    });
    const copyBtn = createButton({ label: t("copy"), variant: "text", onClick: () => copyResult() });
    resultActions.append(usePosBtn, useNegBtn, copyBtn);
    resultBox.append(resultLabel, resultPre, resultActions);

    editor.append(nameField.root, promptField.root, negativeField.root, fileLabel, actions);
    root.append(toolbar, list, editor, resultBox);

    // ── data ────────────────────────────────────────────────────────────────
    async function refresh() {
        try {
            const data = await api.listStyles();
            styles = Array.isArray(data) ? data : [];
        } catch (e) {
            styles = [];
            if (!destroyed) showSnackbar({ label: t("errorWithMsg", e.message), timeout: 5000 });
        }
        if (destroyed) return;
        renderList();
    }

    function visibleStyles() {
        const q = search.trim().toLowerCase();
        return q ? styles.filter((s) => String(s.name || "").toLowerCase().includes(q)) : styles;
    }

    function renderList() {
        list.replaceChildren();
        const items = visibleStyles();
        if (items.length === 0) {
            list.appendChild(el("li", "nu-empty", styles.length === 0 ? "No styles yet." : "No matching styles."));
            return;
        }
        for (const item of items) {
            const li = el("li");
            const row = el("div", "m3-list-item nu-prompt__row");
            if (selected && selected.name === item.name) row.classList.add("m3-list-item--selected");

            const main = el("button", "nu-prompt__row-main");
            main.type = "button";
            main.setAttribute("aria-current", selected && selected.name === item.name ? "true" : "false");
            main.append(
                el("span", "m3-list-item__headline", item.name),
                el("span", "m3-list-item__supporting-text", item.file ? `File: ${item.file}` : ""),
            );
            main.addEventListener("click", () => openEditor(item, item.file || null));

            const editBtn = createIconButton({
                icon: "✎",
                ariaLabel: `Edit style ${item.name}`,
                title: "Edit style",
                onClick: () => openEditor(item, item.file || null),
            });
            row.append(main, editBtn);
            li.appendChild(row);
            list.appendChild(li);
        }
    }

    function openEditor(item, file) {
        selected = item || null;
        targetFile = item ? file : null;
        nameField.setValue(item ? item.name || "" : "");
        promptField.setValue(item ? item.prompt || "" : "");
        negativeField.setValue(item ? item.negative_prompt || "" : "");
        const fileText = item
            ? `File: ${item.file || "(custom)"}`
            : targetFile ? `Adding to file: ${targetFile}` : "";
        fileLabel.textContent = fileText;
        fileLabel.classList.toggle("nu-hidden", !fileText);
        deleteBtn.classList.toggle("nu-hidden", !item);
        dupBtn.classList.toggle("nu-hidden", !item);
        applyBtn.disabled = !item;
        nameField.input.focus();
        renderList();
    }

    async function save() {
        const name = nameField.getValue().trim();
        if (!name) { showSnackbar({ label: t("pleaseEnterStyleName"), timeout: 4000 }); return; }
        const body = {
            name,
            prompt: promptField.getValue(),
            negative_prompt: negativeField.getValue(),
        };
        try {
            if (selected) {
                await api.updateStyle(selected.name, body);
            } else {
                if (targetFile) body.file = targetFile;
                await api.createStyle(body);
            }
            showSnackbar({ label: t("savedAs", name), timeout: 3500 });
            await refresh();
            const saved = styles.find((s) => s.name === name) || null;
            openEditor(saved, saved ? saved.file || null : null);
        } catch (e) {
            showSnackbar({ label: t("errorWithMsg", e.message), timeout: 6000 });
        }
    }

    async function remove() {
        if (!selected) return;
        const ok = await confirm({
            title: t("delete"),
            content: `Delete "${selected.name}"?`,
            confirmLabel: t("delete"),
            danger: true,
        });
        if (!ok) return;
        try {
            await api.deleteStyle(selected.name);
            showSnackbar({ label: t("deletedName", selected.name), timeout: 3500 });
            openEditor(null, null);
            await refresh();
        } catch (e) {
            showSnackbar({ label: t("errorWithMsg", e.message), timeout: 6000 });
        }
    }

    function duplicateIntoFile() {
        if (!selected) return;
        const file = selected.file || null;
        selected = null;
        targetFile = file;
        nameField.setValue("");
        promptField.setValue("");
        negativeField.setValue("");
        fileLabel.textContent = file ? `Adding to file: ${file}` : "";
        fileLabel.classList.toggle("nu-hidden", !file);
        deleteBtn.classList.add("nu-hidden");
        dupBtn.classList.add("nu-hidden");
        applyBtn.disabled = true;
        nameField.input.focus();
        renderList();
    }

    /** Show what the style does to the editor's current positive prompt. */
    async function applyToPrompt() {
        if (!selected) return;
        const source = String(host.getPositive() || "");
        try {
            const positive = await applyStyleToText(source, selected, "positive");
            const negative = selected.negative_prompt
                ? await applyStyleToText("", selected, "negative")
                : "";
            resultPre.textContent = negative ? `${positive}\n\n${t("negativePrompt")}: ${negative}` : positive;
            if (positive === source && !negative) {
                showSnackbar({ label: "This style has no prompt text", timeout: 4000 });
            }
        } catch (e) {
            resultPre.textContent = t("errorWithMsg", e.message);
        }
    }

    async function copyResult() {
        const value = resultPre.textContent || "";
        if (!value.trim() || value === "—") { showSnackbar({ label: t("noTextToCopy"), timeout: 3000 }); return; }
        try {
            await navigator.clipboard.writeText(value);
            showSnackbar({ label: t("copiedToClipboard"), timeout: 3000 });
        } catch (e) {
            showSnackbar({ label: t("errorWithMsg", e.message), timeout: 5000 });
        }
    }

    function destroy() {
        destroyed = true;
        styles = [];
        selected = null;
    }

    openEditor(null, null);
    refresh();

    return { root, refresh, destroy };
}
