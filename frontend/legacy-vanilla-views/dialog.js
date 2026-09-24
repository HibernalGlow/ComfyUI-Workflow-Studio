/**
 * dialog.js — owner of the single `.m3-dialog-host`.
 *
 * openDialog() accepts either a ready-made `.m3-dialog` element (e.g. built by
 * components/Dialog.js) or a plain options object; building the node here keeps
 * the host self-sufficient (no cross-file dependency, no document lookups
 * besides adopting the host the shell may already have rendered).
 */
import { focusTrap, restoreFocus } from "./a11y.js";
import { createButton } from "./components/Button.js";
import { createTextField } from "./components/TextField.js";
import { t } from "../core/index.js";

let host = null;
let seq = 0;
const stack = [];

function ensureHost() {
    if (host && host.isConnected) return host;
    // The shell may ship an empty host; adopt it so there is never a second layer.
    host = document.querySelector(".m3-dialog-host") || document.createElement("div");
    host.classList.add("m3-dialog-host");
    if (!host.isConnected) document.body.append(host);
    host.style.pointerEvents = "none"; // scrim + dialog opt back in
    return host;
}

function nextId(prefix) {
    seq += 1;
    return `${prefix}-${seq}`;
}

function appendContent(parent, content) {
    if (content == null) return;
    if (Array.isArray(content)) {
        for (const item of content) appendContent(parent, item);
    } else if (content instanceof Node) {
        parent.append(content);
    } else {
        parent.append(document.createTextNode(String(content)));
    }
}

function firstFocusable(node) {
    return node.querySelector("input:not([disabled]),select:not([disabled]),textarea:not([disabled]),button:not([disabled]),[tabindex]:not([tabindex='-1'])");
}

/** Name the dialog for screen readers; falls back to a generic label. */
function labelDialog(node) {
    const title = node.querySelector(".m3-dialog__title");
    if (title) {
        if (!title.id) title.id = nextId("nu-dialog-title");
        node.setAttribute("aria-labelledby", title.id);
    } else {
        node.setAttribute("aria-label", t("newui.dialog.label", "Dialog"));
    }
}

function buildDialogNode({ title, content, actions, wide }, resolveWith) {
    const node = document.createElement("div");
    node.className = "m3-dialog";
    if (wide) {
        // No frozen modifier for the wide variant: fill the host and let the CSS
        // max-width keep the outer bound.
        node.style.width = "100%";
        node.style.maxWidth = "min(1000px, 92vw)";
    }
    if (title) {
        const heading = document.createElement("h2");
        heading.className = "m3-dialog__title";
        heading.id = nextId("nu-dialog-title");
        heading.textContent = title;
        node.append(heading);
        node.setAttribute("aria-labelledby", heading.id);
    }
    const body = document.createElement("div");
    body.className = "m3-dialog__content";
    appendContent(body, content);
    node.append(body);

    const bar = document.createElement("div");
    bar.className = "m3-dialog__actions";
    for (const action of actions || []) {
        const button = createButton({
            label: action.label,
            variant: action.variant || "text",
            disabled: action.disabled,
            onClick: (event) => {
                if (typeof action.onClick === "function") action.onClick(event);
                if (action.close === false) return;
                const value = typeof action.value === "function"
                    ? action.value()
                    : ("value" in action ? action.value : true);
                resolveWith(value);
            },
        });
        if (action.danger) button.dataset.danger = "true";
        // Hint for keyboard shortcuts living inside the dialog content.
        if (action.close !== false) button.dataset.dialogClose = action.value === false ? "false" : "true";
        bar.append(button);
    }
    node.append(bar);
    return node;
}

function close(entry, result) {
    if (!entry || entry.closed) return;
    entry.closed = true;
    const index = stack.indexOf(entry);
    if (index !== -1) stack.splice(index, 1);
    if (entry.trap) entry.trap.deactivate(); // reclaims focus when it was inside
    entry.node.remove();
    entry.scrim.remove();
    restoreFocus(entry.previous);
    try {
        if (entry.onClose) entry.onClose(result);
    } finally {
        // Never leave a caller awaiting a promise that can no longer settle.
        entry.resolve(result);
    }
}

