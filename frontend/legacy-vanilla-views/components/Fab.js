/**
 * Fab.js — M3 floating action button. Passing `label` selects the extended
 * variant (icon + text); small/large change only the container size.
 */
import { attachRipple } from "../ripple.js";

const SIZES = ["small", "regular", "large"];

/** SVG markup is injected; anything else is text. See components/Button.js. */
function setIconContent(host, icon) {
    if (icon == null) return;
    if (/<[a-z]/i.test(icon)) host.innerHTML = icon;
    else host.textContent = String(icon);
}

export function createFab({ icon, label, size = "regular", ariaLabel, disabled = false, onClick } = {}) {
    const button = document.createElement("button");
    button.type = "button";
    const sizeClass = SIZES.includes(size) && size !== "regular" ? ` m3-fab--${size}` : "";
    button.className = `m3-fab${sizeClass}${label != null ? " m3-fab--extended" : ""}`;
    if (ariaLabel) button.setAttribute("aria-label", ariaLabel);
    else if (label != null) button.setAttribute("aria-label", String(label));

    setIconContent(button, icon);
    if (label != null) {
        // Fab has no frozen inner part names; a plain span lets CSS target the label.
        const text = document.createElement("span");
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
