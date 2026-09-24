/**
 * core/lora.js — story storyboard (`LN*.txt`) parsing + matched-LoRA application.
 *
 * Port of prompt-story-lora.js `loadStoryContent` (L120-166), `matchPromptText` (L171-198),
 * `applyMatchedLorasToCurrentWorkflow` (L285-314), the `matchedLoras` mutations hidden inside
 * `renderMatchedLorasList` (L250-280) and the auto-inject site of generate-tab.js `_coreGenerate`
 * (L1508-1528). Everything is promise/pure based:
 *  - the module-level `storyLoraState` singleton is replaced by `createStoryLoraState()` -
 *    the caller owns the state (`{{currentFile, matchedLoras, autoInject, autoTurbo}}`);
 *  - the three DOM write-backs (file badge, `#wfm-prompt-pos-text`, `#wfm-gen-raw-json`) and the
 *    toasts are replaced by return values, so the view decides what to show;
 *  - the parse step IS the server call: `/api/wfm/lora/match` returns `parsed_prompt` (the parsed
 *    `LN*.txt` story text) and `matched_loras` in one response, exactly like upstream used it.
 *
 * Requires from ./api.js:
 *   matchLoras(prompt, {autoTurbo}) -> {matched_loras, parsed_prompt}
 *   applyLoras(workflow, {loras}) -> {success, applied_count, workflow}
 */

import * as api from "./api.js";

/** Defaults of the upstream `storyLoraState` module singleton. */
export function createStoryLoraState(overrides = {}) {
    return {
        matchedLoras: [],
        autoInject: true,
        autoTurbo: true,
        rules: [],
        currentFile: "",
        ...overrides,
    };
}

/** Upstream: `matchedLoras.filter((l) => l.active !== false)`. */
export function activeLoras(loras) {
    return (loras || []).filter((lora) => lora?.active !== false);
}

/** Upstream: `parsed_prompt.positive_prompt || parsed_prompt.raw || <raw text>`. */
export function toPositivePrompt(parsedPrompt, fallbackText = "") {
    return parsedPrompt?.positive_prompt || parsedPrompt?.raw || fallbackText;
}

/**
 * Request body of `/api/wfm/lora/apply`, i.e. the "workflow fragment" handed to the backend.
 * Upstream built this inline both in `_coreGenerate` (auto-inject) and in the manual apply.
 * @param {object} workflow API-format workflow
 * @param {Array} loras matched LoRA records
 * @returns {{workflow:object, active_loras:Array}}
 */
export function buildApplyPayload(workflow, loras) {
    return { workflow, active_loras: activeLoras(loras) };
}

/**
 * Inject the active matched LoRAs into `workflow` (upstream `applyMatchedLorasToCurrentWorkflow`).
 * The caller is responsible for re-analysing the returned workflow: upstream did NOT re-run
 * `analyzeWorkflow` either, so the analysis can be stale right after this call.
 *
 * @param {object} workflow API-format workflow
 * @param {Array} loras matched LoRA records
 * @returns {Promise<{appliedCount:number, workflow:object}>} no request when nothing is active
 */
export async function applyLoras(workflow, loras) {
    const payload = buildApplyPayload(workflow, loras);
    if (payload.active_loras.length === 0) {
        return { appliedCount: 0, workflow };
    }
    const data = await api.applyLoras(workflow, { loras: payload.active_loras });
    return {
        // Caveat (api.js): `applied_count` is the length sent, before the service drops
        // entries whose `active` is not true.
        appliedCount: data?.applied_count ?? payload.active_loras.length,
        workflow: data?.workflow || workflow,
    };
}

/**
 * Parse `content` (an `LN*.txt` story text or a prompt) and match LoRAs
 * (upstream `loadStoryContent`, without the badge / textarea / workflow write-back).
 *
 * @param {string} content raw story text
 * @param {{filename?:string, autoTurbo?:boolean}} [options]
 * @returns {Promise<{filename:string, matchedLoras:Array, parsedPrompt:object|null,
 *                    positivePrompt:string}>} rejects when the request fails
 */
export async function loadStoryContent(content, { filename = "", autoTurbo = true } = {}) {
    const data = await api.matchLoras(content, { autoTurbo });
    const parsedPrompt = data?.parsed_prompt || null;
    return {
        filename,
        matchedLoras: data?.matched_loras || [],
        parsedPrompt,
        positivePrompt: toPositivePrompt(parsedPrompt, content),
    };
}

/**
 * Match LoRAs for already-entered prompt text (upstream `matchPromptText`).
 * Blank input clears the match without a request, like upstream.
 *
 * @param {string} text
 * @param {{autoTurbo?:boolean}} [options]
 * @returns {Promise<{matchedLoras:Array}>} rejects when the request fails
 */
export async function matchLoras(text, { autoTurbo = true } = {}) {
    if (!text || !text.trim()) return { matchedLoras: [] };
    const data = await api.matchLoras(text, { autoTurbo });
    return { matchedLoras: data?.matched_loras || [] };
}

// ── Chip mutations (upstream renderMatchedLorasList event handlers, now pure) ──────────────

/** Toggle chip checkbox -> `matchedLoras[idx].active`. */
export function setLoraActive(loras, index, active) {
    if (loras?.[index]) loras[index].active = active;
    return loras;
}

/** Weight input -> `matchedLoras[idx][field]`; NaN is ignored (upstream `!isNaN(val)` guard). */
export function setLoraWeight(loras, index, field, value) {
    const num = parseFloat(value);
    if (loras?.[index] && !Number.isNaN(num)) loras[index][field] = num;
    return loras;
}

/** Delete button -> `splice(idx, 1)`; later indices shift, exactly like upstream. */
export function removeLora(loras, index) {
    if (loras && index >= 0 && index < loras.length) loras.splice(index, 1);
    return loras;
}
