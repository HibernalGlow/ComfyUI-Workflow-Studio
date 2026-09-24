/**
 * Button.js — M3 button factory.
 * @returns {HTMLButtonElement} detached node; the caller mounts it.
 */
import { attachRipple } from "../ripple.js";

const VARIANTS = ["filled", "tonal", "outlined", "text", "elevated"];

/**
 * `icon` is the one place user-supplied markup is allowed: SVG strings are
 * injected, anything else becomes text (so a glyph can never inject elements).
 * Kept local to every component that renders an icon — no extra shared module.
 */
function setIconContent(host, icon) {
    if (icon == null) return;
    if (/<[a-z]/i.test(icon)) host.innerHTML = icon;
    else host.textContent = String(icon);
}

export function createButton({
    label,
    variant = "filled",
    icon,
    disabled = false,
    type = "button",
    ariaLabel,
    title,
    onClick,
    fullWidth = false,
} = {}) {
    const button = document.createElement("button");
    button.type = type;
    button.className = `m3-btn m3-btn--${VARIANTS.includes(variant) ? variant : "filled"}`;
    if (fullWidth) button.style.width = "100%"; // no frozen full-width modifier
    if (title) button.title = title;
    if (ariaLabel) button.setAttribute("aria-label", ariaLabel);

    if (icon != null) {
        const slot = document.createElement("span");
        slot.className = "m3-btn__icon";
        slot.setAttribute("aria-hidden", "true");
        setIconContent(slot, icon);
        button.append(slot);
    }
    if (label != null) {
        const text = document.createElement("span");
        text.className = "m3-btn__label";
        text.textContent = String(label);
        button.append(text);
    }

    button.disabled = Boolean(disabled);
    if (typeof onClick === "function") {
        button.addEventListener("click", (event) => {
            if (button.disabled) return;
            onClick(event);
        });
    }
    attachRipple(button, { disabled: button.disabled });
    return button;
}
