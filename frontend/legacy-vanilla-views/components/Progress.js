/**
 * components/Progress.js — M3 progress indicators.
 *
 * `createLinearProgress({ value, indeterminate, ariaLabel })` -> `{ root, setValue(v) }`
 * `createCircularProgress({ indeterminate, size, ariaLabel })` -> `{ root, setValue(v) }`
 *
 * Both roots are `role="progressbar"` with `aria-valuemin/max` and an
 * `aria-valuenow` that only exists while determinate (a value of null/undefined
 * means indeterminate, so `setValue(null)` switches back).
 *
 * The circular indicator is an SVG ring (track + bar) so that it can be both a
 * spinner and a real determinate percentage; it carries `.m3-spinner`, the class
 * m3-components.css pairs with `.m3-progress--circular`. The ring is drawn by the
 * SVG (inline `border/background: none` neutralise the CSS border spinner) while
 * the CSS `m3-spin` rotation — which the stylesheet's reduced-motion rule tames —
 * spins the indeterminate state and is switched off with `animation: none` once a
 * determinate value arrives.
 */

const SVG_NS = "http://www.w3.org/2000/svg";
const RADIUS = 20;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
const MIN = 0;
const MAX = 100;

function clamp(value) {
    if (value === null || value === undefined || value === "") return null;
    const num = Number(value);
    if (!Number.isFinite(num)) return null;
    return Math.min(MAX, Math.max(MIN, num));
}

function lengthOf(size) {
    if (size === undefined || size === null) return null;
    return typeof size === "number" ? size + "px" : String(size);
}

export function createLinearProgress({ value = null, indeterminate = false, ariaLabel } = {}) {
    const root = document.createElement("div");
    root.className = "m3-progress";
    root.setAttribute("role", "progressbar");
    root.setAttribute("aria-valuemin", String(MIN));
    root.setAttribute("aria-valuemax", String(MAX));
    if (ariaLabel) root.setAttribute("aria-label", ariaLabel);

    const track = document.createElement("div");
    track.className = "m3-progress__track";
    const bar = document.createElement("div");
    bar.className = "m3-progress__bar";
    track.appendChild(bar);
    root.appendChild(track);

    function setValue(next) {
        const pct = indeterminate ? null : clamp(next);
        const isIndeterminate = pct === null;
        root.classList.toggle("m3-progress--indeterminate", isIndeterminate);
        if (isIndeterminate) {
            root.removeAttribute("aria-valuenow");
            bar.style.width = "";
        } else {
            root.setAttribute("aria-valuenow", String(Math.round(pct)));
            bar.style.width = pct + "%";
        }
    }

    setValue(value);
    return { root, setValue };
}

export function createCircularProgress({ indeterminate = true, size, ariaLabel } = {}) {
    const root = document.createElement("div");
    root.className = "m3-progress m3-progress--circular";
    root.setAttribute("role", "progressbar");
    root.setAttribute("aria-valuemin", String(MIN));
    root.setAttribute("aria-valuemax", String(MAX));
    if (ariaLabel) root.setAttribute("aria-label", ariaLabel);

    const length = lengthOf(size);
    if (length) {
        root.style.setProperty("--md-comp-progress-size", length);
        root.style.width = length;
        root.style.height = length;
    }

    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("class", "m3-spinner");
    svg.setAttribute("viewBox", "0 0 48 48");
    svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
    svg.setAttribute("aria-hidden", "true");
    // Defensive: the ring is drawn by the SVG, so an author-level border/background
    // spinner style must not paint a second ring around it.
    svg.style.border = "none";
    svg.style.background = "none";
    svg.style.width = "100%";
    svg.style.height = "100%";

    const STROKE = "var(--md-comp-progress-thickness, 4px)";

    function ring(className, color) {
        const circle = document.createElementNS(SVG_NS, "circle");
        circle.setAttribute("class", className);
        circle.setAttribute("cx", "24");
        circle.setAttribute("cy", "24");
        circle.setAttribute("r", String(RADIUS));
        circle.setAttribute("fill", "none");
        circle.style.stroke = color;
        circle.style.strokeWidth = STROKE;
        circle.style.strokeLinecap = "round";
        return circle;
    }

    const track = ring("m3-progress__track", "var(--md-comp-progress-track-color)");
    const bar = ring("m3-progress__bar", "var(--md-comp-progress-active-indicator-color)");
    bar.style.transform = "rotate(-90deg)";
    bar.style.transformOrigin = "center";
    svg.appendChild(track);
    svg.appendChild(bar);
    root.appendChild(svg);

    function setValue(next) {
        const pct = clamp(next);
        const isIndeterminate = pct === null;
        root.classList.toggle("m3-progress--indeterminate", isIndeterminate);

        if (isIndeterminate) {
            root.removeAttribute("aria-valuenow");
            bar.style.strokeDasharray = CIRCUMFERENCE * 0.25 + " " + CIRCUMFERENCE * 0.75;
            bar.style.strokeDashoffset = "0";
            // Let the CSS `m3-spin` rotation run (tamed by its reduced-motion rule).
            svg.style.animation = "";
        } else {
            root.setAttribute("aria-valuenow", String(Math.round(pct)));
            // A determinate arc must not keep spinning.
            svg.style.animation = "none";
            bar.style.strokeDasharray = String(CIRCUMFERENCE);
            bar.style.strokeDashoffset = String(CIRCUMFERENCE * (1 - pct / MAX));
        }
    }

    // `indeterminate: false` starts as a determinate ring at 0%.
    setValue(indeterminate ? null : 0);
    return { root, setValue };
}
