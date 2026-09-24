/**
 * Chip.js — M3 chips. State lives on the button itself (aria-pressed plus the
 * frozen `.m3-chip--selected` class) so assist/suggestion chips stay plain
 * actions while filter/input chips toggle.
 */
import { attachRipple } from "../ripple.js";

const VARIANTS = ["filter", "assist", "input", "suggestion"];

/** SVG markup is injected; anything else is text. See components/Button.js. */
function setIconContent(host, icon) {
    if (icon == null) return;
    if (/<[a-z]/i.test(icon)) host.innerHTML = icon;
    else host.textContent = String(icon);
}

export function createChip({
    label,
    variant = "filter",
    selected = false,
    icon,
    disabled = false,
    onToggle,
    onClick,
    onRemove,
} = {}) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = `m3-chip m3-chip--${VARIANTS.includes(variant) ? variant : "filter"}`;
    const selectable = typeof onToggle === "function" || variant === "filter" || variant === "input";

    if (icon != null) {
        const slot = document.createElement("span");
        slot.setAttribute("aria-hidden", "true");
        setIconContent(slot, icon);
        chip.append(slot);
    }
    const text = document.createElement("span");
    text.textContent = label == null ? "" : String(label);
    chip.append(text);

    let on = Boolean(selected);
    function applySelected(flag) {
        on = Boolean(flag);
        chip.classList.toggle("m3-chip--selected", on);
        if (selectable) chip.setAttribute("aria-pressed", String(on));
    }
    applySelected(on);

    let removeAffordance = null;
    if (typeof onRemove === "function") {
        // A nested <button> would be invalid inside a button, so the trailing
        // glyph is decorative: Delete/Backspace on the focused chip removes it.
        removeAffordance = document.createElement("span");
        removeAffordance.setAttribute("aria-hidden", "true");
        removeAffordance.textContent = "\u2715";
        chip.setAttribute("aria-keyshortcuts", "Delete Backspace");
        chip.append(removeAffordance);
    }

    chip.addEventListener("click", (event) => {
        if (chip.disabled) return;
        if (removeAffordance && removeAffordance.contains(event.target)) {
            onRemove(event);
            return;
        }
        if (selectable) {
            applySelected(!on);
            if (typeof onToggle === "function") onToggle(on, event);
        }
        if (typeof onClick === "function") onClick(event);
    });

    if (removeAffordance) {
        chip.addEventListener("keydown", (event) => {
            if (event.key !== "Delete" && event.key !== "Backspace") return;
            event.preventDefault();
            onRemove(event);
        });
    }

    chip.disabled = Boolean(disabled);
    attachRipple(chip, { disabled: chip.disabled });

    return {
        root: chip,
        isSelected: () => on,
        setSelected: applySelected,
        setLabel(value) {
            text.textContent = value == null ? "" : String(value);
        },
    };
}
