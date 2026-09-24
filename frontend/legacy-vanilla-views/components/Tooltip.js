/**
 * components/Tooltip.js — M3 tooltip attached to an existing element.
 *
 * `attachTooltip(el, text, { rich = false, placement = "top" })` -> `{ detach() }`
 *
 *   - `aria-describedby` on the host points at the generated tooltip id.
 *   - plain variant: `.m3-tooltip` with the text.
 *   - `rich: true`: `.m3-tooltip--rich` with a `.m3-tooltip__title` row plus an
 *     optional `.m3-tooltip__text` body (second line of `text` after "\n", or the
 *     explicit `title` / `body` options).
 *   - shows on mouseenter/focus, hides on mouseleave/blur/Esc, and follows the
 *     host while it is visible.
 *
 * Shape contract with m3-components.css: `.m3-tooltip` is revealed by
 * `[data-tooltip-visible]` (opacity/visibility, with a `translate(-50%, …)`
 * centring transition), so this module toggles that attribute instead of
 * `display`. The node lives on `document.body` with inline `position: fixed` and
 * viewport-flipping offsets — a host is never mutated (only `aria-describedby`
 * is added and restored), so an `overflow: hidden` button cannot clip it.
 * `placement`: "top" / "bottom" above or below the host, "left" / "right" beside
 * it; the side is flipped when it would leave the viewport.
 * `detach()` removes the node, the listeners and restores `aria-describedby`.
 */

const GAP = 8;
const EDGE = 8;

let seq = 0;

function noop() {
    return { detach() {} };
}

function sideStyles(tip, placement) {
    if (placement === "left" || placement === "right") {
        tip.style.top = "0px";
        tip.style.left = "0px";
        tip.style.transform = "translate(0, -50%)";
    } else {
        tip.style.top = "0px";
        tip.style.left = "0px";
        tip.style.transform = "";
    }
}

export function attachTooltip(el, text, { rich = false, placement = "top", title, body } = {}) {
    if (!el || typeof el.appendChild !== "function") return noop();

    const tip = document.createElement("div");
    tip.id = "nu-tooltip-" + (seq += 1);
    tip.className = rich ? "m3-tooltip m3-tooltip--rich" : "m3-tooltip";
    tip.setAttribute("role", "tooltip");
    tip.style.position = "fixed";
    sideStyles(tip, placement);

    const raw = text === undefined || text === null ? "" : String(text);
    if (rich) {
        const split = raw.indexOf("\n");
        const heading = title !== undefined && title !== null ? String(title) : split >= 0 ? raw.slice(0, split) : raw;
        const rest = body !== undefined && body !== null ? String(body) : split >= 0 ? raw.slice(split + 1) : "";

        const titleEl = document.createElement("div");
        titleEl.className = "m3-tooltip__title";
        titleEl.textContent = heading;
        tip.appendChild(titleEl);

        if (rest) {
            const textEl = document.createElement("div");
            textEl.className = "m3-tooltip__text";
            textEl.textContent = rest;
            tip.appendChild(textEl);
        }
    } else {
        tip.textContent = raw;
    }

    const previousDescribedBy = el.getAttribute("aria-describedby");
    el.setAttribute("aria-describedby", previousDescribedBy ? previousDescribedBy + " " + tip.id : tip.id);

    let visible = false;
    let frame = 0;

    function place() {
        const host = el.getBoundingClientRect();
        const box = tip.getBoundingClientRect();

        if (placement === "left" || placement === "right") {
            const before = host.left - GAP - box.width;
            const after = host.right + GAP;
            const wanted = placement === "left" ? before : after;
            const other = placement === "left" ? after : before;
            const fits = wanted >= EDGE && wanted + box.width <= window.innerWidth - EDGE;
            const left = fits ? wanted : other;
            tip.style.left = Math.round(Math.max(EDGE, Math.min(left, window.innerWidth - EDGE - box.width))) + "px";
            tip.style.top = Math.round(Math.max(EDGE, Math.min(host.top + host.height / 2, window.innerHeight - EDGE))) + "px";
            return;
        }

        const below = host.bottom + GAP;
        const above = host.top - GAP - box.height;
        const fitsBelow = below + box.height <= window.innerHeight - EDGE;
        const fitsAbove = above >= EDGE;
        let top;
        if (placement === "top") top = fitsAbove || !fitsBelow ? above : below;
        else top = fitsBelow || !fitsAbove ? below : above;
        tip.style.top = Math.round(Math.max(EDGE, Math.min(top, window.innerHeight - EDGE - box.height))) + "px";
        // X centring stays with CSS (`translate(-50%, …)`), so only the centre is set.
        tip.style.left = Math.round(host.left + host.width / 2) + "px";
    }

    function reposition() {
        if (!visible || frame) return;
        frame = window.requestAnimationFrame(() => {
            frame = 0;
            if (visible) place();
        });
    }

    function show() {
        if (!tip.isConnected) document.body.appendChild(tip);
        visible = true;
        place();
        tip.setAttribute("data-tooltip-visible", "");
    }

    function hide() {
        visible = false;
        tip.removeAttribute("data-tooltip-visible");
    }

    function onKeyDown(event) {
        if (event.key === "Escape") hide();
    }

    el.addEventListener("mouseenter", show);
    el.addEventListener("focus", show);
    el.addEventListener("mouseleave", hide);
    el.addEventListener("blur", hide);
    el.addEventListener("keydown", onKeyDown);
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);

    let detached = false;

    function detach() {
        if (detached) return;
        detached = true;
        el.removeEventListener("mouseenter", show);
        el.removeEventListener("focus", show);
        el.removeEventListener("mouseleave", hide);
        el.removeEventListener("blur", hide);
        el.removeEventListener("keydown", onKeyDown);
        window.removeEventListener("scroll", reposition, true);
        window.removeEventListener("resize", reposition);
        if (frame) window.cancelAnimationFrame(frame);
        if (tip.parentNode) tip.parentNode.removeChild(tip);
        if (previousDescribedBy === null) el.removeAttribute("aria-describedby");
        else el.setAttribute("aria-describedby", previousDescribedBy);
    }

    return { detach };
}
