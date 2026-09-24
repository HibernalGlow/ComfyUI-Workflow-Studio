/**
 * snackbar.js — owner of the single `.m3-snackbar-host`.
 *
 * One snackbar is visible at a time: a new call supersedes anything still
 * waiting in the queue, and the replacement is shown once the visible one ends
 * (timeout, action, close or dismiss()).
 */
import { t } from "../core/index.js";

let host = null;
let current = null;
const queue = [];

function ensureHost() {
    if (host && host.isConnected) return host;
    // The shell may ship an empty host; adopt it so there is never a second one.
    host = document.querySelector(".m3-snackbar-host") || document.createElement("div");
    host.classList.add("m3-snackbar-host");
    if (!host.isConnected) document.body.append(host);
    host.style.pointerEvents = "none"; // the snackbar opts back in
    return host;
}

function buildNode(entry) {
    const node = document.createElement("div");
    node.className = "m3-snackbar";
    node.setAttribute("role", "status");
    node.setAttribute("aria-live", "polite");
    node.style.pointerEvents = "auto";

    const label = document.createElement("span");
    label.className = "m3-snackbar__label";
    label.textContent = entry.label == null ? "" : String(entry.label);
    node.append(label);

    if (entry.actionLabel) {
        const action = document.createElement("button");
        action.type = "button";
        action.className = "m3-snackbar__action";
        action.textContent = entry.actionLabel;
        action.addEventListener("click", (event) => {
            if (typeof entry.onAction === "function") entry.onAction(event);
            dismiss(entry);
        });
        node.append(action);
    }
    if (entry.closeable) {
        const close = document.createElement("button");
        close.type = "button";
        close.className = "m3-icon-btn m3-icon-btn--standard";
        close.setAttribute("aria-label", t("newui.snackbar.dismiss", "Dismiss"));
        close.textContent = "\u2715";
        close.addEventListener("click", () => dismiss(entry));
        node.append(close);
    }
    node.addEventListener("keydown", (event) => { if (event.key === "Escape") dismiss(entry); });
    return node;
}

function pump() {
    if (current || !queue.length) return;
    const entry = queue.shift();
    if (entry.closed) return pump();
    current = entry;
    entry.node = buildNode(entry);
    ensureHost().append(entry.node);
    if (entry.timeout > 0) entry.timer = setTimeout(() => dismiss(entry), entry.timeout);
}

function dismiss(entry) {
    if (!entry || entry.closed) return;
    entry.closed = true;
    clearTimeout(entry.timer);
    if (entry.node) entry.node.remove();
    if (current === entry) {
        current = null;
        pump();
    }
}

/** @returns {{dismiss(): void}} */
export function showSnackbar({ label, actionLabel = null, onAction = null, timeout = 5000, closeable = false } = {}) {
    const entry = { label, actionLabel, onAction, timeout, closeable, node: null, timer: null, closed: false };
    queue.length = 0; // newest supersedes everything still waiting
    queue.push(entry);
    pump();
    return { dismiss: () => dismiss(entry) };
}

export function dismissAllSnackbars() {
    queue.length = 0;
    if (current) dismiss(current);
}
