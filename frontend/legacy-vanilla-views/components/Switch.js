/**
 * Switch.js — M3 switch built on a real checkbox with role="switch".
 * The <label> wrapper is the visible label, so no extra text node is needed.
 */
let uid = 0;

export function createSwitch({ label, checked = false, disabled = false, id, onChange } = {}) {
    uid += 1;
    const inputId = id || `nu-switch-${uid}`;

    const root = document.createElement("label");
    root.className = "m3-switch";
    root.setAttribute("for", inputId);

    const input = document.createElement("input");
    input.type = "checkbox";
    input.className = "m3-switch__input";
    input.id = inputId;
    input.setAttribute("role", "switch");
    input.checked = Boolean(checked);
    input.setAttribute("aria-checked", String(Boolean(checked)));

    const track = document.createElement("span");
    track.className = "m3-switch__track";
    const thumb = document.createElement("span");
    thumb.className = "m3-switch__thumb";
    root.append(input, track, thumb);

    if (label) {
        // No frozen class for the switch label: plain text inside the <label>.
        const text = document.createElement("span");
        text.textContent = label;
        root.append(text);
    }

    // A checkbox input does not reflect .checked into aria-checked on its own.
    input.addEventListener("change", (event) => {
        input.setAttribute("aria-checked", String(input.checked));
        if (typeof onChange === "function") onChange(input.checked, event);
    });

    input.disabled = Boolean(disabled);

    return {
        root,
        input,
        isChecked: () => input.checked,
        setChecked(flag) {
            input.checked = Boolean(flag);
            input.setAttribute("aria-checked", String(input.checked));
        },
    };
}
