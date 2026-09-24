/**
 * components/Dialog.js — M3 dialog surface builder (content only).
 *
 * `../dialog.js` owns `.m3-dialog-host`, the scrim, the focus trap and Esc;
 * this module only builds the `.m3-dialog` element that the host mounts.
 *
 * Action semantics:
 *   - `variant` maps to `.m3-btn--filled | --tonal | --outlined | --text | --elevated`
 *     (default `text`, the M3 dialog default).
 *   - clicking an action calls `onClick()`; returning `false` keeps the dialog open.
 *   - unless the action carries `close: false`, the dialog is then closed through
 *     `closeDialog(action.value)`, so `await openDialog(createDialog(...))`
 *     resolves with the chosen action's `value` (undefined when omitted).
 *   - `danger` recolours the button through its component tokens (no new classes).
 *   - `dismissible: false` marks the surface with `data-dismissible="false"` so the
 *     host/CSS can drop the scrim/Esc affordance; the builder never dismisses itself.
 *   - `wide: true` widens the surface for large content (inline override, because the
 *     frozen class list has no `--wide` modifier).
 */

import { closeDialog } from "../dialog.js";
import { attachRipple } from "../ripple.js";

let seq = 0;

const VARIANTS = ["filled", "tonal", "outlined", "text", "elevated"];

/** Icon string -> span. Matches the frozen convention: markup if it looks like SVG. */
function iconSpan(icon, className) {
    const el = document.createElement("span");
    el.className = className;
    el.setAttribute("aria-hidden", "true");
    if (/<[a-z]/i.test(icon)) el.innerHTML = icon;
    else el.textContent = icon;
    return el;
}

/** Append a string / Node / (nested) array of either. Strings stay inert text. */
function appendValue(host, value) {
    if (value === null || value === undefined || value === false) return;
    if (Array.isArray(value)) {
        value.forEach((entry) => appendValue(host, entry));
        return;
    }
    if (value instanceof Node) {
        host.appendChild(value);
        return;
    }
    host.appendChild(document.createTextNode(String(value)));
}

/** `danger` recolours the button via the frozen `--md-comp-*-button-*` tokens. */
function applyDanger(btn, variant) {
    btn.style.setProperty("--md-comp-" + variant + "-button-label-color", "var(--md-sys-color-error)");
    if (variant === "filled" || variant === "tonal" || variant === "elevated") {
        btn.style.setProperty("--md-comp-" + variant + "-button-container-color", "var(--md-sys-color-error)");
        btn.style.setProperty("--md-comp-" + variant + "-button-label-color", "var(--md-sys-color-on-error)");
    }
}

export function createDialog({
    title,
    content,
    actions,
    dismissible = true,
    wide = false,
    onClose,
    titleId,
    ariaLabel,
} = {}) {
    const root = document.createElement("div");
    root.className = "m3-dialog";
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-modal", "true");
    if (dismissible === false) root.setAttribute("data-dismissible", "false");

    if (wide) {
        // No frozen `--wide` modifier exists; override the component token and the
        // property itself so the surface grows even if the CSS caps it in place.
        root.style.setProperty("--md-comp-dialog-max-width", "min(96vw, 1120px)");
        root.style.maxWidth = "min(96vw, 1120px)";
        root.style.width = "min(96vw, 1120px)";
    }

    if (title !== undefined && title !== null && title !== "") {
        const heading = document.createElement("h2");
        heading.className = "m3-dialog__title";
        heading.id = titleId || "nu-dialog-title-" + (seq += 1);
        appendValue(heading, title);
        root.setAttribute("aria-labelledby", heading.id);
        root.appendChild(heading);
    } else if (ariaLabel) {
        root.setAttribute("aria-label", ariaLabel);
    }

    if (content !== undefined && content !== null) {
        const body = document.createElement("div");
        body.className = "m3-dialog__content";
        appendValue(body, content);
        root.appendChild(body);
    }

    const list = Array.isArray(actions) ? actions : actions ? [actions] : [];
    if (list.length) {
        const bar = document.createElement("div");
        bar.className = "m3-dialog__actions";

        list.forEach((action) => {
            if (!action) return;
            const variant = VARIANTS.indexOf(action.variant) >= 0 ? action.variant : "text";
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "m3-btn m3-btn--" + variant;
            if (action.icon) btn.appendChild(iconSpan(action.icon, "m3-btn__icon"));

            const label = document.createElement("span");
            label.className = "m3-btn__label";
            label.textContent = action.label === undefined || action.label === null ? "" : String(action.label);
            btn.appendChild(label);

            if (action.danger) applyDanger(btn, variant);
            if (action.disabled) btn.disabled = true;
            if (action.ariaLabel) btn.setAttribute("aria-label", action.ariaLabel);

            btn.addEventListener("click", () => {
                if (typeof action.onClick === "function" && action.onClick() === false) return;
                if (action.close === false) return;
                if (typeof onClose === "function") onClose(action);
                closeDialog(action.value);
            });

            if (!btn.disabled) attachRipple(btn);
            bar.appendChild(btn);
        });

        root.appendChild(bar);
    }

    return root;
}
