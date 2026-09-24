/**
 * core/pipeline.js — the generation orchestrator.
 *
 * Port of generate-tab.js `_coreGenerate` (L1485-1647) plus the orchestration parts of
 * `handleGenerate` (L2068-2109), minus DOM:
 *  - seed mode/value came from `#wfm-gen-seed-mode` / `#wfm-gen-seed-value` -> parameters
 *    (a caller-forced `seedValue` still forces `seedMode = "fixed"`, as upstream);
 *  - the progress bar / text writes -> `onProgress(pct, msg)` with pct in 0..1;
 *  - the result preview, thumbnail strip and Eagle auto-save -> the caller's job (they need DOM,
 *    `../settings-tab.js` and `../util.js`, none of which core may touch);
 *  - the `generationComplete` toast -> the resolved promise;
 *  - `storyLoraState` -> `storyLoras` / `autoInjectLoras` parameters.
 *
 * Frozen contract (brief §2.2 rule 5): `{images, seed, svgOutputs, workflow}` where `workflow` is
 * the workflow that was actually executed (post prompt-override / LoRA / style / wildcard, and
 * post seed, because `comfyUI.generate()` stamps the seed into the object it receives).
 * `images` is the raw history list, i.e. `type === "temp"` previews are still in it - upstream
 * filtered them only for display and passed all of them to the metadata writer. Filter with
 * `img.type !== "temp"` for saved artifacts.
 *
 * Requires from sibling core modules only (client / workflow / style / wildcard / lora / image).
 */

import { comfyUI } from "./client.js";
import { comfyWorkflow } from "./workflow.js";
import { applyStyleToWorkflow, resolveStyleByName } from "./style.js";
import { expandWildcardsInWorkflow } from "./wildcard.js";
import { activeLoras, applyLoras } from "./lora.js";
import { saveGeneratedImagesMeta } from "./image.js";

/** Video workflows run far longer than a still image (upstream: 30 min instead of the client's 10). */
const VIDEO_TIMEOUT_MS = 30 * 60 * 1000;

/** An `Error` whose `name` is `"AbortError"`, without depending on a DOMException global. */
export function abortError(message = "Generation aborted") {
    const err = new Error(message);
    err.name = "AbortError";
    return err;
}

/** Reject the current step when the caller already aborted. */
export function throwIfAborted(signal) {
    if (signal?.aborted) throw abortError();
}

/**
 * Write the caller's prompt / negative into the analysed prompt nodes.
 * Upstream got this from `comfyEditor.syncToWorkflow()`, which pushed the GenerateUI fields into
 * `comfyUI.currentWorkflow` before `_coreGenerate` ran; here it is an explicit parameter.
 *
 * @param {object} workflow API-format workflow (mutated: pass the pipeline's own copy)
 * @param {{prompt_nodes?:Array<{id:string, role:string, textKey?:string}>}|null} analysis
 * @param {{prompt?:string|null, negative?:string|null}} [values] null / undefined = leave as-is
 * @returns {object} the same workflow
 */
export function applyPromptOverride(workflow, analysis, { prompt = null, negative = null } = {}) {
    for (const node of analysis?.prompt_nodes || []) {
        const value = node.role === "positive" ? prompt : node.role === "negative" ? negative : null;
        if (typeof value !== "string") continue;
        const nodeData = workflow?.[node.id];
        if (nodeData?.inputs) nodeData.inputs[node.textKey || "text"] = value;
    }
    return workflow;
}

/**
 * Resolve the seed options the same way upstream did.
 * @param {'random'|'fixed'|undefined} seedMode
 * @param {number|null|undefined} seedValue
 * @returns {{seedMode:'random'|'fixed', seedValue:number}}
 */
export function resolveSeedOptions(seedMode, seedValue) {
    const forced = seedValue !== undefined && seedValue !== null;
    return {
        seedMode: forced ? "fixed" : (seedMode || "random"),
        // upstream: `parseInt(<empty field>) || -1` -> -1 means "let comfyUI generate one"
        seedValue: forced ? seedValue : -1,
    };
}

