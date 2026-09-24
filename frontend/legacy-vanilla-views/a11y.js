/**
 * a11y.js — keyboard / focus / announcement primitives shared by every newui
 * component. Nothing here reaches outside the node it was handed.
 */

/** Everything that can receive focus through Tab. */
const FOCUSABLE_SELECTOR = [
    "a[href]",
    "button:not([disabled])",
    "input:not([disabled])",
    "select:not([disabled])",
    "textarea:not([disabled])",
    "[tabindex]:not([tabindex='-1'])",
].join(",");

/** Visible, enabled focusables inside `container`, in DOM order. */
function focusables(container) {
    return Array.from(container.querySelectorAll(FOCUSABLE_SELECTOR)).filter((el) => {
        if (el.closest("[inert]")) return false;
        if (el.getAttribute("aria-hidden") === "true") return false;
        return el.getClientRects().length > 0;
    });
}

/**
 * Keep Tab inside `container`; optional Esc handling.
 * @returns {{activate(): void, deactivate(): void}}
 */
export function focusTrap(container, { onEscape, initialFocus } = {}) {
    let previous = null;
    let active = false;

    function onKeydown(event) {
        if (event.key === "Escape") {
            if (typeof onEscape === "function") {
                event.preventDefault();
                event.stopPropagation();
                onEscape(event);
            }
            return;
        }
        if (event.key !== "Tab") return;

        const items = focusables(container);
        if (!items.length) {
            // Nothing to focus: keep the focus anchored on the container itself.
            event.preventDefault();
            container.focus({ preventScroll: true });
            return;
        }
        const first = items[0];
        const last = items[items.length - 1];
        const from = document.activeElement;
        if (!container.contains(from)) {
            event.preventDefault();
            first.focus();
        } else if (event.shiftKey && from === first) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && from === last) {
            event.preventDefault();
            first.focus();
        }
    }

    return {
        activate() {
            if (active) return;
            active = true;
            previous = document.activeElement;
            if (!container.hasAttribute("tabindex")) container.setAttribute("tabindex", "-1");
            container.addEventListener("keydown", onKeydown, true);
            const target = initialFocus || focusables(container)[0];
            (target || container).focus({ preventScroll: true });
        },
        deactivate() {
            if (!active) return;
            active = false;
            container.removeEventListener("keydown", onKeydown, true);
            // Only reclaim focus when it would otherwise be dropped on <body>.
            const lost = container.contains(document.activeElement) || document.activeElement === document.body;
            if (lost) restoreFocus(previous);
            previous = null;
        },
    };
}

/**
 * One tab stop for a group of items; arrows move focus inside it.
 * @returns {{setActive(el: (Element|number), opts?: {focus?: boolean}): void, getActive(): Element|null, destroy(): void}}
 */
