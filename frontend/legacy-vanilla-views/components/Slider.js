/**
 * Slider.js — M3 slider around a real <input type="range">.
 *
 * The input stays the interactive element (native keyboard support); the frozen
 * `.m3-slider__track` / `.m3-slider__handle` children are purely presentational
 * and get the fill position inline, since CSS cannot read the current value.
 */
let uid = 0;

/** Keeps float steps from turning into 0.30000000000000004 in the readout. */
function format(value, step) {
    const decimals = String(step).includes(".") ? String(step).split(".")[1].length : 0;
    return decimals ? value.toFixed(Math.min(decimals, 6)).replace(/\.?0+$/, "") : String(value);
}

export function createSlider({
    label,
    min = 0,
    max = 100,
    step = 1,
    value = 0,
    disabled = false,
    showValue = true,
    onChange,
    onInput,
} = {}) {
    uid += 1;
    const inputId = `nu-slider-${uid}`;

    const root = document.createElement("div");
    root.className = "m3-slider";

    let caption = null;
    if (label) {
        caption = document.createElement("label");
        caption.className = "nu-field__label";
        caption.setAttribute("for", inputId);
        caption.textContent = label;
        root.append(caption);
    }

    const input = document.createElement("input");
    input.type = "range";
    input.className = "m3-slider__input";
    input.id = inputId;
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(value);
    root.append(input);

    const track = document.createElement("div");
    track.className = "m3-slider__track";
    track.setAttribute("aria-hidden", "true");
    const handle = document.createElement("div");
    handle.className = "m3-slider__handle";
    handle.setAttribute("aria-hidden", "true");
    root.append(track, handle);

    let readout = null;
    if (showValue) {
        // The number is already exposed through aria-valuetext on the input.
        readout = document.createElement("span");
        readout.className = "nu-muted";
        readout.setAttribute("aria-hidden", "true");
        root.append(readout);
    }

    function paint() {
        const low = Number(input.min);
        const high = Number(input.max);
        const current = Number(input.value);
        const span = high - low;
        const pct = span > 0 ? ((current - low) / span) * 100 : 0;
        // --nu-slider-percent is a geometry hook for the track fill; the handle
        // position is also set directly so a plain `position: absolute` works.
        root.style.setProperty("--nu-slider-percent", `${pct}%`);
        handle.style.left = `${pct}%`;
        const text = format(current, input.step);
        // aria-valuetext carries the formatted (not raw float) value.
        input.setAttribute("aria-valuetext", text);
        if (readout) readout.textContent = text;
    }

    input.addEventListener("input", (event) => {
        paint();
        if (typeof onInput === "function") onInput(Number(input.value), event);
    });
    input.addEventListener("change", (event) => {
        if (typeof onChange === "function") onChange(Number(input.value), event);
    });

    input.disabled = Boolean(disabled);
    paint();

    return {
        root,
        input,
        getValue: () => Number(input.value),
        setValue(v) {
            input.value = String(v);
            paint();
        },
    };
}
