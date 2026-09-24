/**
 * core/style.js — Fooocus-style prompt styles.
 *
 * Port of generate-tab.js `_loadStyles` (L1297-1305), `refreshStylesList` (L1309-1311),
 * `_applyNamedStyle` (L1356-1391) and `_applyStyleToWorkflow` (L1393-1403) minus DOM:
 *  - the two DOM reads (`#wfm-style-enabled`, `#wfm-style-select`) become `enabled` / `styleName`;
 *  - the `_batchStyleOverride` module variable becomes an explicit `style` argument, and it keeps
 *    upstream's precedence (an override wins even when the checkbox is off);
 *  - `comfyUI.currentAnalysis` becomes the `analysis` argument, so the module stays stateless.
 *
 * `_stylesData` had no other owner upstream, so the catalog is cached here: `resolveStyleByName`
 * needs it to answer the pipeline, `fetchStyles()` replaces it and `setCachedStyles()` lets a view
 * that already holds the list prime it (batch style runs do exactly that).
 *
 * Requires from ./api.js: listStyles() -> [{name, prompt, negative_prompt, file}]
 */

import * as api from "./api.js";

/** Last successfully loaded catalog (upstream `_stylesData`); null = never loaded. */
let stylesCache = null;

/**
 * Load the catalog. Any failure degrades to an empty list, like upstream.
 * The dropdown / batch-pane re-renders upstream did here belong to the view.
 * @returns {Promise<Array>}
 */
export async function fetchStyles() {
    try {
        const list = await api.listStyles();
        stylesCache = Array.isArray(list) ? list : [];
    } catch {
        stylesCache = [];
    }
    return stylesCache;
}

/** Upstream exported this facade for the Prompt tab's style editor. */
export async function refreshStylesList() {
    return fetchStyles();
}

/** The cached catalog; `[]` before the first `fetchStyles()` call. */
export function getCachedStyles() {
    return stylesCache || [];
}

/** Prime the cache with a list the caller already loaded (equivalent of `_stylesData = list`). */
export function setCachedStyles(styles) {
    stylesCache = Array.isArray(styles) ? styles : [];
    return stylesCache;
}

/** Pure lookup (upstream `_stylesData.find(...)`). */
export function findStyle(styles, name) {
    if (!Array.isArray(styles) || !name) return null;
    return styles.find((style) => style.name === name) || null;
}

/**
 * Resolve a style name to a record, loading the catalog once when it is not cached yet.
 * @param {string} name
 * @returns {Promise<object|null>}
 */
export async function resolveStyleByName(name) {
    if (!name) return null;
    if (!stylesCache) await fetchStyles();
    return findStyle(stylesCache, name);
}

/**
 * Apply one style record to a workflow (verbatim port of `_applyNamedStyle`).
 * Positive nodes substitute the literal `{prompt}` with the node's text, otherwise the style
 * prompt is appended; negative nodes always append.
 * @param {object} workflow API-format workflow (never mutated)
 * @param {{prompt?:string, negative_prompt?:string}|null} style
 * @param {{prompt_nodes?:Array<{id:string, role:string, textKey?:string}>}|null} analysis
 * @returns {object} a deep-cloned styled workflow, or the input when style/analysis is missing
 */
export function applyNamedStyle(workflow, style, analysis) {
    if (!style) return workflow;
    if (!analysis) return workflow;

    const positiveNodes = (analysis.prompt_nodes || []).filter((node) => node.role === "positive");
    const negativeNodes = (analysis.prompt_nodes || []).filter((node) => node.role === "negative");

    const result = JSON.parse(JSON.stringify(workflow));

    if (style.prompt) {
        for (const node of positiveNodes) {
            const nodeData = result[node.id];
            if (!nodeData) continue;
            const key = node.textKey || "text";
            const original = nodeData.inputs[key] || "";
            nodeData.inputs[key] = style.prompt.includes("{prompt}")
                ? style.prompt.replace("{prompt}", original)
                : original ? `${original}, ${style.prompt}` : style.prompt;
        }
    }

    if (style.negative_prompt) {
        for (const node of negativeNodes) {
            const nodeData = result[node.id];
            if (!nodeData) continue;
            const key = node.textKey || "text";
            const original = nodeData.inputs[key] || "";
            nodeData.inputs[key] = original
                ? `${original}, ${style.negative_prompt}`
                : style.negative_prompt;
        }
    }

    return result;
}

/**
 * Port of `_applyStyleToWorkflow`: decide whether a style applies and apply it.
 * Always returns the input workflow unchanged when nothing applies; a new object otherwise.
 *
 * @param {object} workflow
 * @param {{
 *   enabled?:boolean,          // upstream `#wfm-style-enabled`
 *   style?:object|null,        // upstream `_batchStyleOverride` (wins over styleName)
 *   styleName?:string,         // upstream `#wfm-style-select` value
 *   styles?:Array,             // catalog to resolve styleName against (defaults to the cache)
 *   analysis?:object|null,     // upstream comfyUI.currentAnalysis
 * }} [options]
 * @returns {object}
 */
export function applyStyleToWorkflow(workflow, options = {}) {
    const {
        enabled = true,
        style = null,
        styleName = "",
        styles = null,
        analysis = null,
    } = options;

    if (style) return applyNamedStyle(workflow, style, analysis);
    if (!enabled) return workflow;
    return applyNamedStyle(workflow, findStyle(styles || stylesCache, styleName), analysis);
}