export function rovingTabindex(container, { itemSelector, orientation = "horizontal", loop = true, activateOnFocus = false } = {}) {
    const selector = itemSelector || "[tabindex]";
    let activeEl = null;
    let keyboardNav = false;

    function items() {
        return Array.from(container.querySelectorAll(selector)).filter(
            (el) => !el.hasAttribute("disabled") && el.getAttribute("aria-disabled") !== "true"
        );
    }

    function setActive(el, { focus = false } = {}) {
        const list = items();
        const next = typeof el === "number" ? list[el] : el;
        if (!next || !list.includes(next)) return;
        activeEl = next;
        for (const item of list) item.setAttribute("tabindex", item === next ? "0" : "-1");
        if (focus) next.focus();
    }

    function getActive() {
        const list = items();
        if (activeEl && activeEl.isConnected) return activeEl;
        return list.find((el) => el.getAttribute("tabindex") === "0") || list[0] || null;
    }

    function step(delta) {
        const list = items();
        if (!list.length) return;
        const current = list.indexOf(document.activeElement);
        const from = current === -1 ? (delta > 0 ? -1 : list.length) : current;
        let next = from + delta;
        if (next < 0) {
            if (!loop) return;
            next = list.length - 1;
        } else if (next >= list.length) {
            if (!loop) return;
            next = 0;
        }
        keyboardNav = true;
        setActive(next, { focus: true });
    }

    function onKeydown(event) {
        const delta = arrowDirection(event, { orientation });
        if (delta !== 0) {
            event.preventDefault();
            step(delta);
            return;
        }
        const list = items();
        if (!list.length) return;
        if (event.key === "Home") {
            event.preventDefault();
            keyboardNav = true;
            setActive(0, { focus: true });
        } else if (event.key === "End") {
            event.preventDefault();
            keyboardNav = true;
            setActive(list.length - 1, { focus: true });
        }
    }

    function onFocusin(event) {
        const item = event.target instanceof Element ? event.target.closest(selector) : null;
        if (!item || !container.contains(item)) return;
        setActive(item);
        // Only auto-activate for arrow navigation; a real click already activated.
        if (activateOnFocus && keyboardNav) item.click();
        keyboardNav = false;
    }

    container.addEventListener("keydown", onKeydown);
    container.addEventListener("focusin", onFocusin);
    const initial = items();
    for (const item of initial) item.setAttribute("tabindex", item.getAttribute("tabindex") === "0" ? "0" : "-1");
    // Always leave exactly one tab stop so the group stays keyboard reachable.
    if (initial.length && !initial.some((el) => el.getAttribute("tabindex") === "0")) {
        initial[0].setAttribute("tabindex", "0");
    }

    return {
        setActive,
        getActive,
        destroy() {
            container.removeEventListener("keydown", onKeydown);
            container.removeEventListener("focusin", onFocusin);
        },
    };
}

/** -1 / 0 / +1 for the arrow key in `event`, honouring orientation and RTL. */
export function arrowDirection(event, { orientation = "horizontal", dir = "ltr" } = {}) {
    const vertical = orientation === "vertical" || orientation === "both";
    const horizontal = orientation === "horizontal" || orientation === "both";
    const flip = dir === "rtl" ? -1 : 1;
    switch (event.key) {
        case "ArrowUp": return vertical ? -1 : 0;
        case "ArrowDown": return vertical ? 1 : 0;
        case "ArrowLeft": return horizontal ? -1 * flip : 0;
        case "ArrowRight": return horizontal ? 1 * flip : 0;
        default: return 0;
    }
}

/** Focus `target` again if it is still in the document. */
export function restoreFocus(target) {
    if (target && target.isConnected && typeof target.focus === "function") {
        target.focus({ preventScroll: true });
    }
}

const liveRegions = new Map();

function liveRegion(politeness) {
    const existing = liveRegions.get(politeness);
    if (existing && existing.isConnected) return existing;
    if (!document.body) return null;

    const el = document.createElement("div");
    el.setAttribute("role", politeness === "assertive" ? "alert" : "status");
    el.setAttribute("aria-live", politeness);
    el.setAttribute("aria-atomic", "true");
    // Visually hidden inline, so an unstyled page can never show this text.
    Object.assign(el.style, {
        position: "absolute",
        width: "1px",
        height: "1px",
        margin: "-1px",
        padding: "0",
        border: "0",
        overflow: "hidden",
        whiteSpace: "nowrap",
        clipPath: "inset(50%)",
    });
    document.body.append(el);
    liveRegions.set(politeness, el);
    return el;
}

/** Announce a visual state change to screen readers. */
export function announce(message, { politeness = "polite" } = {}) {
    if (message == null) return;
    const region = liveRegion(politeness === "assertive" ? "assertive" : "polite");
    if (!region) return;
    const write = () => { region.textContent = String(message); };
    // Clearing first lets AT pick up an identical repeated message.
    region.textContent = "";
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(write);
    else write();
}

/** True when the user asked the OS for reduced motion. */
export function prefersReducedMotion() {
    return typeof window !== "undefined"
        && typeof window.matchMedia === "function"
        && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
