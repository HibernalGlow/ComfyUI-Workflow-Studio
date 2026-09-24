/**
 * views/prompt/wildcards.js — wildcard panel of the Prompt workbench.
 *
 * Owns: the wildcard file list (grouped by directory), the file editor dialog,
 * the Impact-Pack link status controls and the live `__name__` expansion preview.
 * All network traffic goes through `api.*`; expansion goes through core's
 * `wildcard` namespace (falling back to `api.expandWildcards`, which implements the
 * same semantics) so the SPA rule set lives in exactly one place.
 *
 * Delta vs upstream prompt-wildcards.js: the "insert at cursor" helpers exist for
 * the panel's own composer/textarea instead of a fixed DOM id, and the file editor
 * is a real dialog instead of an inline pane. Nothing else changed.
 */

import { api, t, wildcard as wildcardCore } from "../../../core/index.js";
import { createButton } from "../../components/Button.js";
import { createIconButton } from "../../components/IconButton.js";
import { createTextField } from "../../components/TextField.js";
import { createSelect } from "../../components/Select.js";
import { openDialog, closeDialog, confirm } from "../../dialog.js";
import { showSnackbar } from "../../snackbar.js";

/** Backend accepts only these (wildcard_service.ALLOWED_EXTS). */
const ALLOWED_EXTS = ["txt", "yaml", "yml"];

const SYNTAX_BUTTONS = [
    { open: "{", close: "}", label: "{ }", title: "Random pick set  e.g. {cat|dog}" },
    { open: "|", close: "", label: "|", title: "Separator" },
    { open: "__", close: "__", label: "__", title: "Wildcard file reference  e.g. __animals__" },
    { open: ":", close: "", label: ":", title: "Colon" },
    { open: ";", close: "", label: ";", title: "Semicolon" },
    { open: "$$", close: "", label: "$$", title: "Multi-pick  e.g. {2$$cat|dog|bird}" },
    { open: "[", close: "]", label: "[ ]", title: "Bracket set  e.g. [cat|dog]" },
];

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
}

/** Wrap the selection (or insert a pair) into the given textarea. */
function insertAtCursor(ta, open, close = "") {
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const selected = ta.value.substring(start, end);
    let inserted = open;
    let cursorStart = start + open.length;
    let cursorEnd = cursorStart;
    if (selected && close) {
        inserted = open + selected + close;
        cursorEnd = cursorStart + selected.length;
    } else if (close) {
        inserted = open + close;
    }
    ta.value = ta.value.substring(0, start) + inserted + ta.value.substring(end);
    ta.setSelectionRange(cursorStart, cursorEnd);
    ta.focus();
    ta.dispatchEvent(new Event("input", { bubbles: true }));
}

/**
 * @param {{store?:object}} ctx view context
 * @returns {{root:HTMLElement, refresh:()=>Promise<void>, destroy:()=>void}}
 */
