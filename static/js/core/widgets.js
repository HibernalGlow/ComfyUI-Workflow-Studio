/**
 * core/widgets.js — per-input widget metadata from ComfyUI's `/object_info`.
 *
 * Pure functions over an `objectInfo` snapshot: the caller fetches it
 * (`comfyUI.fetchAllObjectInfo()`, owned by core/client.js) and keeps it in view state,
 * so this module stays stateless like the rest of core/.
 *
 * The type-resolution rules here mirror upstream `comfyui-workflow.js`
 * (`_resolveWidgetType`, `_getWidgetInputNames`) on purpose, including the two bug
 * classes that file documents:
 *   - a MultiType declaration such as `"FLOAT,INT"` occupies ONE widget slot, so the
 *     first widget-typed segment wins (exact-match on "INT" would drop the input and
 *     shift every widget after it out of schema order);
 *   - `forceInput: true` means "link-only socket whose type happens to be a widget
 *     type" and must never be rendered as a field.
 * Upstream's versions are module-private, so they cannot be called; if upstream changes
 * these rules, diff this file against it.
 */

/** Scalar widget types `/object_info` may declare for a required/optional input. */
const WIDGET_TYPES = new Set(["INT", "FLOAT", "STRING", "BOOLEAN", "COMBO", "COMFY_DYNAMICCOMBO_V3"]);

/**
 * Resolve the declared type of one input to a widget kind.
 * @returns {"INT"|"FLOAT"|"STRING"|"BOOLEAN"|"COMBO"|"COMFY_DYNAMICCOMBO_V3"|null}
 *          null for link-only inputs (MODEL/CLIP/LATENT/…) and unrecognised specs.
 */
export function widgetKindOf(declared) {
    if (Array.isArray(declared)) return "COMBO";
    if (typeof declared !== "string") return null;
    const explicit = declared.toUpperCase();
    if (WIDGET_TYPES.has(explicit)) return explicit;
    for (const part of declared.split(",")) {
        const upper = part.trim().toUpperCase();
        if (WIDGET_TYPES.has(upper)) return upper;
    }
    return null;
}

/** `[type, spec]` is the common form; a bare `"type"` string is also legal. */
function splitSpec(raw) {
    if (Array.isArray(raw)) return [raw[0], raw[1] && typeof raw[1] === "object" ? raw[1] : {}];
    return [raw, {}];
}

/**
 * Ordered widget input names for a node class (required first, then optional) —
 * the schema order the widgets occupy.
 * @returns {string[]}
 */
export function widgetNames(objectInfo, classType) {
    const info = objectInfo?.[classType];
    if (!info?.input) return [];
    const names = [];
    for (const group of [info.input.required, info.input.optional]) {
        for (const [name, raw] of Object.entries(group || {})) {
            const [declared, spec] = splitSpec(raw);
            if (spec.forceInput) continue;
            if (widgetKindOf(declared) === null) continue;
            names.push(name);
        }
    }
    return names;
}

/**
 * @typedef {{kind:"int"|"float"|"string"|"boolean"|"combo", min:?number, max:?number,
 *            step:?number, default:*, options:?string[], multiline:boolean,
 *            label:string|null}} InputSpec
 */

/**
 * Constraints for one input of one node class.
 * @returns {InputSpec|null} null when the class or the input is unknown, or when it is
 *          a link-only socket — callers then fall back to the raw workflow value.
 */
export function inputSpec(objectInfo, classType, name) {
    const info = objectInfo?.[classType];
    if (!info?.input) return null;
    const raw = info.input.required?.[name] ?? info.input.optional?.[name];
    if (raw === undefined) return null;
    const [declared, spec] = splitSpec(raw);
    if (spec.forceInput) return null;

    // A MultiType spec carries an explicit widgetType hint that outranks the type string.
    const hinted = typeof spec.widgetType === "string" ? widgetKindOf(spec.widgetType) : null;
    const kind = hinted ?? widgetKindOf(declared);
    if (kind === null) return null;

    if (kind === "COMBO" || kind === "COMFY_DYNAMICCOMBO_V3") {
        const options = Array.isArray(declared)
            ? declared.map(String)
            : Array.isArray(spec.options)
                ? spec.options.map(String)
                : null;
        return {
            kind: "combo",
            min: null, max: null, step: null,
            default: typeof spec.default === "string" ? spec.default : options?.[0] ?? null,
            options,
            multiline: false,
            label: spec.label ?? null,
        };
    }

    if (kind === "BOOLEAN") {
        return { kind: "boolean", min: null, max: null, step: null, default: spec.default === true, options: null, multiline: false, label: spec.label ?? null };
    }

    if (kind === "STRING") {
        return {
            kind: "string", min: null, max: null, step: null,
            default: typeof spec.default === "string" ? spec.default : "",
            options: null,
            multiline: spec.multiline === true,
            label: spec.label ?? null,
        };
    }

    // INT / FLOAT. `max` is required by ComfyUI's own range spec; `min` defaults to 0.
    const isFloat = kind === "FLOAT";
    return {
        kind: isFloat ? "float" : "int",
        min: Number.isFinite(spec.min) ? spec.min : null,
        max: Number.isFinite(spec.max) ? spec.max : null,
        step: Number.isFinite(spec.step) ? spec.step : isFloat ? 0.1 : 1,
        default: Number.isFinite(spec.default) ? spec.default : null,
        options: null,
        multiline: false,
        label: spec.label ?? null,
    };
}
