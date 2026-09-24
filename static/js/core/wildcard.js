/**
 * core/wildcard.js — `__name__` wildcard expansion.
 *
 * Port of generate-tab.js `_wcLineCache` (L1410), `_fetchWildcardLines` (L1412-1429),
 * `_expandWildcardText` (L1431-1452), `_IMPACT_WC_TYPES` (L1454) and
 * `_expandWildcardsInWorkflow` (L1456-1479) minus DOM. Only two things changed:
 *  - the request goes through ./api.js instead of a bare fetch (which also appended `.txt`);
 *  - the RNG is injectable (spec §20.8) so the picked line can be pinned in tests.
 *
 * Expansion semantics are kept verbatim: at most 5 passes, pattern `/__([^_\s][^_]*)__/g`,
 * one random line per match, an unknown name is left in the text (a match without lines does
 * not count as "changed", so the pass loop stops), Impact nodes are skipped entirely, and a
 * workflow with no token at all is returned as the SAME object (upstream fast path).
 *
 * Requires from ./api.js: getWildcardContent(filenameWithExtension) -> content string | null
 */

import * as api from "./api.js";

/** Impact packs expand wildcards server-side, so their inputs must stay untouched. */
export const IMPACT_WILDCARD_TYPES = new Set(["ImpactWildcardEncode", "ImpactWildcardProcessor"]);

/** Wildcard files are addressed as `<name><EXT>` (upstream appended it at the request). */
const FILE_EXT = ".txt";
const MAX_PASSES = 5;

/**
 * name -> string[] | null. `null` caches a negative lookup (missing file / empty list / failed
 * request) so a bad name is never retried. Upstream never cleared this cache.
 */
const lineCache = new Map();

/** `__name__`: at least one non-underscore, non-space char; underscores are not allowed inside. */
function tokenRegex() {
    return /__([^_\s][^_]*)__/g;
}

function hasToken(value) {
    return typeof value === "string" && /__[^_\s][^_]*__/.test(value);
}

/**
 * Drop one cached wildcard, or the whole cache when called without a name.
 * Upstream had no invalidation path; the wildcard editor can call this after a save.
 * @param {string|null} [name]
 */
export function clearWildcardCache(name = null) {
    if (name === null) lineCache.clear();
    else lineCache.delete(name);
}

/**
 * Lines of one wildcard file: trimmed, blanks and `#` comments dropped.
 * @param {string} name wildcard name without extension
 * @returns {Promise<string[]|null>} null for missing / empty / failed lookups
 */
export async function fetchWildcardLines(name) {
    if (lineCache.has(name)) return lineCache.get(name);
    try {
        // api.js resolves a missing file to null (404) and rethrows anything else.
        const content = await api.getWildcardContent(`${name}${FILE_EXT}`);
        const lines = String(content || "")
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line && !line.startsWith("#"));
        const result = lines.length > 0 ? lines : null;
        lineCache.set(name, result);
        return result;
    } catch {
        lineCache.set(name, null);
        return null;
    }
}

/**
 * Replace every `__name__` with one random line of that wildcard, repeatedly (nested wildcards
 * need a further pass), up to 5 passes.
 * @param {string} text
 * @param {{random?:() => number}} [opts] RNG returning [0,1); defaults to Math.random
 * @returns {Promise<string>}
 */
export async function expandWildcardText(text, { random = Math.random } = {}) {
    for (let pass = 0; pass < MAX_PASSES; pass++) {
        const matches = [...text.matchAll(tokenRegex())];
        if (matches.length === 0) break;
        let changed = false;
        let offset = 0;
        let result = text;
        for (const match of matches) {
            const lines = await fetchWildcardLines(match[1]);
            if (lines) {
                const replacement = lines[Math.floor(random() * lines.length)];
                const pos = match.index + offset;
                result = result.slice(0, pos) + replacement + result.slice(pos + match[0].length);
                offset += replacement.length - match[0].length;
                changed = true;
            }
        }
        if (!changed) break;
        text = result;
    }
    return text;
}

/** Fast pre-scan: does any non-Impact node carry a `__name__` string input? */
export function workflowUsesWildcards(workflow) {
    for (const node of Object.values(workflow || {})) {
        if (IMPACT_WILDCARD_TYPES.has(node?.class_type)) continue;
        for (const value of Object.values(node?.inputs || {})) {
            if (hasToken(value)) return true;
        }
    }
    return false;
}

/**
 * Expand every string input of every non-Impact node.
 * @param {object} workflow API-format workflow
 * @param {{random?:() => number}} [opts]
 * @returns {Promise<object>} the input object unchanged when nothing needs expanding,
 *                            otherwise a deep-cloned, expanded workflow
 */
export async function expandWildcardsInWorkflow(workflow, opts = {}) {
    if (!workflowUsesWildcards(workflow)) return workflow;

    const expanded = JSON.parse(JSON.stringify(workflow));
    for (const node of Object.values(expanded)) {
        if (IMPACT_WILDCARD_TYPES.has(node?.class_type)) continue;
        for (const [key, value] of Object.entries(node?.inputs || {})) {
            if (hasToken(value)) node.inputs[key] = await expandWildcardText(value, opts);
        }
    }
    return expanded;
}
