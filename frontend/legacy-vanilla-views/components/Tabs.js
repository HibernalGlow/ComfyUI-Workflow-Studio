/**
 * components/Tabs.js — M3 tabs (tablist only; the caller owns the panels).
 *
 * `createTabs({ tabs, activeId, onChange, scrollable, ariaLabel })`
 *   -> `{ root, getActive(), setActive(id) }`
 *
 *   tabs: [{ id, label, icon?, panelId? }]
 *
 * Id contract (the caller names the panels, the component names the tabs):
 *   tab element id        = "nu-tab-" + tab.id
 *   tab aria-controls     = tab.panelId || tab.id      <- the caller's panel id
 *   panel aria-labelledby = "nu-tab-" + tab.id
 *
 * Keyboard: arrow keys / Home / End / roving tabindex are delegated to
 * `../a11y.js` with `activateOnFocus` (it moves focus and clicks the tab), so
 * arrow navigation selects immediately — the APG default for tablists. Enter and
 * Space work through the native button. `scrollable` makes the tablist itself the
 * horizontal scroll container and keeps the active tab in view.
 */

import { rovingTabindex } from "../a11y.js";

function iconSpan(icon) {
    const el = document.createElement("span");
    el.setAttribute("aria-hidden", "true");
    if (/<[a-z]/i.test(icon)) el.innerHTML = icon;
    else el.textContent = icon;
    return el;
}

export function createTabs({ tabs, activeId, onChange, scrollable = false, ariaLabel } = {}) {
    const list = Array.isArray(tabs) ? tabs : [];
    const root = document.createElement("div");
    root.className = "m3-tabs";
    root.setAttribute("role", "tablist");
    if (ariaLabel) root.setAttribute("aria-label", ariaLabel);
    if (scrollable) root.style.overflowX = "auto";

    let current = null;
    let roving = null;

    const entries = list.map((tab) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "m3-tab";
        btn.id = "nu-tab-" + tab.id;
        btn.setAttribute("role", "tab");
        btn.setAttribute("aria-selected", "false");
        btn.setAttribute("aria-controls", tab.panelId || tab.id);

        if (tab.icon) btn.appendChild(iconSpan(tab.icon));
        btn.appendChild(document.createTextNode(tab.label === undefined || tab.label === null ? "" : String(tab.label)));

        const indicator = document.createElement("span");
        indicator.className = "m3-tab__indicator";
        indicator.setAttribute("aria-hidden", "true");
        btn.appendChild(indicator);

        btn.addEventListener("click", () => activate(tab.id, { focus: false }));
        root.appendChild(btn);
        return { id: tab.id, el: btn };
    });

    function activate(id, { focus = false, notify = true } = {}) {
        const index = entries.findIndex((entry) => entry.id === id);
        if (index < 0) return;
        entries.forEach((entry, i) => {
            const on = i === index;
            entry.el.classList.toggle("m3-tab--active", on);
            entry.el.setAttribute("aria-selected", on ? "true" : "false");
        });
        const el = entries[index].el;
        current = id;
        if (roving) roving.setActive(el);
        if (scrollable && typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "nearest", inline: "nearest" });
        if (focus) el.focus();
        if (notify && typeof onChange === "function") onChange(id);
    }

    if (typeof rovingTabindex === "function") {
        roving = rovingTabindex(root, { itemSelector: ".m3-tab", orientation: "horizontal", activateOnFocus: true });
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
