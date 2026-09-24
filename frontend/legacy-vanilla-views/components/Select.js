/**
 * Select.js — progressive enhancement (brief §3.6).
 *
 * A real <select class="m3-select__native"> stays in the DOM at all times, so
 * keyboard operability, screen-reader semantics and `change` events work even
 * if the M3 popup never renders. The `.m3-select__menu` overlay is added only
 * when the browser cannot style the native popup itself (no `base-select`),
 * and it is mouse-only sugar: choosing a row updates the native control and
 * re-dispatches a bubbling `change`, so one code path serves both.
 */
import { announce } from "../a11y.js";

let uid = 0;

function supportsBaseSelect() {
    return typeof CSS !== "undefined"
        && typeof CSS.supports === "function"
        && CSS.supports("appearance", "base-select");
}

function labelFor(options, value) {
    const match = options.find((item) => String(item.value) === String(value));
    return match ? String(match.label == null ? match.value : match.label) : "";
}

export function createSelect({ label, options = [], value, disabled = false, id, placeholder, onChange } = {}) {
    uid += 1;
    const selectId = id || `nu-select-${uid}`;
    const root = document.createElement("div");
    root.className = "m3-select";

    if (label) {
        // No frozen class for the select label: a plain <label> keeps the
        // association native (`select` is the accessible control).
        const caption = document.createElement("label");
        caption.setAttribute("for", selectId);
        caption.textContent = label;
        root.append(caption);
    }

    const native = document.createElement("select");
    native.className = "m3-select__native";
    native.id = selectId;
    root.append(native);

    let list = [];
    let menu = null;
    let fromMenu = false;

    function setOptions(items) {
        list = Array.isArray(items) ? items.slice() : [];
        native.replaceChildren();
        if (placeholder) {
            const hint = document.createElement("option");
            hint.value = "";
            hint.textContent = placeholder;
            hint.hidden = true; // shown while empty, hidden from the open list
            native.append(hint);
        }
        for (const item of list) {
            const option = document.createElement("option");
            option.value = String(item.value);
            option.textContent = String(item.label == null ? item.value : item.label);
            if (item.disabled) option.disabled = true;
            native.append(option);
        }
    }

    function syncMenu() {
        if (!menu) return;
        for (const row of menu.children) {
            const selected = row.dataset.value === native.value;
            row.classList.toggle("m3-menu-item--selected", selected);
            row.lastElementChild.textContent = selected ? "\u2713" : "";
        }
    }

    function buildRows() {
        const rows = list.map((item) => {
            const row = document.createElement("div");
            row.className = "m3-menu-item";
            row.setAttribute("role", "presentation");
            row.dataset.value = String(item.value);
            if (item.disabled) row.setAttribute("aria-disabled", "true");
            const text = document.createElement("span");
            text.className = "m3-menu-item__label";
            text.textContent = String(item.label == null ? item.value : item.label);
            const mark = document.createElement("span");
            mark.className = "m3-menu-item__icon";
            row.append(text, mark);
            if (!item.disabled) {
                row.addEventListener("click", () => {
                    closeMenu();
                    commit(String(item.value));
                });
            }
            return row;
        });
        menu.replaceChildren(...rows);
        syncMenu();
    }

    function onOutside(event) {
        if (!root.contains(event.target)) closeMenu();
    }

    function onEscape(event) {
        if (event.key !== "Escape") return;
        // Consume it so an enclosing dialog does not close as well.
        event.stopPropagation();
        closeMenu();
    }

    function closeMenu() {
        if (!menu || !menu.isConnected) return;
        menu.remove();
        document.removeEventListener("pointerdown", onOutside, true);
        document.removeEventListener("keydown", onEscape, true);
    }

    function openMenu() {
        if (!menu) {
            menu = document.createElement("div");
            menu.className = "m3-select__menu";
            // The native select is the accessible control; this popup is visual.
            menu.setAttribute("aria-hidden", "true");
            Object.assign(menu.style, {
                position: "absolute",
                left: "0",
                top: "100%",
                minWidth: "100%",
                zIndex: "1",
            });
        }
        root.style.position = "relative";
        buildRows();
        root.append(menu);
        document.addEventListener("pointerdown", onOutside, true);
        document.addEventListener("keydown", onEscape, true);
    }

    /** Single value-change path: mirrors a native selection exactly. */
    function commit(nextValue) {
        if (native.value === nextValue) return;
        fromMenu = true;
        native.value = nextValue;
        native.dispatchEvent(new Event("change", { bubbles: true }));
    }

    native.addEventListener("change", (event) => {
        closeMenu();
        if (fromMenu) {
            fromMenu = false;
            // Sighted users saw a row light up; screen readers get the equivalent.
            const text = labelFor(list, native.value);
            announce(`${label ? `${label}: ` : ""}${text}`, { politeness: "polite" });
        }
        if (typeof onChange === "function") onChange(native.value, event);
    });

    // Mouse-only enhancement; keyboard keeps the native popup.
    if (!supportsBaseSelect()) {
        root.addEventListener("mousedown", (event) => {
            if (event.button !== 0 || native.disabled) return;
            if (event.target instanceof Element && event.target.closest(".m3-select__menu")) return;
            event.preventDefault();
            openMenu();
        });
    }

    setOptions(options);
    if (value != null) native.value = String(value);

    return {
        root,
        native,
        getValue: () => native.value,
        setValue(v) {
            native.value = v == null ? "" : String(v);
            syncMenu();
        },
        setOptions,
        setDisabled(flag) {
            native.disabled = Boolean(flag);
            if (native.disabled) closeMenu();
        },
    };
}
