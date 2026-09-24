/**
 * TextField.js — M3 text field (outlined by default, filled on request).
 *
 * The label is a real <label for> bound to the control, error state is exposed
 * through aria-invalid + the supporting text (wired with aria-describedby).
 */
let uid = 0;
function nextId() {
    uid += 1;
    return `nu-text-field-${uid}`;
}

/** SVG markup is injected; anything else is text. See components/Button.js. */
function setIconContent(host, icon) {
    if (icon == null) return;
    if (/<[a-z]/i.test(icon)) host.innerHTML = icon;
    else host.textContent = String(icon);
}

function iconSlot(className, icon) {
    const slot = document.createElement("span");
    slot.className = className;
    slot.setAttribute("aria-hidden", "true");
    setIconContent(slot, icon);
    return slot;
}

export function createTextField({
    label,
    value = "",
    type = "text",
    placeholder,
    supportingText,
    error,
    disabled = false,
    outlined = true,
    leadingIcon,
    trailingIcon,
    name,
    id,
    min,
    max,
    step,
    multiline = false,
    rows = 3,
    onChange,
    onInput,
    onBlur,
} = {}) {
    const fieldId = id || nextId();
    const root = document.createElement("div");
    root.className = `m3-text-field m3-text-field--${outlined ? "outlined" : "filled"}`;

    const field = document.createElement("div");
    field.className = "m3-text-field__field";
    if (leadingIcon != null) field.append(iconSlot("m3-text-field__leading-icon", leadingIcon));

    const control = document.createElement(multiline ? "textarea" : "input");
    // No class: the freeze styles `.m3-text-field__field > input`.
    control.id = fieldId;
    if (multiline) control.rows = rows;
    else control.type = type;
    if (name) control.name = name;
    for (const [key, val] of [["min", min], ["max", max], ["step", step]]) {
        if (val != null) control.setAttribute(key, String(val));
    }
    if (placeholder) control.placeholder = placeholder;
    // A single space keeps :placeholder-shown usable for the floating label.
    else control.placeholder = " ";
    control.value = value == null ? "" : String(value);
    field.append(control);

    if (label) {
        const caption = document.createElement("label");
        caption.className = "m3-text-field__label";
        caption.setAttribute("for", fieldId);
        caption.textContent = label;
        field.append(caption);
    } else if (placeholder) {
        // Never leave a control without an accessible name.
        control.setAttribute("aria-label", placeholder);
    }
    if (trailingIcon != null) field.append(iconSlot("m3-text-field__trailing-icon", trailingIcon));
    root.append(field);

    let support = null;
    let supportId = null;
    function renderSupport() {
        const text = error || supportingText;
        if (!text) {
            if (support) support.hidden = true;
            return;
        }
        if (!support) {
            support = document.createElement("div");
            support.className = "m3-text-field__supporting-text";
            supportId = `${fieldId}-support`;
            support.id = supportId;
            root.append(support);
            control.setAttribute("aria-describedby", supportId);
        }
        support.hidden = false;
        support.textContent = String(text);
    }

    const handle = {
        root,
        input: control,
        getValue: () => control.value,
        setValue(v) { control.value = v == null ? "" : String(v); },
        setError(message) {
            error = message || null;
            root.classList.toggle("m3-text-field--error", Boolean(error));
            if (error) control.setAttribute("aria-invalid", "true");
            else control.removeAttribute("aria-invalid");
            renderSupport();
        },
        setSupportingText(text) {
            supportingText = text || null;
            renderSupport();
        },
        setDisabled(flag) {
            control.disabled = Boolean(flag);
        },
    };

    if (typeof onInput === "function") control.addEventListener("input", onInput);
    if (typeof onChange === "function") control.addEventListener("change", onChange);
    if (typeof onBlur === "function") control.addEventListener("blur", onBlur);

    control.disabled = Boolean(disabled);
    handle.setError(error);
    if (supportingText) renderSupport();
    return handle;
}
