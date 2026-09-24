/**
 * Checkbox.js — M3 checkbox: real <input type="checkbox"> + visible label
 * bound with for/id, three states exposed through the indeterminate flag.
 */
let uid = 0;

export function createCheckbox({
    label,
    checked = false,
    indeterminate = false,
    disabled = false,
    id,
    onChange,
} = {}) {
    uid += 1;
    const inputId = id || `nu-checkbox-${uid}`;

    const root = document.createElement("label");
    root.className = "m3-checkbox";
    root.setAttribute("for", inputId);

    const input = document.createElement("input");
    input.type = "checkbox";
    input.className = "m3-checkbox__input";
    input.id = inputId;
    input.checked = Boolean(checked);
    input.indeterminate = Boolean(indeterminate);
    if (input.indeterminate) input.setAttribute("aria-checked", "mixed");

    const box = document.createElement("span");
    box.className = "m3-checkbox__box";
    box.setAttribute("aria-hidden", "true");
    const text = document.createElement("span");
    text.className = "m3-checkbox__label";
    text.textContent = label == null ? "" : String(label);
    root.append(input, box, text);

    function syncAria() {
        if (input.indeterminate) input.setAttribute("aria-checked", "mixed");
        else input.removeAttribute("aria-checked");
    }

    input.addEventListener("change", (event) => {
        // Activating the box always clears the mixed state.
        if (input.indeterminate) {
            input.indeterminate = false;
            syncAria();
        }
        if (typeof onChange === "function") onChange(input.checked, event);
    });

    input.disabled = Boolean(disabled);

    return {
        root,
        input,
        isChecked: () => input.checked,
        setChecked(flag) {
            input.checked = Boolean(flag);
            input.indeterminate = false;
            syncAria();
        },
        setIndeterminate(flag) {
            input.indeterminate = Boolean(flag);
            syncAria();
        },
    };
}
