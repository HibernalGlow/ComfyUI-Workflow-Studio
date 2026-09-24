/**
 * components/SegmentedButtons.js — M3 segmented buttons.
 *
 * `createSegmentedButtons({ segments, value, multi, onChange, ariaLabel })`
 *   -> `{ root, getValue(), setValue(v) }`
 *
 *   segments: [{ value, label, icon? }]
 *
 *   multi: false -> `role="radiogroup"`, buttons are `role="radio"` with
 *                   `aria-checked` and a roving tabindex; arrow keys move AND
 *                   select, like a native radio group.
 *   multi: true  -> `role="group"`, buttons use `aria-pressed`; arrow keys move
 *                   focus only and Enter/Space toggles (native button click).
 *
 * `value` is an array (or Set) of values when `multi`, a single value otherwise;
 * values keep the caller's own type and are compared by string identity.
 * `.m3-segmented__btn--selected` mirrors the ARIA state for styling.
 */

import { arrowDirection } from "../a11y.js";
import { attachRipple } from "../ripple.js";

function iconSpan(icon) {
    const el = document.createElement("span");
    el.setAttribute("aria-hidden", "true");
    if (/<[a-z]/i.test(icon)) el.innerHTML = icon;
    else el.textContent = icon;
    return el;
}

function same(a, b) {
    return String(a) === String(b);
}

function asArray(value) {
    if (value instanceof Set) return Array.from(value);
    if (Array.isArray(value)) return value.slice();
    return [];
}

export function createSegmentedButtons({ segments, value, multi = false, onChange, ariaLabel } = {}) {
    const list = Array.isArray(segments) ? segments : [];
    const root = document.createElement("div");
    root.className = "m3-segmented";
    root.setAttribute("role", multi ? "group" : "radiogroup");
    if (ariaLabel) root.setAttribute("aria-label", ariaLabel);

    let picked = asArray(value);
    let single = multi || value === undefined || value === null ? null : value;

    function isOn(segment) {
        if (multi) return picked.some((entry) => same(entry, segment.value));
        return single !== null && same(single, segment.value);
    }

    const entries = list.map((segment) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "m3-segmented__btn";
        if (multi) {
            btn.setAttribute("aria-pressed", "false");
        } else {
            btn.setAttribute("role", "radio");
            btn.setAttribute("aria-checked", "false");
        }
        if (segment.icon) btn.appendChild(iconSpan(segment.icon));
        btn.appendChild(document.createTextNode(segment.label === undefined || segment.label === null ? "" : String(segment.label)));

        btn.addEventListener("click", () => choose(segment.value));
        attachRipple(btn);
        root.appendChild(btn);
        return { segment, btn };
    });

    function paint() {
        let firstOn = null;
        entries.forEach(({ segment, btn }) => {
            const on = isOn(segment);
            if (on && firstOn === null) firstOn = btn;
            btn.classList.toggle("m3-segmented__btn--selected", on);
            if (multi) {
                btn.setAttribute("aria-pressed", on ? "true" : "false");
                btn.tabIndex = 0;
            } else {
                btn.setAttribute("aria-checked", on ? "true" : "false");
                btn.tabIndex = -1;
            }
        });
        if (!multi && entries.length) {
            // Roving tabindex: the selected button, or the first one, is the tab stop.
            (firstOn || entries[0].btn).tabIndex = 0;
        }
    }

    function choose(next) {
        if (multi) {
            if (picked.some((entry) => same(entry, next))) picked = picked.filter((entry) => !same(entry, next));
            else picked = picked.concat([next]);
            paint();
            if (typeof onChange === "function") onChange(picked.slice());
            return;
        }
        if (single !== null && same(single, next)) return;
        single = next;
        paint();
        if (typeof onChange === "function") onChange(next);
    }

    function step(direction) {
        if (!entries.length) return;
        const index = entries.findIndex(({ btn }) => btn === document.activeElement);
        const base = index < 0 ? 0 : index;
        const next = ((base + direction) % entries.length + entries.length) % entries.length;
        const target = entries[next];
        if (multi) {
            target.btn.focus();
        } else {
            choose(target.segment.value);
            target.btn.focus();
        }
    }

    root.addEventListener("keydown", (event) => {
        const direction = arrowDirection(event, { orientation: "horizontal" });
        if (direction) {
            event.preventDefault();
            step(direction);
            return;
        }
        if (event.key === "Home" || event.key === "End") {
            if (!entries.length) return;
            event.preventDefault();
            const target = event.key === "Home" ? entries[0] : entries[entries.length - 1];
            if (!multi) choose(target.segment.value);
            target.btn.focus();
        }
    });

    paint();

    return {
        root,
        getValue() {
            return multi ? picked.slice() : single;
        },
        setValue(next) {
            if (multi) picked = asArray(next);
            else single = next === undefined || next === null ? null : next;
            paint();
        },
    };
}
