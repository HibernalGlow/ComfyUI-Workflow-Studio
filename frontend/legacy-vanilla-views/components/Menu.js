/**
 * components/Menu.js — M3 popup menu, mounted on `document.body`.
 *
 * `openMenu({ anchor, items, onSelect, align, width, ariaLabel })` -> `{ close() }`
 *
 *   items: [{ label, icon?, disabled?, selected?, value?, separator?, danger? }]
 *     - `separator: true` renders `.m3-menu__divider`
 *     - `selected: true` renders `.m3-menu-item--selected`
 *     - `danger: true` uses `--md-sys-color-error` (no frozen danger modifier exists)
 *   onSelect(value, item) receives `item.value` when present, else `item.label`.
 *
 * Behaviour: fixed positioning next to the anchor with viewport flipping, full
 * keyboard support (ArrowUp/Down, Home/End, Enter/Space via the native button,
 * Esc, printable type-ahead), close on outside pointerdown / scroll / resize,
 * focus restored to the anchor. `close()` is idempotent.
 */

import { restoreFocus } from "../a11y.js";
import { attachRipple } from "../ripple.js";

const GAP = 4;
const EDGE = 8;
const TYPEAHEAD_MS = 600;

function iconSpan(icon, className) {
    const el = document.createElement("span");
    el.className = className;
    el.setAttribute("aria-hidden", "true");
    if (/<[a-z]/i.test(icon)) el.innerHTML = icon;
    else el.textContent = icon;
    return el;
}

export function openMenu({ anchor, items, onSelect, align = "start", width, ariaLabel } = {}) {
    const root = document.createElement("div");
    root.className = "m3-menu";
    root.setAttribute("role", "menu");
    if (ariaLabel) root.setAttribute("aria-label", ariaLabel);

    /** @type {Array<{el: HTMLElement, item: object, disabled: boolean, separator: boolean}>} */
    const entries = [];

    (Array.isArray(items) ? items : []).forEach((item) => {
        if (!item) return;

        if (item.separator) {
            const divider = document.createElement("div");
            divider.className = "m3-menu__divider";
            divider.setAttribute("role", "separator");
            root.appendChild(divider);
            entries.push({ el: divider, item, disabled: true, separator: true });
            return;
        }

        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "m3-menu-item";
        btn.setAttribute("role", "menuitem");
        btn.tabIndex = -1;
        if (item.selected) btn.classList.add("m3-menu-item--selected");
        if (item.icon) btn.appendChild(iconSpan(item.icon, "m3-menu-item__icon"));

        const label = document.createElement("span");
        label.className = "m3-menu-item__label";
        label.textContent = item.label === undefined || item.label === null ? "" : String(item.label);
        btn.appendChild(label);

        if (item.danger) btn.style.color = "var(--md-sys-color-error)";
        if (item.disabled) {
            btn.disabled = true;
            btn.setAttribute("aria-disabled", "true");
        } else {
            attachRipple(btn);
        }

        const entry = { el: btn, item, disabled: Boolean(item.disabled), separator: false };
        btn.addEventListener("click", () => select(entry));
        root.appendChild(btn);
        entries.push(entry);
    });

    // --- positioning ---------------------------------------------------------
    function place() {
        const box = root.getBoundingClientRect();
        let top = EDGE;
        let left = EDGE;

        if (anchor && typeof anchor.getBoundingClientRect === "function") {
            const a = anchor.getBoundingClientRect();
            top = a.bottom + GAP;
            if (top + box.height > window.innerHeight - EDGE) {
                const flipped = a.top - GAP - box.height;
                top = flipped >= EDGE ? flipped : Math.max(EDGE, window.innerHeight - EDGE - box.height);
            }
            if (align === "end") {
                left = Math.max(EDGE, a.right - box.width);
            } else {
                left = a.left;
                if (left + box.width > window.innerWidth - EDGE) left = Math.max(EDGE, window.innerWidth - EDGE - box.width);
            }
        }

        root.style.top = Math.round(top) + "px";
        root.style.left = Math.round(left) + "px";
    }

    root.style.position = "fixed";
    root.style.visibility = "hidden";
    if (width !== undefined && width !== null) root.style.width = typeof width === "number" ? width + "px" : String(width);
    document.body.appendChild(root);
    place();
    root.style.visibility = "";

    // --- selection / navigation ---------------------------------------------
    function enabled() {
        return entries.filter((entry) => !entry.separator && !entry.disabled);
    }

    function focusAt(index) {
        const list = enabled();
        if (!list.length) return;
        const target = list[((index % list.length) + list.length) % list.length];
        target.el.focus({ preventScroll: true });
    }

    function focusedIndex() {
        return enabled().findIndex((entry) => entry.el === document.activeElement);
    }

    function select(entry) {
        if (!entry || entry.disabled || entry.separator) return;
        close();
        if (typeof onSelect !== "function") return;
        const { item } = entry;
        onSelect(item.value !== undefined ? item.value : item.label, item);
    }

    let typed = "";
    let typedAt = 0;

    function typeAhead(char) {
        const now = Date.now();
        typed = now - typedAt < TYPEAHEAD_MS ? typed + char : char;
        typedAt = now;
        const list = enabled();
        const start = focusedIndex();
        for (let step = 1; step <= list.length; step += 1) {
            const entry = list[((start + step) % list.length + list.length) % list.length];
            const text = String(entry.item.label || "").toLowerCase();
            if (text.startsWith(typed)) {
                entry.el.focus({ preventScroll: true });
                return;
            }
        }
    }

    function onKeyDown(event) {
        const key = event.key;
        const current = focusedIndex();
        if (key === "ArrowDown") {
            event.preventDefault();
            focusAt(current < 0 ? 0 : current + 1);
        } else if (key === "ArrowUp") {
            event.preventDefault();
            focusAt(current < 0 ? enabled().length - 1 : current - 1);
        } else if (key === "Home") {
            event.preventDefault();
            focusAt(0);
        } else if (key === "End") {
            event.preventDefault();
            focusAt(enabled().length - 1);
        } else if (key === "Tab") {
            event.preventDefault();
            close();
        } else if (key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
            typeAhead(key.toLowerCase());
        }
        // Enter/Space fall through: the native button fires `click`.
    }

    function onDocKeyDown(event) {
        if (event.key !== "Escape") return;
        event.preventDefault();
        close();
    }

    function onDocPointerDown(event) {
        if (root.contains(event.target)) return;
        if (anchor && typeof anchor.contains === "function" && anchor.contains(event.target)) return;
        close();
    }

    function onScroll(event) {
        if (root.contains(event.target)) return;
        close();
    }

    function onResize() {
        close();
    }

    // --- lifecycle -----------------------------------------------------------
    let closed = false;

    function close() {
        if (closed) return;
        closed = true;
        document.removeEventListener("pointerdown", onDocPointerDown, true);
        document.removeEventListener("keydown", onDocKeyDown, true);
        window.removeEventListener("scroll", onScroll, true);
        window.removeEventListener("resize", onResize);
        root.removeEventListener("keydown", onKeyDown);
        if (root.parentNode) root.parentNode.removeChild(root);
        restoreFocus(anchor);
    }

    root.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onDocPointerDown, true);
    document.addEventListener("keydown", onDocKeyDown, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);

    const focusable = enabled();
    const initial = focusable.find((entry) => entry.item.selected) || focusable[0];
    if (initial) initial.el.focus({ preventScroll: true });

    return { close };
}
