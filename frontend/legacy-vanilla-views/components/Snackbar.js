/**
 * components/Snackbar.js — M3 snackbar surface builder (content only).
 *
 * `../snackbar.js` owns `.m3-snackbar-host`, the queue and the timeout; this
 * module only builds the `.m3-snackbar` element that the host mounts.
 *
 * Dismissal contract: the action button calls `onAction()` and the close button
 * signals dismissal by dispatching a bubbling, cancelable `nu-snackbar-dismiss`
 * event on the surface. A host that wants to own removal can
 * `event.preventDefault()`; otherwise the surface removes itself so a standalone
 * use (and a host that never wires the event) still behaves correctly.
 */

import { attachRipple } from "../ripple.js";

const DISMISS_EVENT = "nu-snackbar-dismiss";

export function createSnackbar({ label, actionLabel, onAction, closeable } = {}) {
    const root = document.createElement("div");
    root.className = "m3-snackbar";
    root.setAttribute("role", "status");

    const text = document.createElement("span");
    text.className = "m3-snackbar__label";
    text.textContent = label === undefined || label === null ? "" : String(label);
    root.appendChild(text);

    function requestDismiss() {
        const event = new CustomEvent(DISMISS_EVENT, { bubbles: true, cancelable: true });
        if (root.dispatchEvent(event)) root.remove();
    }

    if (actionLabel) {
        const action = document.createElement("button");
        action.type = "button";
        action.className = "m3-snackbar__action";
        action.textContent = String(actionLabel);
        action.addEventListener("click", () => {
            if (typeof onAction === "function") onAction();
            requestDismiss();
        });
        attachRipple(action);
        root.appendChild(action);
    }

    if (closeable) {
        // `.m3-icon-btn` is the frozen icon-button pair; no snackbar-specific
        // close class exists in the freeze.
        const close = document.createElement("button");
        close.type = "button";
        close.className = "m3-icon-btn m3-icon-btn--standard";
        close.setAttribute("aria-label", "Dismiss");
        close.textContent = "\u2715";
        close.addEventListener("click", requestDismiss);
        attachRipple(close);
        root.appendChild(close);
    }

    return root;
}