/**
 * Run one generation.
 *
 * @param {{workflow?:object, prompt?:string, negative?:string,
 *          seedMode?:'random'|'fixed', seedValue?:number,
 *          styleName?:string, storyLoras?:Array, autoInjectLoras?:boolean,
 *          onProgress?:(pct:number,msg:string)=>void,
 *          signal?:AbortSignal}} opts
 * @returns {Promise<{images:Array, seed:number, svgOutputs:Array, workflow:object}>}
 */
export async function runGeneration(opts = {}) {
    const {
        workflow: workflowOption = null,
        prompt = null,
        negative = null,
        seedMode: requestedSeedMode,
        seedValue: requestedSeedValue = null,
        styleName = "",
        storyLoras = null,
        autoInjectLoras = true,
        onProgress = null,
        signal = null,
    } = opts;

    throwIfAborted(signal);

    const baseWorkflow = workflowOption || comfyUI.currentWorkflow;
    if (!baseWorkflow) throw new Error("runGeneration: no workflow loaded");
    if (comfyUI.generating) throw new Error("runGeneration: a generation is already running");

    const { seedMode, seedValue } = resolveSeedOptions(requestedSeedMode, requestedSeedValue);
    onProgress?.(0, "Starting...");

    // Upstream copied with `{ ...baseWorkflow }`; because the style / wildcard steps replaced the
    // object wholesale, the fact that `comfyUI.generate()` writes the seed into the nodes it is
    // handed never showed. The frozen contract returns the executed workflow, so the pipeline
    // works on a deep copy it fully owns and the caller's object stays untouched.
    let targetWorkflow = JSON.parse(JSON.stringify(baseWorkflow));
    applyPromptOverride(targetWorkflow, comfyUI.currentAnalysis, { prompt, negative });

    // Abort must interrupt the running prompt server-side (upstream: the interrupt button did
    // `_ckptBatch.aborted = true` + `comfyUI.interrupt()`). Registering it before the prep steps
    // also covers an abort during style resolution / wildcard fetches.
    const onAbort = () => {
        comfyUI.interrupt().catch(() => {});
    };
    if (signal) signal.addEventListener("abort", onAbort, { once: true });

    try {
        // 1) story-LoRA auto-inject. Matched-but-deactivated chips are filtered out; a failure
        //    only warns, exactly like upstream (`console.warn`, then continue).
        if (autoInjectLoras && activeLoras(storyLoras).length > 0) {
            throwIfAborted(signal);
            try {
                const applied = await applyLoras(targetWorkflow, storyLoras);
                if (applied.workflow) targetWorkflow = applied.workflow;
            } catch (err) {
                console.warn("Auto-inject LoRAs failed:", err);
            }
        }

        // 2) style BEFORE wildcards: a `__name__` written inside a style prompt must expand too.
        throwIfAborted(signal);
        const style = styleName ? await resolveStyleByName(styleName) : null;
        const styledWorkflow = applyStyleToWorkflow(targetWorkflow, {
            style,
            analysis: comfyUI.currentAnalysis,
        });

        // 3) wildcards
        const workflowForGenerate = await expandWildcardsInWorkflow(styledWorkflow);

        // 4) queue + track
        throwIfAborted(signal);
        const isVideo = comfyWorkflow.isVideoWorkflow(comfyUI.currentAnalysis);
        const { images = [], seed, svgOutputs } = await comfyUI.generate(workflowForGenerate, {
            seedMode,
            seedValue,
            timeoutMs: isVideo ? VIDEO_TIMEOUT_MS : undefined,
            onProgress: (pct) => onProgress?.(pct, `${(pct * 100).toFixed(0)}%`),
        });

        throwIfAborted(signal);
        onProgress?.(1, `Done (${images.length} image${images.length !== 1 ? "s" : ""})`);

        // 5) gallery metadata for the SAVED images, keyed to the BASE workflow (upstream did the
        //    same). Best effort: a failure must not fail the generation.
        try {
            await saveGeneratedImagesMeta(images, { ...baseWorkflow });
        } catch { /* metadata is best effort */ }

        return { images, seed, svgOutputs: svgOutputs || [], workflow: workflowForGenerate };
    } catch (err) {
        // The interrupt above surfaces as "Execution interrupted"; the signal contract wants an
        // AbortError so callers can distinguish a user abort from a real failure.
        if (signal?.aborted && err?.name !== "AbortError") throw abortError(err?.message);
        throw err;
    } finally {
        signal?.removeEventListener("abort", onAbort);
    }
}
