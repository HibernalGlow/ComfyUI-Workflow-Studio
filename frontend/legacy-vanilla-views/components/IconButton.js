/**
 * IconButton.js — M3 icon button factory. Always a real <button> with an
 * accessible name (`ariaLabel`), toggle state exposed through aria-pressed.
 */
import { attachRipple } from "../ripple.js";

const VARIANTS = ["standard", "filled", "tonal", "outlined"];

/** SVG markup is injected; anything else is text. See components/Button.js. */
function setIconContent(host, icon) {
    if (icon == null) return;
    if (/<[a-z]/i.test(icon)) host.innerHTML = icon;
    else host.textContent = String(icon);
}

export function createIconButton({
    icon,
    ariaLabel,
    variant = "standard",
    disabled = false,
    title,
    onClick,
    toggle = false,
    pressed = false,
} = {}) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `m3-icon-btn m3-icon-btn--${VARIANTS.includes(variant) ? variant : "standard"}`;
    // No frozen inner part for the icon button: the glyph sits directly inside.
    const name = ariaLabel || title;
    if (name) button.setAttribute("aria-label", name);
    if (title) button.title = title;
    if (toggle) button.setAttribute("aria-pressed", String(Boolean(pressed)));
    setIconContent(button, icon);

    button.disabled = Boolean(disabled);
    if (typeof onClick === "function") {
        button.addEventListener("click", (event) => {
            if (button.disabled) return;
            let next;
            if (toggle) {
                next = button.getAttribute("aria-pressed") !== "true";
                button.setAttribute("aria-pressed", String(next));
            }
            onClick(event, next);
        });
    }
    attachRipple(button, { disabled: button.disabled });
    return button;
}
