/**
 * Radio.js — M3 radio group. Each option is a real <input type="radio"> with
 * its own visible label; the inputs share one generated name so the browser
 * (and screen readers) treat them as a single group.
 */
let uid = 0;

export function createRadio({ name, options = [], value, onChange } = {}) {
    uid += 1;
    const groupName = name || `nu-radio-group-${uid}`;

    const root = document.createElement("div");
    root.className = "nu-stack"; // frozen layout helper: vertical group
    root.setAttribute("role", "radiogroup");

    const inputs = new Map();
    const list = Array.isArray(options) ? options : [];

    list.forEach((option, index) => {
        const inputId = `${groupName}-${index}`;
        const item = document.createElement("label");
        item.className = "m3-radio";
        item.setAttribute("for", inputId);

        const input = document.createElement("input");
        input.type = "radio";
        input.className = "m3-radio__input";
        input.id = inputId;
        input.name = groupName;
        input.value = String(option.value);
        if (option.disabled) input.disabled = true;
        if (value != null && String(option.value) === String(value)) input.checked = true;

        const circle = document.createElement("span");
        circle.className = "m3-radio__circle";
        circle.setAttribute("aria-hidden", "true");
        const text = document.createElement("span");
        text.className = "m3-radio__label";
        text.textContent = String(option.label == null ? option.value : option.label);
        item.append(input, circle, text);

        input.addEventListener("change", (event) => {
            if (!input.checked) return;
            if (typeof onChange === "function") onChange(input.value, event);
        });

        inputs.set(String(option.value), input);
        root.append(item);
    });

    if (value == null) {
        // Match the browser default so getValue() agrees with what is shown.
        const first = root.querySelector("input:not([disabled])");
        if (first) first.checked = true;
    }

    return {
        root,
        getValue() {
            const checked = root.querySelector("input:checked");
            return checked ? checked.value : null;
        },
        setValue(v) {
            const input = inputs.get(String(v));
            if (input) input.checked = true;
        },
    };
}