/**
 * @param {HTMLElement|{title?,content?,actions?,wide?,dismissible?}} contentOrOptions
 * @returns {Promise<*>} resolved with the value the closing path supplied
 */
export function openDialog(contentOrOptions, options = {}) {
    const passedNode = contentOrOptions instanceof Node ? contentOrOptions : null;
    const spec = passedNode ? {} : (contentOrOptions || {});
    const opts = { trapFocus: true, dismissible: true, ...spec, ...options };

    let entry = null;
    const resolveWith = (result) => close(entry, result);

    let node = passedNode;
    if (node && !(node instanceof Element && node.classList.contains("m3-dialog"))) {
        const wrapper = document.createElement("div");
        wrapper.className = "m3-dialog";
        appendContent(wrapper, node);
        node = wrapper;
    }
    if (!node) node = buildDialogNode(spec, resolveWith);
    node.setAttribute("role", "dialog");
    node.setAttribute("aria-modal", "true");
    node.style.pointerEvents = "auto";
    labelDialog(node);

    return new Promise((resolve) => {
        const scrim = document.createElement("div");
        scrim.className = "m3-dialog-scrim";
        scrim.style.pointerEvents = "auto";

        entry = {
            node,
            scrim,
            resolve,
            trap: null,
            closed: false,
            dismissible: opts.dismissible !== false,
            onClose: typeof opts.onClose === "function" ? opts.onClose : null,
            previous: document.activeElement,
        };
        const dismiss = () => { if (entry.dismissible) close(entry, undefined); };
        scrim.addEventListener("click", dismiss);

        // Externally built dialogs may mark their buttons instead of using actions.
        node.addEventListener("click", (event) => {
            const trigger = event.target instanceof Element ? event.target.closest("[data-dialog-close]") : null;
            if (!trigger || !node.contains(trigger)) return;
            const raw = trigger.getAttribute("data-dialog-close");
            close(entry, raw === "" || raw === "true" ? true : raw === "false" ? false : raw);
        });
        if (opts.trapFocus !== false) {
            entry.trap = focusTrap(node, {
                onEscape: dismiss,
                initialFocus: opts.initialFocus || firstFocusable(node),
            });
        } else {
            node.addEventListener("keydown", (event) => { if (event.key === "Escape") dismiss(); });
            node.setAttribute("tabindex", "-1");
        }

        ensureHost().append(scrim, node);
        stack.push(entry);
        if (entry.trap) entry.trap.activate();
        else (opts.initialFocus || firstFocusable(node) || node).focus({ preventScroll: true });
    });
}

/** Close the topmost dialog, resolving its promise with `result`. */
export function closeDialog(result) {
    close(stack[stack.length - 1], result);
}

export async function confirm({ title, content, confirmLabel, cancelLabel, danger } = {}) {
    const result = await openDialog({
        title,
        content,
        actions: [
            { label: cancelLabel || t("newui.common.cancel", "Cancel"), variant: "text", value: false },
            { label: confirmLabel || t("newui.common.confirm", "Confirm"), variant: "filled", value: true, danger },
        ],
    });
    return result === true;
}

export async function alert({ title, content, okLabel } = {}) {
    await openDialog({
        title,
        content,
        actions: [{ label: okLabel || t("newui.common.ok", "OK"), variant: "filled", value: true }],
    });
}

export async function prompt({ title, label, value = "", placeholder, confirmLabel, cancelLabel } = {}) {
    const field = createTextField({ label, value, placeholder });
    // openDialog mounts synchronously, so the node is reachable right away.
    const done = openDialog({
        title,
        content: field.root,
        actions: [
            { label: cancelLabel || t("newui.common.cancel", "Cancel"), variant: "text", value: null },
            { label: confirmLabel || t("newui.common.ok", "OK"), variant: "filled", value: () => field.getValue() },
        ],
    }, { initialFocus: field.input });
    const dialog = field.root.closest(".m3-dialog");
    field.input.addEventListener("keydown", (event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        const submit = dialog.querySelector("[data-dialog-close='true']");
        if (submit) submit.click();
    });
    const result = await done;
    return typeof result === "string" ? result : null;
}
