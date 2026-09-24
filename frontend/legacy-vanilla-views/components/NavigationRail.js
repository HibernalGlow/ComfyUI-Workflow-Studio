/**
 * components/NavigationRail.js — M3 navigation rail.
 *
 * `createNavigationRail({ items, activeId, onChange, ariaLabel })`
 *   -> `{ root, getActive(), setActive(id) }`
 *
 *   items: [{ id, label, icon }]
 *
 * The active item carries `.m3-nav-rail__item--active` + `aria-current="page"`.
 * Labels are always rendered (`.m3-nav-rail__label`); narrow-viewport icon-only
 * mode is pure CSS. Arrow/Home/End navigation and the roving tabindex come from
 * `../a11y.js` — arrows move focus, Enter/Space activates (manual pattern).
 */

import { rovingTabindex } from "../a11y.js";
import { attachRipple } from "../ripple.js";

function iconSpan(icon) {
    const el = document.createElement("span");
    el.className = "m3-nav-rail__icon";
    el.setAttribute("aria-hidden", "true");
    if (/<[a-z]/i.test(icon)) el.innerHTML = icon;
    else el.textContent = icon;
    return el;
}

export function createNavigationRail({ items, activeId, onChange, ariaLabel } = {}) {
    const list = Array.isArray(items) ? items : [];
    const root = document.createElement("nav");
    root.className = "m3-navigation-rail";
    root.setAttribute("aria-label", ariaLabel || "Primary");

    let current = null;
    let roving = null;

    const entries = list.map((item) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "m3-nav-rail__item";

        const indicator = document.createElement("span");
        indicator.className = "m3-nav-rail__indicator";
        if (item.icon) indicator.appendChild(iconSpan(item.icon));
        btn.appendChild(indicator);

        const label = document.createElement("span");
        label.className = "m3-nav-rail__label";
        label.textContent = item.label === undefined || item.label === null ? "" : String(item.label);
        btn.appendChild(label);

        attachRipple(btn);
        btn.addEventListener("click", () => activate(item.id, { focus: false }));
        root.appendChild(btn);
        return { id: item.id, el: btn };
    });

    function activate(id, { focus = false, notify = true } = {}) {
        const index = entries.findIndex((entry) => entry.id === id);
        if (index < 0) return;
        entries.forEach((entry, i) => {
            const on = i === index;
            entry.el.classList.toggle("m3-nav-rail__item--active", on);
            if (on) entry.el.setAttribute("aria-current", "page");
            else entry.el.removeAttribute("aria-current");
        });
        const el = entries[index].el;
        current = id;
        if (roving) roving.setActive(el);
        if (focus) el.focus();
        if (notify && typeof onChange === "function") onChange(id);
    }

    if (typeof rovingTabindex === "function") {
        roving = rovingTabindex(root, { itemSelector: ".m3-nav-rail__item", orientation: "vertical" });
    }

    const initial = activeId !== undefined && entries.some((entry) => entry.id === activeId)
        ? activeId
        : entries.length ? entries[0].id : null;
    if (initial !== null) activate(initial, { focus: false, notify: false });

    return {
        root,
        getActive() {
            return current;
        },
        setActive(id) {
            activate(id, { focus: false, notify: false });
        },
    };
}
