/**
 * views/workflow/form.js — generic node-input parameter form (parity table item 1).
 *
 * The form is built from the workflow's API format only (`comfyWorkflow.getAllNodes` gives the
 * node order/titles, `node.inputs` the live values) plus ComfyUI's `/object_info` for the input
 * *specs* (type, min/max/step, combo choices) — exactly the inputs the old editor exposed, but
 * without any of its per-node-class special cases.
 *
 * Field choice per spec (upstream `comfyEditor.renderSettingsTab` used the same widgets):
 *   combo ([a,b,c] or ["COMBO",{values|options}]) -> Select
 *   INT / FLOAT with a small finite range          -> Slider   (else a number TextField)
 *   BOOLEAN                                        -> Switch
 *   STRING with multiline                          -> multiline TextField
 *   anything else / unknown node class             -> TextField (text or number)
 *
 * A linked input (an array value, e.g. `["12", 0]`) is never editable: it is rendered as a plain
 * "linked" note, so a form save can not silently turn a link into a literal.
 *
 * No request is made on the first paint: specs are fetched per class type in the background and
 * the affected section is filled in when they arrive (UI thread never blocks, nothing awaited).
 */

import { comfyUI, comfyWorkflow, t } from "../../core/index.js";
import { createTextField } from "../../components/TextField.js";
import { createSelect } from "../../components/Select.js";
import { createSlider } from "../../components/Slider.js";
import { createSwitch } from "../../components/Switch.js";

/** Which spec keys / combos a node input exposes are the same for every workflow: cache them. */
const specCache = new Map();
const pendingSpecs = new Map();

function tr(key, fallback) {
    const value = t(key);
    return value !== undefined && value !== null && value !== key ? String(value) : fallback;
}

/**
 * Normalise one `object_info` input definition.
 * Handles the three shapes the client already knows: V1 `[["a","b"],{}]` (legacy COMBO) and
 * V2/V3 `["COMBO",{values|options}]`, plus the scalar types.
 * @returns {{kind:'combo'|'int'|'float'|'boolean'|'string'|'text', options?:string[],
 *            min?:number, max?:number, step?:number, multiline?:boolean}}
 */
export function inputSpec(definition) {
    if (!Array.isArray(definition)) return { kind: "text" };
    const [type, options = {}] = definition;
    const opts = options && typeof options === "object" ? options : {};

    if (Array.isArray(type)) return { kind: "combo", options: type.map(String) };

    const name = String(type || "");
    if (name === "COMBO") {
        const choices = opts.values || opts.options || [];
        return { kind: "combo", options: choices.map(String) };
    }
    if (name === "INT") {
        return { kind: "int", min: opts.min, max: opts.max, step: opts.step ?? 1 };
    }
    if (name === "FLOAT") {
        return { kind: "float", min: opts.min, max: opts.max, step: opts.step ?? 0.01 };
    }
    if (name === "BOOLEAN") return { kind: "boolean" };
    if (name === "STRING") return { kind: "string", multiline: opts.multiline === true };
    return { kind: "text" };
}

/** The part of `object_info[classType].input` we need, or null when unknown. */
function specOf(objectInfo, classType) {
    const entry = objectInfo?.[classType]?.input;
    if (!entry) return null;
    return { ...(entry.required || {}), ...(entry.optional || {}) };
}

/** Load + cache the required/optional input definitions of one node class. */
function loadSpec(classType) {
    if (specCache.has(classType)) return Promise.resolve(specCache.get(classType));
    if (pendingSpecs.has(classType)) return pendingSpecs.get(classType);
    const request = comfyUI
        .fetchObjectInfo(classType)
        .then((info) => {
            const spec = specOf(info, classType);
            specCache.set(classType, spec);
            return spec;
        })
        .catch(() => {
            specCache.set(classType, null); // unknown class: fields fall back to plain text
            return null;
        })
        .finally(() => pendingSpecs.delete(classType));
    pendingSpecs.set(classType, request);
    return request;
}

/** A numeric field is only worth a slider when the range is small enough to be draggable. */
function sliderRange(spec) {
    const min = Number(spec.min);
    const max = Number(spec.max);
    const step = Number(spec.step) || 1;
    if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return null;
    if (step <= 0) return null;
    if (max - min > 200) return null;
    if ((max - min) / step > 2000) return null;
    return { min, max, step };
}

function isLinked(value) {
    return Array.isArray(value);
}

function linkLabel(value) {
    const source = Array.isArray(value) ? value[0] : "";
    return tr("linked", "linked") + (source ? ` → ${source}` : "");
}

/** True when the node has at least one editable (non-link) input. */
export function hasWidgetInputs(node) {
    return Object.values(node?.inputs || {}).some((value) => !isLinked(value));
}

function row(label, control, hint) {
    const field = document.createElement("div");
    field.className = "nu-field";
    if (control.id) {
        const caption = document.createElement("label");
        caption.className = "nu-field__label";
        caption.setAttribute("for", control.id);
        caption.textContent = label;
        field.append(caption, control);
    } else {
        const caption = document.createElement("span");
        caption.className = "nu-field__label";
        caption.textContent = label;
        field.append(caption, control);
    }
    if (hint) {
        const note = document.createElement("span");
        note.className = "nu-muted nu-workflow-params__hint";
        note.textContent = hint;
        field.append(note);
    }
    return field;
}

/**
 * One editable control for `nodeId.inputs[key]`.
 * @param {(nodeId:string, key:string, value:any) => void} onWrite
 * @returns {HTMLElement|null} null for values the form can not edit
 */