export function createWildcardsPanel(ctx) {
    const root = el("div", "nu-prompt__panel nu-prompt__wc");
    root.style.cssText = "display:flex;flex-direction:column;gap:12px";

    let files = [];
    let destroyed = false;
    let previewToken = 0;
    let previewTimer = null;

    // ── toolbar ─────────────────────────────────────────────────────────────
    const toolbar = el("div", "nu-view__toolbar");
    const linkBadge = el("span", "nu-badge nu-prompt__link-badge", "…");
    const refreshBtn = createIconButton({
        icon: "⟳",
        ariaLabel: t("refresh"),
        title: t("refresh"),
        onClick: () => refresh(),
    });
    const newBtn = createButton({
        label: "New wildcard",
        variant: "tonal",
        onClick: () => openFileEditor(null),
    });
    const createLinkBtn = createButton({
        label: "Create link",
        variant: "outlined",
        disabled: true,
        onClick: () => toggleLink(true),
    });
    const removeLinkBtn = createButton({
        label: "Remove link",
        variant: "text",
        disabled: true,
        onClick: () => toggleLink(false),
    });
    toolbar.append(refreshBtn, newBtn, el("span", "nu-spacer"), linkBadge, createLinkBtn, removeLinkBtn);

    // ── file list ───────────────────────────────────────────────────────────
    const list = el("ul", "m3-list nu-prompt__wc-list");
    list.setAttribute("aria-label", "Wildcard files");
    list.style.cssText = "max-height:34vh;overflow:auto;margin:0;padding:0";

    // ── composer + live preview ─────────────────────────────────────────────
    const composer = createTextField({
        label: "Wildcard prompt",
        multiline: true,
        rows: 5,
        placeholder: "A photo of __subject__ in __place__, {day|night}",
        onInput: () => schedulePreview(),
    });

    const syntaxRow = el("div", "nu-row nu-prompt__syntax");
    for (const spec of SYNTAX_BUTTONS) {
        const btn = createButton({
            label: spec.label,
            variant: "text",
            title: spec.title,
            onClick: () => insertAtCursor(composer.input, spec.open, spec.close),
        });
        syntaxRow.appendChild(btn);
    }

    const preview = el("pre", "m3-card nu-prompt__preview", "—");
    preview.setAttribute("aria-live", "polite");
    preview.style.cssText =
        "white-space:pre-wrap;word-break:break-word;margin:0;padding:12px;" +
        "min-height:64px;max-height:22vh;overflow:auto";
    const previewActions = el("div", "nu-row");
    const copyBtn = createButton({
        label: t("copy"),
        variant: "text",
        onClick: () => copyText(preview.textContent || ""),
    });
    const toPositiveBtn = createButton({
        label: "Send to positive",
        variant: "text",
        onClick: () => {
            const value = preview.textContent || "";
            if (!value.trim()) { showSnackbar({ label: t("noTextToCopy"), timeout: 3000 }); return; }
            sendToGenerate(value, "");
        },
    });
    const clearBtn = createButton({
        label: t("clear"),
        variant: "text",
        onClick: () => { composer.setValue(""); schedulePreview(); },
    });
    previewActions.append(copyBtn, toPositiveBtn, clearBtn);

    root.append(toolbar, list, composer.root, syntaxRow, preview, previewActions);

    // ── preview ─────────────────────────────────────────────────────────────
    function schedulePreview() {
        clearTimeout(previewTimer);
        previewTimer = setTimeout(runPreview, 350);
    }

    async function runPreview() {
        const text = composer.getValue();
        if (!text.trim()) { preview.textContent = "—"; return; }
        const token = ++previewToken;
        preview.textContent = t("loading");
        try {
            const out = typeof wildcardCore.expandWildcardText === "function"
                ? await wildcardCore.expandWildcardText(text)
                : await api.expandWildcards(text);
            if (token !== previewToken || destroyed) return;
            preview.textContent = out;
        } catch (e) {
            if (token !== previewToken || destroyed) return;
            preview.textContent = t("errorWithMsg", e.message);
        }
    }

    // ── data ────────────────────────────────────────────────────────────────
    function invalidateExpansion() {
        // core/wildcard.js caches negative lookups; a save/delete must drop them.
        if (typeof wildcardCore.clearWildcardCache === "function") wildcardCore.clearWildcardCache();
        schedulePreview();
    }

    async function refreshFiles() {
        try {
            const data = await api.getWildcards();
            files = Array.isArray(data) ? data : [];
        } catch (e) {
            files = [];
            if (!destroyed) showSnackbar({ label: t("errorWithMsg", e.message), timeout: 5000 });
        }
        if (!destroyed) renderFiles();
    }

    async function refreshLinkStatus() {
        try {
            const status = await api.getWildcardLinkStatus();
            const linked = !!status.is_linked;
            linkBadge.textContent = linked
                ? `Impact Pack: linked (${status.link_target || ""})`
                : status.impact_pack_installed
                    ? "Impact Pack: not linked"
                    : "Impact Pack: not installed";
            createLinkBtn.disabled = linked || !status.impact_pack_installed;
            removeLinkBtn.disabled = !linked;
        } catch (e) {
            linkBadge.textContent = "Impact Pack: unknown";
            createLinkBtn.disabled = true;
            removeLinkBtn.disabled = true;
        }
    }

    async function toggleLink(create) {
        try {
            if (create) {
                const res = await api.createWildcardLink();
                const migrated = Array.isArray(res && res.migrated_files) ? res.migrated_files.length : 0;
                showSnackbar({ label: `Link created (${migrated} file(s) migrated)`, timeout: 5000 });
            } else {
                await api.removeWildcardLink();
                showSnackbar({ label: "Link removed", timeout: 4000 });
            }
        } catch (e) {
            showSnackbar({ label: t("errorWithMsg", e.message), timeout: 6000 });
        }
        await refreshLinkStatus();
        await refreshFiles();
        invalidateExpansion();
    }

    function renderFiles() {
        list.replaceChildren();
        if (files.length === 0) {
            const empty = el("li", "nu-empty", "No wildcard files yet.");
            list.appendChild(empty);
            return;
        }
        const grouped = new Map();
        for (const file of files) {
            const dir = file.dir || "";
            if (!grouped.has(dir)) grouped.set(dir, []);
            grouped.get(dir).push(file);
        }
        const dirs = [...grouped.keys()].sort((a, b) => {
            if (a === "") return -1;
            if (b === "") return 1;
            return a.localeCompare(b);
        });
        for (const dir of dirs) {
            if (dir) {
                const header = el("li", "nu-prompt__wc-dir", `${dir}/`);
                list.appendChild(header);
            }
            for (const file of grouped.get(dir)) {
                list.appendChild(fileRow(file, dir !== ""));
            }
        }
    }

    function fileRow(file, indented) {
        const li = el("li");
        const row = el("div", "m3-list-item nu-prompt__row");
        if (indented) row.style.paddingInlineStart = "28px";

        const main = el("button", "nu-prompt__row-main");
        main.type = "button";
        main.title = `Insert __${file.wc_name}__ at the cursor`;
        main.append(
            el("span", "m3-list-item__headline", file.name),
            el("span", "m3-list-item__supporting-text", `.${file.ext}${file.dir ? ` · ${file.dir}/` : ""}`),
        );
        main.addEventListener("click", () => insertAtCursor(composer.input, `__${file.wc_name}__`));

        const editBtn = createIconButton({
            icon: "✎",
            ariaLabel: `Edit ${file.filename}`,
            title: "Edit file",
            onClick: () => openFileEditor(file),
        });
        row.append(main, editBtn);
        li.appendChild(row);
        return li;
    }

    // ── file editor dialog ──────────────────────────────────────────────────
    async function openFileEditor(file) {
        const isNew = !file;
        let content = "";
        if (file) {
            try {
                content = (await api.getWildcardContent(file.filename)) || "";
            } catch (e) {
                showSnackbar({ label: t("errorWithMsg", e.message), timeout: 5000 });
                return;
            }
        }
        if (destroyed) return;

        const nameField = createTextField({
            label: "Name",
            value: file ? file.wc_name || file.name : "",
            placeholder: "folder/name",
        });
        const extSelect = createSelect({
            label: "Type",
            options: ALLOWED_EXTS.map((ext) => ({ value: ext, label: `.${ext}` })),
            value: file ? file.ext : "txt",
        });
        const contentField = createTextField({
            label: "Content",
            multiline: true,
            rows: 12,
            value: content,
            placeholder: "one entry per line, # starts a comment",
        });
        const hint = el("p", "nu-muted", "One entry per line. Lines starting with # are ignored.");
        const box = el("div", "nu-stack");
        box.style.cssText = "display:flex;flex-direction:column;gap:12px;min-width:min(520px,80vw)";
        box.append(nameField.root, extSelect.root, contentField.root, hint);

        const actions = [
            {
                label: isNew ? "Create" : t("save"),
                variant: "filled",
                close: false,
                onClick: async () => {
                    const raw = nameField.getValue().trim().replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/|\/$/g, "");
                    const ext = extSelect.getValue() || "txt";
                    if (!raw) { showSnackbar({ label: t("pleaseEnterFilename"), timeout: 4000 }); return; }
                    if (raw.split("/").some((part) => !/^[\w\-. ]+$/.test(part))) {
                        showSnackbar({ label: t("invalidPathFormat"), timeout: 6000 });
                        return;
                    }
                    const filename = `${raw}.${ext}`;
                    try {
                        await api.saveWildcard(filename, contentField.getValue());
                        showSnackbar({ label: t("savedAs", filename), timeout: 3500 });
                        invalidateExpansion();
                        await refreshFiles();
                        closeDialog("saved");
                    } catch (e) {
                        showSnackbar({ label: t("errorWithMsg", e.message), timeout: 6000 });
                    }
                },
            },
        ];
        if (!isNew) {
            actions.push({
                label: t("delete"),
                variant: "outlined",
                danger: true,
                close: false,
                onClick: async () => {
                    const ok = await confirm({
                        title: t("delete"),
                        content: `Delete "${file.filename}"?`,
                        confirmLabel: t("delete"),
                        danger: true,
                    });
                    if (!ok) return;
                    try {
                        await api.deleteWildcard(file.filename);
                        showSnackbar({ label: t("deletedName", file.filename), timeout: 3500 });
                        invalidateExpansion();
                        await refreshFiles();
                        closeDialog("deleted");
                    } catch (e) {
                        showSnackbar({ label: t("errorWithMsg", e.message), timeout: 6000 });
                    }
                },
            });
        }
        actions.push({ label: t("cancel"), variant: "text" });

        await openDialog({
            title: isNew ? "New wildcard" : `Edit ${file.filename}`,
            content: box,
            actions,
            wide: true,
        });
    }

    // ── misc ────────────────────────────────────────────────────────────────
    async function copyText(value) {
        if (!value.trim()) { showSnackbar({ label: t("noTextToCopy"), timeout: 3000 }); return; }
        try {
            await navigator.clipboard.writeText(value);
            showSnackbar({ label: t("copiedToClipboard"), timeout: 3000 });
        } catch (e) {
            showSnackbar({ label: t("errorWithMsg", e.message), timeout: 5000 });
        }
    }

    /** Hand the expanded text to the Generate view through the app store. */
    function sendToGenerate(positive, negative) {
        const store = ctx && ctx.store;
        if (!store || typeof store.setState !== "function") {
            showSnackbar({ label: "Store unavailable", timeout: 4000 });
            return;
        }
        store.setState({ prompt: positive, negativePrompt: negative, promptSource: "prompt" });
        showSnackbar({ label: t("appliedToGenerateUI"), timeout: 3500 });
        if (ctx.navigate) ctx.navigate("generate");
    }

    async function refresh() {
        await Promise.all([refreshFiles(), refreshLinkStatus()]);
    }

    function destroy() {
        destroyed = true;
        clearTimeout(previewTimer);
        previewToken++;
    }

    refresh();

    return { root, refresh, destroy };
}
