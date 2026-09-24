/**
 * ripple.js — M3 state ripple.
 *
 * The span carries no colour of its own: CSS paints `.m3-ripple` with
 * currentColor and this module only positions/sizes it and runs the
 * scale+fade. Durations/easings are read from the `--md-sys-*` motion tokens,
 * never hard-coded, and the whole effect is skipped for reduced motion.
 */
import { prefersReducedMotion } from "./a11y.js";

const DIRECT = Symbol("m3RippleDirect");
const DELEGATED = Symbol("m3RippleDelegated");

const DEFAULT_SELECTOR = [
    ".m3-btn",
    ".m3-icon-btn",
    ".m3-fab",
    ".m3-chip",
    ".m3-list-item",
    ".m3-menu-item",
    ".m3-tab",
    ".m3-segmented__btn",
    ".m3-nav-rail__item",
].join(",");

function tokenNumber(el, name, fallback) {
    const raw = getComputedStyle(el).getPropertyValue(name).trim();
    const value = parseFloat(raw);
    return Number.isFinite(value) ? value : fallback;
}

function tokenTime(el, name, fallback) {
    const raw = getComputedStyle(el).getPropertyValue(name).trim();
    const value = parseFloat(raw);
    if (!Number.isFinite(value)) return fallback;
    // A unitless or `s`-suffixed token is in seconds; `ms` is already milliseconds.
    return raw.endsWith("ms") || raw === String(value) ? value : value * 1000;
}

function tokenEasing(el, name) {
    const raw = getComputedStyle(el).getPropertyValue(name).trim();
    return raw || null;
}

function spawn(el, clientX, clientY) {
    if (prefersReducedMotion()) return;
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) return;

    const span = document.createElement("span");
    span.className = "m3-ripple";
    span.setAttribute("aria-hidden", "true");

    const size = Math.max(rect.width, rect.height) * 2;
    const opacity = tokenNumber(el, "--md-sys-state-pressed-opacity", 0.12);
    Object.assign(span.style, {
        position: "absolute",
        pointerEvents: "none",
        width: `${size}px`,
        height: `${size}px`,
        left: `${clientX - rect.left - size / 2}px`,
        top: `${clientY - rect.top - size / 2}px`,
        borderRadius: "var(--md-sys-shape-corner-full)",
        opacity: String(opacity),
    });
    el.append(span);

    const done = () => span.remove();
    if (typeof span.animate !== "function") {
        setTimeout(done, tokenTime(el, "--md-sys-motion-duration-short4", 200));
        return;
    }
    const options = { duration: tokenTime(el, "--md-sys-motion-duration-short4", 200) };
    const easing = tokenEasing(el, "--md-sys-motion-easing-standard");
    if (easing) options.easing = easing;
    const animation = span.animate(
        [{ transform: "scale(0)", opacity }, { transform: "scale(1)", opacity: 0 }],
        options
    );
    animation.finished.then(done, done);
}

/**
 * Bind a ripple to one element. Idempotent: a second call returns the same
 * handle instead of stacking a second listener.
 * @returns {{disabled: boolean, setDisabled(v: boolean): void, detach(): void}}
 */
export function attachRipple(el, { disabled = false } = {}) {
    if (!el) return null;
    if (el[DIRECT]) return el[DIRECT];

    const state = { disabled: Boolean(disabled) };
    const onPointerdown = (event) => {
        if (state.disabled || el.disabled === true) return;
        if (event.button !== 0) return;
        spawn(el, event.clientX, event.clientY);
    };
    el.addEventListener("pointerdown", onPointerdown);

    const handle = {
        setDisabled(value) { state.disabled = Boolean(value); },
        get disabled() { return state.disabled; },
        detach() {
            el.removeEventListener("pointerdown", onPointerdown);
            delete el[DIRECT];
        },
    };
    el[DIRECT] = handle;
    return handle;
}

/**
 * One delegated listener on a view root — safe to call once per mount and it
 * keeps working for children rendered later (no re-binding needed).
 * Elements that already carry a direct binding are skipped, so calling both
 * primitives never doubles the ripple.
 */
export function initRipple(root, { selector = DEFAULT_SELECTOR } = {}) {
    if (!root || root[DELEGATED]) return;
    root[DELEGATED] = true;
    root.addEventListener("pointerdown", (event) => {
        if (event.button !== 0) return;
        const target = event.target instanceof Element ? event.target.closest(selector) : null;
        if (!target || !root.contains(target)) return;
        if (target[DIRECT]) return;
        if (target.disabled || target.getAttribute("aria-disabled") === "true") return;
        spawn(target, event.clientX, event.clientY);
    });
}
