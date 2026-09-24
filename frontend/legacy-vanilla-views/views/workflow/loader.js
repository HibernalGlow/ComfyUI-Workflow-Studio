/**
 * views/workflow/loader.js — the single "load a workflow file into the editor state" step,
 * shared by views/workflow.js and views/generate.js.
 *
 * Port of the core half of generate-tab.js `loadWorkflowIntoEditor` (L223-329), with every DOM
 * write replaced by a return value:
 *   1. `api.loadWorkflow(filename)`                      (was `fetch("/api/wfm/workflows/raw")`)
 *   2. `comfyWorkflow.detectFormat` + `convertUiToApi`   (parity item 2: reused, never re-implemented)
 *   3. `applyDefaultCheckpointIfEnabled` BEFORE analyse  (upstream comment: analysing first leaves
 *      the Models tab showing the old checkpoint)
 *   4. `comfyUI.currentWorkflow` / `currentAnalysis`     — the state the pipeline reads
 *
 * The App-format / unknown-format early returns became thrown Errors so both views can render the
 * same message in their own surface.
 */

import { comfyUI, comfyWorkflow, image, t } from "../../core/index.js";
import { api } from "../../core/index.js";

/** Upstream `t()` returns the key itself when the dictionary lacks it. */
function tr(key, fallback, ...args) {
    const value = t(key, ...args);
    return value !== undefined && value !== null && value !== key ? String(value) : fallback;
}

/** Non-fatal notes the caller may surface (checkpoint substitution, default-checkpoint override). */
export function loadWarnings(filename, { substitutions = [], checkpoint = null } = {}) {
    const warnings = [];
    if (substitutions.length > 0) {
        const names = [...new Set(substitutions.map((entry) => entry.original))].join(", ");
        warnings.push(tr("checkpointSubstitutedWarning", `Checkpoint substituted: ${names}`, names));
    }
    if (checkpoint) {
        warnings.push(tr("defaultCheckpointApplied", `Default checkpoint applied: ${checkpoint}`, checkpoint));
    }
    return warnings;
}

/**
 * Load one workflow file and publish it as the active workflow.
 *
 * @param {string} filename workflow file name as returned by `api.listWorkflows()`
 * @returns {Promise<{filename:string, format:'api'|'ui', workflow:object, analysis:object,
 *                    warnings:string[]}>}
 * @throws {Error} App format (unsupported), unknown format, or transport failure
 */
export async function loadWorkflowIntoEditor(filename) {
    const raw = await api.loadWorkflow(filename);
    const format = comfyWorkflow.detectFormat(raw, filename);

    if (format === "app") throw new Error(tr("appFormatNotSupported", "App-format workflows are not supported"));
    if (format === "unknown") throw new Error(tr("unknownWorkflowFormat", "Unrecognised workflow format"));

    let workflow = raw;
    let substitutions = [];
    if (format === "ui") {
        workflow = await comfyWorkflow.convertUiToApi(raw);
        substitutions = comfyWorkflow.getLastCheckpointSubstitutions();
    }

    const checkpoint = await image.applyDefaultCheckpointIfEnabled(workflow);
    comfyUI.currentWorkflow = workflow;
    comfyUI.currentAnalysis = comfyWorkflow.analyzeWorkflow(workflow);

    return {
        filename,
        format,
        workflow,
        analysis: comfyUI.currentAnalysis,
        warnings: loadWarnings(filename, { substitutions, checkpoint }),
    };
}

/**
 * Adopt an already parsed API-format workflow (no request); used when the Workflow view hands a
 * freshly edited workflow over to the Generate view through the store.
 * @param {string} filename
 * @param {object} workflow API-format workflow, adopted as-is
 * @returns {{filename:string, format:'api', workflow:object, analysis:object, warnings:string[]}}
 */
export function adoptWorkflow(filename, workflow) {
    comfyUI.currentWorkflow = workflow;
    comfyUI.currentAnalysis = comfyWorkflow.analyzeWorkflow(workflow);
    return { filename, format: "api", workflow, analysis: comfyUI.currentAnalysis, warnings: [] };
}

/** Upstream's `#wfm-gen-model-badge`: which model family the loaded graph drives. */
export function modelBadge(analysis) {
    const diffusion = analysis?.diffusion_model_nodes?.[0];
    const checkpoint = analysis?.checkpoint_nodes?.[0];
    if (diffusion?.unet_name) return `UNet: ${diffusion.unet_name}`;
    if (checkpoint?.ckpt_name) return `CKPT: ${checkpoint.ckpt_name}`;
    return "";
}