function createField(nodeId, key, value, spec, onWrite) {
    const commit = (next) => onWrite(nodeId, key, next);

    if (isLinked(value)) {
        const linked = document.createElement("span");
        linked.className = "nu-muted nu-workflow-params__linked";
        linked.textContent = linkLabel(value);
        return row(key, linked);
    }

    if (typeof value === "boolean" || spec.kind === "boolean") {
        const handle = createSwitch({
            label: "",
            checked: Boolean(value),
            onChange: (event) => commit(event.target.checked),
        });
        return row(key, handle.root);
    }

    if (spec.kind === "combo") {
        const options = [...(spec.options || [])];
        const current = value === undefined || value === null ? "" : String(value);
        if (current && !options.includes(current)) options.push(current);
        const handle = createSelect({
            options: options.map((option) => ({ value: option, label: option })),
            value: current,
            placeholder: options.length === 0 ? tr("noChoices", "no choices") : undefined,
            disabled: options.length === 0,
            onChange: (event) => commit(event.target.value),
        });
        return row(key, handle.root);
    }

    if (typeof value === "number" && (spec.kind === "int" || spec.kind === "float" || spec.kind === "unknown")) {
        const range = spec.kind === "text" ? null : sliderRange(spec);
        if (range && Number(value) >= range.min && Number(value) <= range.max) {
            const handle = createSlider({
                label: "",
                min: range.min,
                max: range.max,
                step: range.step,
                value: Number(value),
                onChange: (event) => commit(Number(event.target.value)),
            });
            return row(key, handle.root);
        }
        const handle = createTextField({
            label: "",
            type: "number",
            value: String(value),
            min: spec.min,
            max: spec.max,
            step: spec.step,
            onChange: (event) => {
                const next = Number(event.target.value);
                if (!Number.isNaN(next)) commit(next);
            },
        });
        return row(key, handle.root);
    }

    const multiline = spec.kind === "string" && spec.multiline === true;
    const handle = createTextField({
        label: "",
        type: "text",
        multiline,
        rows: multiline ? 5 : undefined,
        value: value === undefined || value === null ? "" : String(value),
        onInput: (event) => commit(event.target.value),
    });
    return row(key, handle.root);
}

/**
 * Build the whole form.
 *
 * @param {{workflow:object, exclude?:Set<string>, onWrite?:(nodeId:string, key:string, value:any)=>void,
 *          onReady?:()=>void}} options
 *        `exclude` holds `"nodeId::key"` pairs the caller renders elsewhere (the Generate view's
 *        prompt / negative textareas own the prompt nodes' text inputs).
 * @returns {{root:HTMLElement, refresh():void}}
 */
export function createParamForm({ workflow, exclude = null, onWrite = null, onReady = null } = {}) {
    const root = document.createElement("div");
    root.className = "nu-workflow-params";
    let current = workflow;

    function write(nodeId, key, value) {
        const node = current?.[nodeId];
        if (!node?.inputs || !(key in node.inputs)) return;
        node.inputs[key] = value;
        onWrite?.(nodeId, key, value);
    }

    function fillSection(section, node) {
        const body = section.querySelector(".nu-workflow-params__body");
        if (!body) return;
        body.replaceChildren();

        const inputs = node.inputs || {};
        const keys = Object.keys(inputs).sort((a, b) => a.localeCompare(b));
        const widgetKeys = keys.filter(
            (key) => !isLinked(inputs[key]) && !exclude?.has(`${node.id}::${key}`)
        );
        if (widgetKeys.length === 0) {
            const empty = document.createElement("p");
            empty.className = "nu-muted";
            empty.textContent = tr("noEditableInputs", "No editable inputs on this node");
            body.append(empty);
            return;
        }

        loadSpec(node.type).then((spec) => {
            if (!section.isConnected) return; // the view moved on while /object_info was in flight
            const grid = document.createElement("div");
            grid.className = "nu-field-grid";
            for (const key of widgetKeys) {
                const definition = spec?.[key];
                const fieldSpec = definition ? inputSpec(definition) : { kind: "unknown" };
                const field = createField(node.id, key, current[node.id].inputs[key], fieldSpec, write);
                if (field) grid.append(field);
            }
            body.replaceChildren(grid);
            onReady?.();
        });
    }

    function build() {
        root.replaceChildren();
        const nodes = comfyWorkflow.getAllNodes(current || {}).filter(hasWidgetInputs);
        if (nodes.length === 0) {
            const empty = document.createElement("p");
            empty.className = "nu-empty";
            empty.textContent = tr("noParams", "This workflow exposes no editable node inputs");
            root.append(empty);
            return;
        }
        nodes.forEach((node, index) => {
            const section = document.createElement("details");
            section.className = "nu-workflow-params__node";
            section.open = index < 2;
            section.dataset.nodeId = node.id;

            const summary = document.createElement("summary");
            summary.className = "nu-workflow-params__summary";
            const title = document.createElement("span");
            title.className = "nu-workflow-params__title";
            title.textContent = node.title;
            const type = document.createElement("span");
            type.className = "nu-muted nu-workflow-params__type";
            type.textContent = `#${node.id} · ${node.type}`;
            summary.append(title, type);

            const body = document.createElement("div");
            body.className = "nu-workflow-params__body";
            section.append(summary, body);
            root.append(section);
            fillSection(section, node);
        });
    }

    build();

    return {
        root,
        /** Re-render against the current workflow object (values changed elsewhere). */
        refresh(next = null) {
            if (next) current = next;
            build();
        },
    };
}
