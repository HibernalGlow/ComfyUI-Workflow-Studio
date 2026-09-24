/**
 * core/workflow.js — workflow JSON + UI/API format conversion (facade)
 *
 * Re-exports upstream `comfyWorkflow` unchanged (0 DOM touches, 1704 lines).
 * This is the single source of truth for the UI<->API graph format, the node
 * catalog, and workflow file listing/loading.
 */
export { comfyWorkflow } from "../comfyui-workflow.js";
